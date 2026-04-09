/**
 * Tests for data/prices.js — Technical indicator unit tests
 *
 * Tests pure math functions only (sma, stddev, rsi, bollingerBands,
 * correlation, returns, closes, volumes). No network calls.
 */

// Mock the .env file read that happens at module load
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, ...args) => {
      if (typeof filePath === 'string' && filePath.includes('.env')) {
        return 'ALPACA_API_KEY=test\nALPACA_SECRET_KEY=test\n';
      }
      return actual.readFileSync(filePath, ...args);
    }),
  };
});

const { sma, stddev, rsi, bollingerBands, correlation, returns, closes, volumes } = require('../data/prices');

// ─── Test Data ──────────────────────────────────────────────────────────────

const mockBars = Array.from({ length: 60 }, (_, i) => ({
  t: `2025-01-${String(i + 1).padStart(2, '0')}`,
  o: 100 + i * 0.5,
  h: 102 + i * 0.5,
  l: 99 + i * 0.5,
  c: 101 + i * 0.5,
  v: 1000000 + i * 10000,
}));

// ─── sma() ──────────────────────────────────────────────────────────────────

describe('sma()', () => {
  test('returns null when array too short', () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
  });

  test('correctly calculates 5-period SMA', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(sma(arr, 5)).toBe(30);
  });

  test('correctly calculates 20-period SMA', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i + 1);
    // SMA of 1..20 = (1+2+...+20)/20 = 210/20 = 10.5
    expect(sma(arr, 20)).toBe(10.5);
  });

  test('handles single element (period=1)', () => {
    expect(sma([42], 1)).toBe(42);
  });

  test('uses last N elements when array longer than period', () => {
    const arr = [100, 200, 10, 20, 30];
    // last 3: [10, 20, 30] → avg = 20
    expect(sma(arr, 3)).toBe(20);
  });
});

// ─── stddev() ───────────────────────────────────────────────────────────────

describe('stddev()', () => {
  test('returns null when array too short', () => {
    expect(stddev([1, 2], 5)).toBeNull();
  });

  test('correctly calculates standard deviation', () => {
    const arr = [2, 4, 4, 4, 5, 5, 7, 9];
    const result = stddev(arr, 8);
    // population stddev of [2,4,4,4,5,5,7,9]: mean=5, variance=4, stddev=2
    expect(result).toBeCloseTo(2, 5);
  });

  test('returns 0 for constant values', () => {
    const arr = [5, 5, 5, 5, 5];
    expect(stddev(arr, 5)).toBe(0);
  });
});

// ─── rsi() ──────────────────────────────────────────────────────────────────

describe('rsi()', () => {
  test('returns null when insufficient data', () => {
    const arr = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(rsi(arr, 14)).toBeNull();
  });

  test('returns close to 100 when no losses (all gains)', () => {
    // 15 consecutive up days
    const arr = Array.from({ length: 15 }, (_, i) => 100 + i);
    const result = rsi(arr, 14);
    expect(result).toBeGreaterThan(99);
  });

  test('returns close to 0 when no gains (all losses)', () => {
    // 15 consecutive down days
    const arr = Array.from({ length: 15 }, (_, i) => 200 - i);
    const result = rsi(arr, 14);
    expect(result).toBeLessThan(1);
  });

  test('correctly calculates RSI for known data', () => {
    // Mixed gains and losses
    const arr = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84,
                 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const result = rsi(arr, 14);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(100);
  });

  test('returns values between 0 and 100', () => {
    const arr = [100, 102, 99, 103, 97, 105, 98, 101, 100, 104, 96, 103, 99, 101, 100];
    const result = rsi(arr, 14);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });
});

// ─── bollingerBands() ───────────────────────────────────────────────────────

