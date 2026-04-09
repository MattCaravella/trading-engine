/**
 * Tests for signals.js — Signal aggregation tests
 *
 * Tests aggregateByTicker() function with known weights.
 * Mocks strategy_calibrator.getLiveWeights() and all monitor/strategy modules.
 */

// Mock all monitor and strategy modules that signals.js imports at top level
jest.mock('../monitors/congress', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../monitors/offexchange', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../monitors/govcontracts', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../monitors/lobbying', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../monitors/flights', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../monitors/trending', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../strategies/bollinger', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../strategies/ma_crossover', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../strategies/pairs_trading', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../strategies/insider_buying', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));
jest.mock('../strategies/downtrend', () => ({ getSignals: jest.fn().mockResolvedValue([]) }));

// Mock strategy_calibrator with known constant weights
jest.mock('../strategy_calibrator', () => ({
  getLiveWeights: jest.fn(() => ({
    bollinger: 1.0,
    ma_crossover: 1.0,
    relative_value: 1.0,
    downtrend: 1.0,
    insider_buying: 1.0,
    techsector: 1.0,
    congress: 1.0,
    govcontracts: 1.0,
    lobbying: 1.0,
    flights: 1.0,
    trending: 1.0,
    offexchange: 1.0,
  })),
}));

const { aggregateByTicker, BUY_THRESHOLD, PRIMARY_SOURCES, OVERLAY_SOURCES } = require('../signals');

// ─── aggregateByTicker() ────────────────────────────────────────────────────

describe('aggregateByTicker()', () => {
  test('groups signals by ticker', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 60, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'ma_crossover', score: 50, direction: 'bullish', reason: 'Test' },
      { ticker: 'MSFT', source: 'bollinger', score: 70, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    expect(result).toHaveLength(2);
    const aaplEntry = result.find(r => r.ticker === 'AAPL');
    const msftEntry = result.find(r => r.ticker === 'MSFT');
    expect(aaplEntry).toBeTruthy();
    expect(msftEntry).toBeTruthy();
    expect(aaplEntry.signalCount).toBe(2);
    expect(msftEntry.signalCount).toBe(1);
  });

  test('primary sources contribute to primaryScore', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 60, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'ma_crossover', score: 40, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    // Both are primary sources with weight=1.0
    expect(aapl.primaryScore).toBe(100);
    expect(aapl.hasPrimary).toBe(true);
  });

  test('overlay sources capped at OVERLAY_CAP (25)', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 50, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'congress', score: 40, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'lobbying', score: 30, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    // Primary: 50, Overlay: min(25, 40+30=70) = 25
    // bullishScore = 50 + 25 = 75
    expect(aapl.primaryScore).toBe(50);
    expect(aapl.bullishScore).toBe(75);
  });

  test('overlay-only signals penalized to 10%', () => {
    const signals = [
      { ticker: 'AAPL', source: 'congress', score: 80, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'lobbying', score: 60, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    // No primary source, so effectiveOverlay = min(25*0.1, (80+60)*0.1) = min(2.5, 14) = 2.5
    expect(aapl.hasPrimary).toBe(false);
    expect(aapl.bullishScore).toBe(2.5);
    expect(aapl.netScore).toBe(3); // rounded from 2.5, clamped 0-100
  });

  test('netScore capped at 0-100', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 80, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'ma_crossover', score: 70, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'congress', score: 50, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    // primaryScore = 150, overlay = min(25, 50) = 25, total = 175 → capped at 100
    expect(aapl.netScore).toBeLessThanOrEqual(100);
    expect(aapl.netScore).toBeGreaterThanOrEqual(0);
  });

  test('bearish signals reduce netScore', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 60, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'downtrend', score: 30, direction: 'bearish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    // bullish: 60, bearish: 30, net = 60 - 30 = 30
    expect(aapl.netScore).toBe(30);
  });

  test('netScore cannot go below 0', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 20, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'downtrend', score: 80, direction: 'bearish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    expect(aapl.netScore).toBe(0);
  });

  test('results sorted by netScore descending', () => {
    const signals = [
      { ticker: 'LOW_SCORE', source: 'bollinger', score: 20, direction: 'bullish', reason: 'Test' },
      { ticker: 'HIGH_SCORE', source: 'bollinger', score: 80, direction: 'bullish', reason: 'Test' },
      { ticker: 'MID_SCORE', source: 'bollinger', score: 50, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    expect(result[0].ticker).toBe('HIGH_SCORE');
    expect(result[1].ticker).toBe('MID_SCORE');
    expect(result[2].ticker).toBe('LOW_SCORE');
  });

  test('confirmedByTech flag set correctly', () => {
    const signalsWithPrimary = [
      { ticker: 'AAPL', source: 'bollinger', score: 60, direction: 'bullish', reason: 'Test' },
    ];
    const signalsOverlayOnly = [
      { ticker: 'MSFT', source: 'congress', score: 60, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker([...signalsWithPrimary, ...signalsOverlayOnly]);
    const aapl = result.find(r => r.ticker === 'AAPL');
    const msft = result.find(r => r.ticker === 'MSFT');
    expect(aapl.confirmedByTech).toBe(true);
    expect(msft.confirmedByTech).toBe(false);
  });

  test('sources array contains unique source names', () => {
    const signals = [
      { ticker: 'AAPL', source: 'bollinger', score: 60, direction: 'bullish', reason: 'Test' },
      { ticker: 'AAPL', source: 'congress', score: 40, direction: 'bullish', reason: 'Test' },
    ];
    const result = aggregateByTicker(signals);
    const aapl = result.find(r => r.ticker === 'AAPL');
    expect(aapl.sources).toEqual(expect.arrayContaining(['bollinger', 'congress']));
    expect(aapl.sources).toHaveLength(2);
  });

  test('empty signals array returns empty result', () => {
    const result = aggregateByTicker([]);
    expect(result).toEqual([]);
  });
});

// ─── Constants ──────────────────────────────────────────────────────────────

describe('Signal constants', () => {
  test('BUY_THRESHOLD is 70', () => {
    expect(BUY_THRESHOLD).toBe(70);
  });

  test('PRIMARY_SOURCES contains expected strategies', () => {
    expect(PRIMARY_SOURCES.has('bollinger')).toBe(true);
    expect(PRIMARY_SOURCES.has('ma_crossover')).toBe(true);
    expect(PRIMARY_SOURCES.has('relative_value')).toBe(true);
    expect(PRIMARY_SOURCES.has('downtrend')).toBe(true);
    expect(PRIMARY_SOURCES.has('insider_buying')).toBe(true);
    expect(PRIMARY_SOURCES.has('techsector')).toBe(true);
  });

  test('OVERLAY_SOURCES contains expected sources', () => {
    expect(OVERLAY_SOURCES.has('congress')).toBe(true);
    expect(OVERLAY_SOURCES.has('govcontracts')).toBe(true);
    expect(OVERLAY_SOURCES.has('lobbying')).toBe(true);
    expect(OVERLAY_SOURCES.has('flights')).toBe(true);
    expect(OVERLAY_SOURCES.has('trending')).toBe(true);
    expect(OVERLAY_SOURCES.has('offexchange')).toBe(true);
  });

  test('PRIMARY and OVERLAY sources do not overlap', () => {
    for (const src of PRIMARY_SOURCES) {
      expect(OVERLAY_SOURCES.has(src)).toBe(false);
    }
  });
});
