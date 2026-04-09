/**
 * seed_history.js
 * ============================================================
 * One-time historical data seeder for the trading engine.
 *
 * What it does:
 *   1. Pulls up to 5 years of free daily OHLCV bars from Alpaca
 *      for every ticker in your universe (falls back to Yahoo
 *      Finance for any ticker Alpaca doesn't carry).
 *   2. Replays all 6 technical strategies day-by-day against
 *      that historical data, exactly as the live engine would.
 *   3. Simulates trade outcomes using your live exit rules:
 *      +7% profit target, -6% hard stop, 4% trailing stop.
 *   4. Writes properly-formatted records into:
 *        trade_history/performance_ledger.json
 *        trade_history/performance_summary.json
 *        trade_history/calibration.json
 *      so the Strategy Calibrator and Postmortem Analyzer
 *      start with real calibration data instead of zero.
 *
 * Usage:
 *   node seed_history.js [--years=3] [--universe=full|top50] [--dry-run]
 *
 * Flags:
 *   --years=N        How many years of history to replay (default: 3)
 *   --universe=top50 Only seed the top 50 most liquid tickers (faster)
 *   --dry-run        Simulate without writing any files
 *   --resume         Skip tickers already present in ledger
 *
 * Safe to re-run: existing ledger records are preserved; duplicates
 * are detected by (symbol + entryDate) composite key.
 *
 * Run time estimate:
 *   full universe (380 tickers), 3 years: ~15-25 minutes
 *   top50 universe,               3 years: ~2-4 minutes
 * ============================================================
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── CLI flags ────────────────────────────────────────────────
const args       = process.argv.slice(2);
const YEARS      = parseInt((args.find(a => a.startsWith('--years='))  || '--years=3').split('=')[1]);
const DRY_RUN    = args.includes('--dry-run');
const RESUME     = args.includes('--resume');
const SMALL_UNI  = args.find(a => a.startsWith('--universe='))?.split('=')[1] === 'top50';

// ── Config (matches live engine EXIT_PROFILES) ──────────────
const EXIT_PROFILES = {
  mean_reversion: { hardStop: 0.10, trail: 0.08, profitTarget: null  },
  trend:          { hardStop: 0.08, trail: 0.06, profitTarget: null  },
  relative_value: { hardStop: 0.06, trail: 0.05, profitTarget: 0.10 },
  default:        { hardStop: 0.08, trail: 0.06, profitTarget: 0.12 },
};
const SOURCE_TO_PROFILE = {
  downtrend: 'mean_reversion', bollinger: 'mean_reversion',
  ma_crossover: 'trend', relative_value: 'relative_value',
};
function getExitProfile(source) {
  return EXIT_PROFILES[SOURCE_TO_PROFILE[source] || 'default'];
}
const MAX_HOLD_DAYS   = 30;     // bail after 30 trading days (wider for mean reversion)
const POSITION_PCT    = 0.08;   // 8% of equity per trade
const STARTING_EQUITY = 100_000;

// Strategy signal thresholds (mirrors your live strategy files)
const RSI_OVERSOLD       = 35;
const BB_PERIOD          = 20;
const BB_MULT            = 2;
const MA_SHORT           = 50;
const MA_LONG            = 200;
const MA_VOL_MULT        = 1.5;
const DOWNTREND_DAYS     = 15;
const PAIRS_CORR_MIN     = 0.70;
const PAIRS_Z_MIN        = 2.0;
const VIX_THRESHOLD      = 20;
const MIN_SIGNAL_SCORE   = 65;

// ── Paths ─────────────────────────────────────────────────────
const TRADE_HISTORY_DIR  = path.join(__dirname, 'trade_history');
const LEDGER_PATH        = path.join(TRADE_HISTORY_DIR, 'performance_ledger.json');
const SUMMARY_PATH       = path.join(TRADE_HISTORY_DIR, 'performance_summary.json');
const CALIBRATION_PATH   = path.join(TRADE_HISTORY_DIR, 'calibration.json');

// ── Alpaca credentials (same env loading as rest of app — no dotenv needed) ─
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) { const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim(); if (k) process.env[k] = v; }
  });
}
const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_DATA   = 'https://data.alpaca.markets/v2';

// ── Universe ──────────────────────────────────────────────────
// Dynamically load from your universe.js, fall back to a built-in core list
let UNIVERSE;
try {
  UNIVERSE = require('./data/universe');
  if (!Array.isArray(UNIVERSE)) UNIVERSE = Object.values(UNIVERSE).flat();
} catch {
  UNIVERSE = [
    'AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','AMD','QCOM','CRM',
    'SNOW','PLTR','PANW','CRWD','NOW','JPM','BAC','GS','V','MA','PYPL',
    'UNH','LLY','JNJ','ABBV','MRK','PFE','HD','LOW','WMT','COST','MCD',
    'NKE','BA','CAT','GE','HON','RTX','LMT','XOM','CVX','COP','EOG',
    'NFLX','DIS','T','VZ','TMUS','SPY','QQQ','IWM','DIA','XLK','XLF'
  ];
}

// Pairs for the pairs-trading strategy (mirrors your pairs_trading.js)
const PAIRS = [
  ['MSFT','GOOGL'],['AMD','NVDA'],['META','SNAP'],['ORCL','CRM'],
  ['QCOM','AVGO'],['JPM','BAC'],['GS','MS'],['C','WFC'],
  ['XOM','CVX'],['COP','OXY'],['SLB','HAL'],['PFE','MRK'],
  ['JNJ','ABT'],['UNH','CVS'],['WMT','TGT'],['HD','LOW'],
  ['AMZN','COST'],['GM','F'],['TSLA','RIVN']
];

if (SMALL_UNI) {
  // Keep only the 50 most common tickers + all pair members
  const pairTickers = new Set(PAIRS.flat());
  UNIVERSE = [
    ...new Set([
      ...UNIVERSE.slice(0, 50),
      ...pairTickers
    ])
  ];
}

// ── Technical indicator helpers (mirrors your data/prices.js) ─

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function stddev(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const mid   = sma(closes, period);
  const std   = stddev(closes, period);
  return { upper: mid + mult * std, mid, lower: mid - mult * std, std };
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ax[i] - ma) * (bx[i] - mb);
    da  += (ax[i] - ma) ** 2;
    db  += (bx[i] - mb) ** 2;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

function dailyReturns(closes) {
  const ret = [];
  for (let i = 1; i < closes.length; i++) {
    ret.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return ret;
}

function adx(bars, period = 14) {
  if (bars.length < period * 2 + 1) return null;
  const recent = bars.slice(-(period * 2 + 1));
  let smoothPDM = 0, smoothNDM = 0, smoothTR = 0;
  for (let i = 1; i <= period; i++) {
    const high = recent[i].high, low = recent[i].low, prevClose = recent[i-1].close;
    const prevHigh = recent[i-1].high, prevLow = recent[i-1].low;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const pdm = (high - prevHigh > prevLow - low && high - prevHigh > 0) ? high - prevHigh : 0;
    const ndm = (prevLow - low > high - prevHigh && prevLow - low > 0) ? prevLow - low : 0;
    smoothTR += tr; smoothPDM += pdm; smoothNDM += ndm;
  }
  const dxValues = [];
  for (let i = period + 1; i < recent.length; i++) {
    const high = recent[i].high, low = recent[i].low, prevClose = recent[i-1].close;
    const prevHigh = recent[i-1].high, prevLow = recent[i-1].low;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const pdm = (high - prevHigh > prevLow - low && high - prevHigh > 0) ? high - prevHigh : 0;
    const ndm = (prevLow - low > high - prevHigh && prevLow - low > 0) ? prevLow - low : 0;
    smoothTR  = smoothTR  - (smoothTR  / period) + tr;
    smoothPDM = smoothPDM - (smoothPDM / period) + pdm;
    smoothNDM = smoothNDM - (smoothNDM / period) + ndm;
    const pdi = (smoothPDM / smoothTR) * 100;
    const ndi = (smoothNDM / smoothTR) * 100;
    const dx  = Math.abs(pdi - ndi) / (pdi + ndi || 1) * 100;
    dxValues.push(dx);
  }
  if (dxValues.length < period) return null;
  const adxSlice = dxValues.slice(-period);
  return adxSlice.reduce((a, b) => a + b, 0) / period;
}

const BOLLINGER_ADX_MAX  = 40;  // matches live bollinger.js
const DOWNTREND_ADX_MAX  = 30;  // matches live downtrend.js

// ── Data fetching ─────────────────────────────────────────────

async function fetchAlpacaBars(symbol, days) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const startStr = start.toISOString().split('T')[0];

  const url = `${ALPACA_DATA}/stocks/${encodeURIComponent(symbol)}/bars` +
    `?timeframe=1Day&start=${startStr}&limit=${days + 10}&feed=iex&adjustment=all`;

  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET
    }
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.bars || data.bars.length === 0) return null;

  return data.bars.map(b => ({
    date:   b.t.split('T')[0],
    open:   b.o,
    high:   b.h,
    low:    b.l,
    close:  b.c,
    volume: b.v
  }));
}

async function fetchYahooBars(symbol, days) {
  // Yahoo Finance fallback — no API key needed
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - days * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const quote      = result.indicators?.quote?.[0] || {};
    const adjClose   = result.indicators?.adjclose?.[0]?.adjclose || quote.close;

    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (!adjClose[i] || !quote.volume[i]) continue;
      bars.push({
        date:   new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        open:   quote.open[i],
        high:   quote.high[i],
        low:    quote.low[i],
        close:  adjClose[i],
        volume: quote.volume[i]
      });
    }
    return bars.length > 0 ? bars : null;
  } catch {
    return null;
  }
}

async function fetchBarsWithFallback(symbol, days) {
  let bars = null;
  if (ALPACA_KEY && ALPACA_SECRET) {
    bars = await fetchAlpacaBars(symbol, days);
  }
  if (!bars) {
    bars = await fetchYahooBars(symbol, days);
  }
  return bars;
}

// ── Strategy signal generators ────────────────────────────────
// Each takes a window of bars up to (and including) index `i`
// and returns { signal: bool, score: number, source: string }

function bollingerSignal(bars, i) {
  if (i < BB_PERIOD + 30) return null;
  const window  = bars.slice(0, i + 1);
  // ADX regime filter
  const adxVal = adx(window, 14);
  if (adxVal !== null && adxVal > BOLLINGER_ADX_MAX) return null;
  const closes  = window.map(b => b.close);
  const volumes = window.map(b => b.volume);
  const bb      = bollingerBands(closes, BB_PERIOD, BB_MULT);
  if (!bb) return null;

  const rsiVal  = rsi(closes, 14);
  if (rsiVal === null) return null;

  const bandWidth = (bb.upper - bb.lower) / bb.mid;
  const price     = closes[closes.length - 1];

  // VIX gating: We don't have historical VIX in this replay,
  // so we approximate: skip the gate during high-volatility periods
  // (the strategy will naturally fire less during calm markets anyway)
  if (price < bb.lower && rsiVal < RSI_OVERSOLD && bandWidth >= 0.05) {
    const distBelow = (bb.lower - price) / bb.lower;
    const score     = Math.min(85, distBelow * 800 + 20);
    return { signal: true, score, source: 'bollinger' };
  }
  return null;
}

function maCrossoverSignal(bars, i) {
  if (i < MA_LONG + 5) return null;
  const window  = bars.slice(0, i + 1);
  const closes  = window.map(b => b.close);
  const volumes = window.map(b => b.volume);

  const ma50  = sma(closes, MA_SHORT);
  const ma200 = sma(closes, MA_LONG);
  if (!ma50 || !ma200) return null;

  // Check if cross happened in last 5 days
  for (let daysAgo = 1; daysAgo <= 5; daysAgo++) {
    if (i - daysAgo < MA_LONG) break;
    const prev = closes.slice(0, closes.length - daysAgo);
    const prevMa50  = sma(prev, MA_SHORT);
    const prevMa200 = sma(prev, MA_LONG);
    if (!prevMa50 || !prevMa200) break;

    const crossedNow  = ma50  > ma200;
    const crossedPrev = prevMa50 > prevMa200;
    if (crossedNow && !crossedPrev) {
      // Golden cross found
      const price   = closes[closes.length - 1];
      if (price < ma200) return null;

      const vol20   = sma(volumes, 20);
      const volRatio = vol20 ? volumes[volumes.length - 1] / vol20 : 1;
      if (volRatio < MA_VOL_MULT) return null;

      const score = Math.min(80, 40 + (6 - daysAgo) * 5 + Math.min(20, (volRatio - 1) * 15));
      return { signal: true, score, source: 'ma_crossover' };
    }
  }
  return null;
}

function downtrendSignal(bars, i) {
  if (i < 30 + 14) return null;
  const window = bars.slice(0, i + 1);
  // ADX regime filter
  const adxVal = adx(window, 14);
  if (adxVal !== null && adxVal > DOWNTREND_ADX_MAX) return null;
  const closes = window.map(b => b.close);
  const ma20   = sma(closes, 20);
  if (!ma20) return null;

  // Count consecutive days below 20 SMA
  let downtrendCount = 0;
  for (let j = closes.length - 1; j >= 0; j--) {
    const sliceHere = closes.slice(0, j + 1);
    const mHere     = sma(sliceHere, 20);
    if (mHere && closes[j] < mHere) downtrendCount++;
    else break;
  }

  if (downtrendCount < DOWNTREND_DAYS) return null;

  const rsiVal = rsi(closes, 14);
  if (rsiVal === null || rsiVal > RSI_OVERSOLD) return null;

  // RSI divergence check
  let divergence = false;
  if (closes.length >= 20) {
    const recent = closes.slice(-20);
    let low1Idx = 0, low2Idx = 0;
    for (let j = 1; j < recent.length - 1; j++) {
      if (recent[j] < recent[low1Idx]) low1Idx = j;
    }
    for (let j = low1Idx + 1; j < recent.length; j++) {
      if (recent[j] < recent[low2Idx === 0 ? low1Idx : low2Idx]) low2Idx = j;
    }
    if (low2Idx > low1Idx && recent[low2Idx] < recent[low1Idx]) {
      const rsi1 = rsi(closes.slice(0, closes.length - (recent.length - 1 - low1Idx)), 14);
      const rsi2 = rsi(closes.slice(0, closes.length - (recent.length - 1 - low2Idx)), 14);
      if (rsi1 && rsi2 && rsi2 > rsi1) divergence = true;
    }
  }

  const score = Math.min(80, 20 + downtrendCount + (divergence ? 25 : 0));
  return { signal: true, score, source: 'downtrend' };
}

function pairsSignal(barsA, barsB, symbolB, i) {
  const lookback = 70;
  if (i < lookback) return null;

  const closesA = barsA.slice(Math.max(0, i - lookback), i + 1).map(b => b.close);
  const closesB = barsB.slice(Math.max(0, i - lookback), i + 1).map(b => b.close);
  const n       = Math.min(closesA.length, closesB.length);
  if (n < 30) return null;

  const retA = dailyReturns(closesA.slice(-n));
  const retB = dailyReturns(closesB.slice(-n));
  const corr = correlation(retA, retB);
  if (corr < PAIRS_CORR_MIN) return null;

  // Log-price spread z-score
  const spread = closesA.slice(-n).map((a, k) => Math.log(a) - Math.log(closesB[closesB.length - n + k]));
  const meanSpread = spread.reduce((s, v) => s + v, 0) / n;
  const stdSpread  = Math.sqrt(spread.reduce((s, v) => s + (v - meanSpread) ** 2, 0) / n);
  if (stdSpread === 0) return null;

  const zScore = (spread[spread.length - 1] - meanSpread) / stdSpread;

  // z > 2: B is undervalued vs A → buy B
  if (Math.abs(zScore) >= PAIRS_Z_MIN) {
    const score = Math.min(75, Math.abs(zScore) * 20);
    return { signal: true, score, source: 'relative_value', buyB: zScore > 0 };
  }
  return null;
}

// ── Trade outcome simulator ───────────────────────────────────

function simulateTrade(bars, entryIdx, entryPrice, source) {
  const profile = getExitProfile(source);
  let highWaterMark = entryPrice;
  let exitPrice     = null;
  let exitReason    = 'time_stop';
  let exitIdx       = entryIdx;

  const maxIdx = Math.min(entryIdx + MAX_HOLD_DAYS, bars.length - 1);

  for (let j = entryIdx + 1; j <= maxIdx; j++) {
    const bar = bars[j];
    const high = bar.high;
    const low  = bar.low;
    const close = bar.close;

    // Update high water mark
    if (high > highWaterMark) highWaterMark = high;

    // Check profit target (only if profile has one — mean reversion + trend use trail)
    if (profile.profitTarget && close >= entryPrice * (1 + profile.profitTarget)) {
      exitPrice  = entryPrice * (1 + profile.profitTarget);
      exitReason = 'profit_target';
      exitIdx    = j;
      break;
    }

    // Check trailing stop (strategy-specific % from high water mark)
    const trailStop = highWaterMark * (1 - profile.trail);
    if (low <= trailStop && highWaterMark > entryPrice * 1.01) {
      exitPrice  = trailStop;
      exitReason = 'trailing_stop';
      exitIdx    = j;
      break;
    }

    // Check hard stop (strategy-specific)
    if (low <= entryPrice * (1 - profile.hardStop)) {
      exitPrice  = entryPrice * (1 - profile.hardStop);
      exitReason = 'hard_stop';
      exitIdx    = j;
      break;
    }

    // End of hold period
    if (j === maxIdx) {
      exitPrice  = close;
      exitReason = 'time_stop';
      exitIdx    = j;
    }
  }

  if (!exitPrice) exitPrice = bars[maxIdx].close;

  const pnlPct    = (exitPrice - entryPrice) / entryPrice;
  const qty       = Math.floor((STARTING_EQUITY * POSITION_PCT) / entryPrice);
  const pnlDollar = qty * (exitPrice - entryPrice);
  const holdDays  = exitIdx - entryIdx;

  // Compute MFE and MAE
  let mfe = 0, mae = 0;
  for (let j = entryIdx + 1; j <= exitIdx; j++) {
    const hiPct = (bars[j].high  - entryPrice) / entryPrice;
    const loPct = (bars[j].low   - entryPrice) / entryPrice;
    if (hiPct > mfe) mfe = hiPct;
    if (loPct < mae) mae = loPct;
  }

  return {
    exitPrice, exitReason, pnlPct, pnlDollar,
    holdDays, qty, mfe, mae,
    entryDate: bars[entryIdx].date,
    exitDate:  bars[exitIdx].date
  };
}

// ── Postmortem record builder ─────────────────────────────────

function buildPostmortemRecord(symbol, source, outcome) {
  return {
    symbol,
    entryPrice:    parseFloat(outcome.entryPrice.toFixed(4)),
    exitPrice:     parseFloat(outcome.exitPrice.toFixed(4)),
    qty:           outcome.qty,
    pnlPct:        parseFloat((outcome.pnlPct * 100).toFixed(4)),
    pnlDollar:     parseFloat(outcome.pnlDollar.toFixed(2)),
    isWin:         outcome.pnlPct > 0,
    exitReason:    outcome.exitReason,
    holdingHours:  outcome.holdDays * 6.5,   // ~6.5 trading hours/day
    sources:       [source],
    buyReason:     `[SEEDED] ${source} signal`,
    entryTime:     `${outcome.entryDate}T09:30:00.000Z`,
    exitTime:      `${outcome.exitDate}T16:00:00.000Z`,
    mfe:           parseFloat((outcome.mfe * 100).toFixed(4)),
    mae:           parseFloat((outcome.mae * 100).toFixed(4)),
    orderId:       `seed_${symbol}_${outcome.entryDate}_${source}`.replace(/[^a-z0-9_]/gi, '_'),
    seeded:        true
  };
}

// ── Calibration builder ───────────────────────────────────────

function buildCalibration(records) {
  const BASE_WEIGHTS = {
    congress:        1.50,
    insider_buying:  1.40,
    offexchange:     1.30,
    news_sentiment:  1.20,
    ma_crossover:    1.20,
    downtrend:       1.10,
    bollinger:       1.10,
    govcontracts:    1.00,
    relative_value:  1.00,
    techsector:      0.90,
    lobbying:        0.80,
    flights:         0.70,
    trending:        0.60,
  };

  const bySource = {};
  for (const rec of records) {
    const src = rec.sources[0];
    if (!bySource[src]) bySource[src] = { wins: 0, losses: 0, totalPnl: 0, trades: [] };
    bySource[src].trades.push(rec);
    bySource[src].totalPnl += rec.pnlPct;
    if (rec.isWin) bySource[src].wins++;
    else           bySource[src].losses++;
  }

  const adjustedWeights = { ...BASE_WEIGHTS };
  const killed          = {};
  const sourceStats     = {};
  let   consecutiveLoss = {};

  for (const [src, data] of Object.entries(bySource)) {
    const total   = data.wins + data.losses;
    if (total < 5) continue;

    const winRate = data.wins / total;
    const avgPnl  = data.totalPnl / total;

    sourceStats[src] = { winRate: parseFloat(winRate.toFixed(4)), avgPnl: parseFloat(avgPnl.toFixed(4)), total };

    const wrFactor  = 0.4 + winRate * 1.2;
    const pnlFactor = Math.max(0.5, Math.min(1.5, 1 + avgPnl / 10));
    const multiplier = Math.max(0.3, Math.min(2.0, wrFactor * pnlFactor));
    adjustedWeights[src] = parseFloat(((BASE_WEIGHTS[src] || 1.0) * multiplier).toFixed(4));

    // Check kill condition: 5+ consecutive losses AND win rate < 30%
    const tradeArr     = data.trades;
    let consec         = 0;
    let maxConsec      = 0;
    for (const t of tradeArr) {
      if (!t.isWin) { consec++; maxConsec = Math.max(maxConsec, consec); }
      else consec = 0;
    }
    consecutiveLoss[src] = maxConsec;
    if (maxConsec >= 5 && winRate < 0.30) {
      killed[src] = true;
      console.log(`  ⚠️  Strategy killed: ${src} (win rate: ${(winRate*100).toFixed(1)}%, max consec losses: ${maxConsec})`);
    }
  }

  const today = new Date().toISOString().split('T')[0];
  return {
    lastUpdated:     today,
    adjustedWeights,
    killed,
    sourceStats,
    history: [{
      date:            today,
      tradeCount:      records.length,
      winRate:         records.filter(r => r.isWin).length / records.length,
      adjustedWeights,
      killed,
      seeded:          true
    }]
  };
}

// ── Performance summary builder ───────────────────────────────

function buildSummary(records) {
  if (records.length === 0) return {};

  const wins   = records.filter(r => r.isWin);
  const losses = records.filter(r => !r.isWin);

  const totalPnlDollar = records.reduce((s, r) => s + r.pnlDollar, 0);
  const avgPnlPct      = records.reduce((s, r) => s + r.pnlPct, 0) / records.length;
  const avgHoldHours   = records.reduce((s, r) => s + r.holdingHours, 0) / records.length;

  const grossWins  = wins.reduce((s, r) => s + r.pnlDollar, 0);
  const grossLoss  = Math.abs(losses.reduce((s, r) => s + r.pnlDollar, 0));
  const profitFactor = grossLoss === 0 ? 999 : parseFloat((grossWins / grossLoss).toFixed(4));

  // Max consecutive losses
  let maxConsec = 0, consec = 0;
  for (const r of records) {
    if (!r.isWin) { consec++; maxConsec = Math.max(maxConsec, consec); }
    else consec = 0;
  }

  // Per-source stats
  const bySource = {};
  for (const r of records) {
    const src = r.sources[0];
    if (!bySource[src]) bySource[src] = { wins: 0, losses: 0, totalPnlDollar: 0 };
    if (r.isWin) bySource[src].wins++;
    else         bySource[src].losses++;
    bySource[src].totalPnlDollar += r.pnlDollar;
  }

  // Exit reason breakdown
  const exitBreakdown = {};
  for (const r of records) {
    exitBreakdown[r.exitReason] = (exitBreakdown[r.exitReason] || 0) + 1;
  }

  return {
    totalTrades:         records.length,
    wins:                wins.length,
    losses:              losses.length,
    winRate:             parseFloat((wins.length / records.length).toFixed(4)),
    totalPnlDollar:      parseFloat(totalPnlDollar.toFixed(2)),
    avgPnlPct:           parseFloat(avgPnlPct.toFixed(4)),
    avgHoldingHours:     parseFloat(avgHoldHours.toFixed(2)),
    profitFactor,
    maxConsecutiveLosses: maxConsec,
    currentLossStreak:   consec,
    recentWinRate:       records.slice(-10).filter(r => r.isWin).length / Math.min(10, records.length),
    exitBreakdown,
    bySource,
    seeded:              true,
    lastUpdated:         new Date().toISOString()
  };
}

// ── File I/O helpers ──────────────────────────────────────────

function loadExistingLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    const data = JSON.parse(raw);
    // Support both old format {records:[]} and current format {trades:[], knownClosedOrderIds:[]}
    return data.trades || data.records || (Array.isArray(data) ? data : []);
  } catch { return []; }
}

function saveFiles(allRecords) {
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would write:');
    console.log(`  ${LEDGER_PATH}      — ${allRecords.length} records`);
    console.log(`  ${SUMMARY_PATH}`);
    console.log(`  ${CALIBRATION_PATH}`);
    return;
  }

  if (!fs.existsSync(TRADE_HISTORY_DIR)) {
    fs.mkdirSync(TRADE_HISTORY_DIR, { recursive: true });
  }

  const ledger      = { trades: allRecords, knownClosedOrderIds: allRecords.map(r => r.orderId) };
  const summary     = buildSummary(allRecords);
  const calibration = buildCalibration(allRecords);

  fs.writeFileSync(LEDGER_PATH,      JSON.stringify(ledger,      null, 2));
  fs.writeFileSync(SUMMARY_PATH,     JSON.stringify(summary,     null, 2));
  fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(calibration, null, 2));

  console.log(`\n✅ Wrote ${allRecords.length} records to performance_ledger.json`);
  console.log(`✅ Wrote performance_summary.json`);
  console.log(`✅ Wrote calibration.json`);
}

// ── Rate limiter ──────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main seeder ───────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  Trading Engine — Historical Data Seeder');
  console.log('═'.repeat(60));
  console.log(`  Universe:   ${UNIVERSE.length} tickers`);
  console.log(`  History:    ${YEARS} years`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log(`  Resume:     ${RESUME}`);
  console.log('─'.repeat(60));

  const totalDays  = YEARS * 365 + 30;  // extra buffer
  const existingRecords = loadExistingLedger();
  const existingKeys    = new Set(existingRecords.filter(r => r.seeded).map(r => r.orderId));

  console.log(`  Existing seeded records: ${existingRecords.filter(r => r.seeded).length}`);

  // Pre-fetch all bars (with progress)
  console.log('\n📥 Fetching historical bars...\n');
  const allBars   = {};
  const pairTickers = new Set(PAIRS.flat());
  const fetchList   = [...new Set([...UNIVERSE, ...pairTickers])];

  for (let i = 0; i < fetchList.length; i++) {
    const sym = fetchList[i];
    process.stdout.write(`  [${String(i+1).padStart(3)}/${fetchList.length}] ${sym.padEnd(6)} `);

    if (RESUME && allBars[sym]) {
      console.log('(cached)');
      continue;
    }

    const bars = await fetchBarsWithFallback(sym, totalDays);
    if (bars && bars.length > MA_LONG + 20) {
      allBars[sym] = bars;
      process.stdout.write(`✓ ${bars.length} bars (${bars[0].date} → ${bars[bars.length-1].date})\n`);
    } else {
      process.stdout.write(`✗ insufficient data\n`);
    }

    // Polite rate limiting: ~3 requests/sec
    await sleep(350);
  }

  const available = Object.keys(allBars);
  console.log(`\n  Fetched data for ${available.length}/${fetchList.length} tickers`);

  // ── Replay strategies ─────────────────────────────────────
  console.log('\n🔄 Replaying strategies...\n');

  const newRecords = [];
  let   signalCount = 0;

  // ── Single-ticker strategies: bollinger, ma_crossover, downtrend
  const singleStrategies = [bollingerSignal, maCrossoverSignal, downtrendSignal];

  for (const sym of available) {
    if (!UNIVERSE.includes(sym)) continue;  // skip pair-only tickers
    const bars = allBars[sym];

    // Cooldown tracker: don't re-enter within 20 days of a trade
    let cooldownUntil = 0;

    for (let i = MA_LONG + 14; i < bars.length - MAX_HOLD_DAYS - 1; i++) {
      if (i < cooldownUntil) continue;

      for (const stratFn of singleStrategies) {
        const sig = stratFn(bars, i);
        if (!sig || sig.score < MIN_SIGNAL_SCORE) continue;

        const entryPrice = bars[i + 1].open;  // enter next open
        const outcome    = simulateTrade(bars, i + 1, entryPrice, sig.source);
        const key        = `seed_${sym}_${outcome.entryDate}_${sig.source}`.replace(/[^a-z0-9_]/gi, '_');

        if (RESUME && existingKeys.has(key)) continue;

        const rec = buildPostmortemRecord(sym, sig.source, { ...outcome, entryPrice });
        newRecords.push(rec);
        signalCount++;
        cooldownUntil = i + MAX_HOLD_DAYS + 1;
        break;  // one trade per bar per ticker
      }
    }
  }

  // ── Pairs trading strategy
  console.log('  Running pairs trading replay...');
  for (const [symA, symB] of PAIRS) {
    const barsA = allBars[symA];
    const barsB = allBars[symB];
    if (!barsA || !barsB) continue;

    // Align bars by date
    const dateMapA = Object.fromEntries(barsA.map(b => [b.date, b]));
    const alignedDates = barsB.map(b => b.date).filter(d => dateMapA[d]);
    const alignedA = alignedDates.map(d => dateMapA[d]);
    const alignedB = barsB.filter(b => alignedDates.includes(b.date));

    let cooldownUntil = 0;

    for (let i = 70; i < alignedDates.length - MAX_HOLD_DAYS - 1; i++) {
      if (i < cooldownUntil) continue;

      const sig = pairsSignal(alignedA, alignedB, symB, i);
      if (!sig || sig.score < MIN_SIGNAL_SCORE) continue;

      const targetBars = sig.buyB ? alignedB : alignedA;
      const targetSym  = sig.buyB ? symB      : symA;

      if (i + 1 >= targetBars.length) continue;
      const entryPrice = targetBars[i + 1].open;
      const outcome    = simulateTrade(targetBars, i + 1, entryPrice, 'relative_value');
      const key        = `seed_${targetSym}_${outcome.entryDate}_relative_value`.replace(/[^a-z0-9_]/gi, '_');

      if (RESUME && existingKeys.has(key)) continue;

      const rec = buildPostmortemRecord(targetSym, 'relative_value', { ...outcome, entryPrice });
      newRecords.push(rec);
      signalCount++;
      cooldownUntil = i + MAX_HOLD_DAYS + 1;
    }
  }

  // ── Merge with existing records and save ──────────────────
  const allRecords = [
    ...existingRecords,
    ...newRecords
  ];

  // Deduplication by orderId
  const seen      = new Set();
  const deduped   = [];
  for (const r of allRecords) {
    if (!seen.has(r.orderId)) { seen.add(r.orderId); deduped.push(r); }
  }

  console.log(`\n📊 Results:`);
  console.log(`  Total signals replayed:  ${signalCount}`);
  console.log(`  New postmortem records:  ${newRecords.length}`);
  console.log(`  Combined ledger size:    ${deduped.length}`);

  // Source breakdown
  const bySource = {};
  for (const r of newRecords) {
    const src = r.sources[0];
    if (!bySource[src]) bySource[src] = { total: 0, wins: 0 };
    bySource[src].total++;
    if (r.isWin) bySource[src].wins++;
  }
  console.log('\n  By strategy:');
  for (const [src, stat] of Object.entries(bySource)) {
    const wr = stat.total > 0 ? ((stat.wins / stat.total) * 100).toFixed(1) : '0.0';
    console.log(`    ${src.padEnd(20)} ${String(stat.total).padStart(4)} trades  ${wr}% win rate`);
  }

  saveFiles(deduped);

  // Print bootstrap promotion check
  const techSources  = ['bollinger', 'ma_crossover', 'downtrend', 'relative_value'];
  const minPerStrat  = Math.min(...techSources.map(s => (bySource[s]?.total || 0)));
  console.log('\n🚀 Bootstrap check:');
  console.log(`  Min trades per strategy: ${minPerStrat} (need 30+ to auto-promote)`);
  if (minPerStrat >= 30) {
    console.log('  ✅ System can promote to CALIBRATED mode immediately');
  } else {
    console.log(`  ⏳ Need ${30 - minPerStrat} more trades per strategy — try --years=${YEARS + 1}`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  Seeding complete. Restart your engine to apply.');
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('\n❌ Seeder failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