describe('bollingerBands()', () => {
  test('returns null when insufficient data', () => {
    const arr = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(bollingerBands(arr, 20)).toBeNull();
  });

  test('upper band > mid > lower band', () => {
    const arr = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 5);
    const bb = bollingerBands(arr, 20, 2);
    expect(bb).not.toBeNull();
    expect(bb.upper).toBeGreaterThan(bb.mid);
    expect(bb.mid).toBeGreaterThan(bb.lower);
  });

  test('mid equals SMA', () => {
    const arr = Array.from({ length: 20 }, (_, i) => 100 + i);
    const bb = bollingerBands(arr, 20, 2);
    const expectedSma = sma(arr, 20);
    expect(bb.mid).toBe(expectedSma);
  });

  test('width scales with multiplier', () => {
    const arr = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 5);
    const bb1 = bollingerBands(arr, 20, 1);
    const bb2 = bollingerBands(arr, 20, 2);
    const width1 = bb1.upper - bb1.lower;
    const width2 = bb2.upper - bb2.lower;
    expect(width2).toBeCloseTo(width1 * 2, 5);
  });

  test('bands collapse for constant values', () => {
    const arr = Array.from({ length: 20 }, () => 50);
    const bb = bollingerBands(arr, 20, 2);
    expect(bb.upper).toBe(50);
    expect(bb.mid).toBe(50);
    expect(bb.lower).toBe(50);
    expect(bb.std).toBe(0);
  });
});

// ─── correlation() ──────────────────────────────────────────────────────────

describe('correlation()', () => {
  test('returns 1 for perfectly correlated data', () => {
    const a = Array.from({ length: 20 }, (_, i) => i * 2);
    const b = Array.from({ length: 20 }, (_, i) => i * 3 + 5);
    expect(correlation(a, b)).toBeCloseTo(1, 5);
  });

  test('returns -1 for perfectly negatively correlated', () => {
    const a = Array.from({ length: 20 }, (_, i) => i);
    const b = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(correlation(a, b)).toBeCloseTo(-1, 5);
  });

  test('returns ~0 for uncorrelated data', () => {
    // Alternating pattern vs linear — should be close to 0
    const a = Array.from({ length: 20 }, (_, i) => Math.sin(i * 2.7));
    const b = Array.from({ length: 20 }, (_, i) => Math.cos(i * 1.3 + 5));
    const result = correlation(a, b);
    expect(Math.abs(result)).toBeLessThan(0.5);
  });

  test('returns 0 for insufficient data (<10 points)', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];
    expect(correlation(a, b)).toBe(0);
  });

  test('handles identical arrays', () => {
    const a = Array.from({ length: 15 }, (_, i) => i * 5 + 10);
    expect(correlation(a, a)).toBeCloseTo(1, 5);
  });
});

// ─── returns() ──────────────────────────────────────────────────────────────

describe('returns()', () => {
  test('calculates daily returns correctly', () => {
    const cls = [100, 110, 105];
    const r = returns(cls);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.10, 5);  // (110-100)/100
    expect(r[1]).toBeCloseTo(-0.04545, 3);  // (105-110)/110
  });

  test('handles zero prices gracefully', () => {
    // Division by zero produces Infinity — verify no crash
    const cls = [0, 100, 200];
    const r = returns(cls);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(Infinity);
    expect(r[1]).toBeCloseTo(1.0, 5);
  });

  test('returns array length = input length - 1', () => {
    const cls = [100, 101, 102, 103, 104];
    const r = returns(cls);
    expect(r).toHaveLength(4);
  });
});

// ─── closes() and volumes() ────────────────────────────────────────────────

describe('closes() and volumes()', () => {
  test('extracts close prices from bars', () => {
    const result = closes(mockBars.slice(0, 3));
    expect(result).toEqual([101, 101.5, 102]);
  });

  test('extracts volumes from bars', () => {
    const result = volumes(mockBars.slice(0, 3));
    expect(result).toEqual([1000000, 1010000, 1020000]);
  });

  test('handles empty array', () => {
    expect(closes([])).toEqual([]);
    expect(volumes([])).toEqual([]);
  });
});
