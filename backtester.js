/**
 * Backtester — Historical simulation of the trading engine
 *
 * Loads historical bars from Alpaca, walks day-by-day, applies the same
 * signal generation + risk management as the live system, and reports
 * performance metrics.
 *
 * Usage:
 *   node backtester.js                          (defaults: last 2 years, $100k)
 *   node backtester.js --start 2024-01-01 --end 2025-12-31 --capital 50000
 *   node backtester.js --walkforward            (walk-forward mode)
 */

const fs   = require('fs');
const path = require('path');

// ─── Load env ───────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const DATA_BASE = 'https://data.alpaca.markets/v2';
const HEADERS   = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
};

// ─── Import helpers from existing codebase ──────────────────────────────────
const { closes, volumes, sma, stddev, rsi, bollingerBands, correlation, returns } = require('./data/prices');
const { UNIVERSE }     = require('./data/universe');
const { aggregateByTicker, PRIMARY_SOURCES } = require('./signals');
const { BASE_WEIGHTS } = require('./strategy_calibrator');
const { getSector, MAX_SECTOR_PCT, MAX_DRAWDOWN_PCT } = require('./governor');

// ─── Engine constants (shared with engine.js) ──────────────────────────────
const MAX_POSITIONS  = 20;
const POSITION_PCT   = 0.08;
const MAX_EXPOSURE   = 0.96;
const BUY_THRESHOLD  = 65;

const EXIT_SLIPPAGE_PCT = 0.03; // 3 bps exit slippage (exits are at known levels, lower impact)

// ─── Dynamic slippage model ────────────────────────────────────────────────
// Slippage scales with volatility and order size relative to daily volume
// Base: 3 bps mega-cap, 10 bps mid-cap, 30 bps small-cap
function estimateSlippage(ticker, orderValue, bars) {
  if (!bars || bars.length < 20) return 0.05; // fallback 5 bps
  const recent = bars.slice(-20);
  const avgVolume = recent.reduce((s, b) => s + b.v, 0) / recent.length;
  const avgPrice = recent.reduce((s, b) => s + b.c, 0) / recent.length;
  const dailyDollarVol = avgVolume * avgPrice;
  // Volatility factor: higher vol = more slippage
  const closes = recent.map(b => b.c);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i-1]) / closes[i-1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100;
  // Base slippage by liquidity tier
  let baseBps;
  if (dailyDollarVol > 500e6) baseBps = 2;       // mega-cap: 2 bps
  else if (dailyDollarVol > 50e6) baseBps = 5;   // large-cap: 5 bps
  else if (dailyDollarVol > 10e6) baseBps = 10;  // mid-cap: 10 bps
  else if (dailyDollarVol > 1e6) baseBps = 20;   // small-cap: 20 bps
  else baseBps = 40;                              // micro-cap: 40 bps
  // Impact factor: order size relative to daily volume (square-root model)
  const participationRate = orderValue / (dailyDollarVol || 1);
  const impactFactor = 1 + Math.sqrt(Math.min(participationRate, 0.1)) * 5;
  // Vol factor: scale with realized vol (25% baseline)
  const volFactor = Math.max(0.5, Math.min(3.0, vol / 25));
  return (baseBps * impactFactor * volFactor) / 100; // return as percentage
}

// Strategy-specific exit profiles with trailing ladder (must match engine.js)
const EXIT_PROFILES = {
  mean_reversion: { hardStop: 10, trail: 8, profitTarget: null, ladder1: 8,  ladder2: 16, trail2: 5, trail3: 3 },
  trend:          { hardStop: 8,  trail: 6, profitTarget: null, ladder1: 7,  ladder2: 14, trail2: 4, trail3: 3 },
  relative_value: { hardStop: 6,  trail: 5, profitTarget: 10,  ladder1: 5,  ladder2: 8,  trail2: 3, trail3: 2 },
  default:        { hardStop: 8,  trail: 6, profitTarget: 12,  ladder1: 7,  ladder2: 14, trail2: 4, trail3: 3 },
};
const SOURCE_TO_PROFILE = {
  downtrend: 'mean_reversion', bollinger: 'mean_reversion',
  ma_crossover: 'trend', relative_value: 'relative_value',
};
function getExitProfile(source) {
  return EXIT_PROFILES[SOURCE_TO_PROFILE[source] || 'default'];
}

// ─── Vol-adjusted position sizing (mirrors engine.js) ───────────────────────
const BASELINE_VOL = 0.25;
const MIN_SIZE     = 0.02;
const MAX_SIZE     = 0.12;

function getVolAdjustedSize(dailyReturns, baseSize) {
  if (dailyReturns.length < 20) return baseSize;
  const recent = dailyReturns.slice(-30);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
  const dailyVol = Math.sqrt(variance);
  const realizedVol = dailyVol * Math.sqrt(252);
  const adjusted = baseSize * (BASELINE_VOL / Math.max(realizedVol, 0.01));
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, adjusted));
}

// ─── Pairs from relative_value (formerly pairs_trading.js) ─────────────────
const PAIRS = [
  ['MSFT','GOOGL'],['AMD','NVDA'],['META','SNAP'],['ORCL','CRM'],['QCOM','AVGO'],
  ['JPM','BAC'],['GS','MS'],['C','WFC'],['XOM','CVX'],['COP','OXY'],
  ['SLB','HAL'],['PFE','MRK'],['JNJ','ABT'],['UNH','CVS'],['WMT','TGT'],
  ['HD','LOW'],['AMZN','COST'],['GM','F'],['TSLA','RIVN'],
];

// ─── Historical data loading ────────────────────────────────────────────────

/**
 * Fetch all bars for a ticker between startDate and endDate from Alpaca.
 * Returns array of { t, o, h, l, c, v }.
 */
async function fetchAllBars(symbol, startDate, endDate) {
  const allBars = [];
  let pageToken = null;
  const limit = 10000;

  while (true) {
    let url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=${limit}&feed=iex`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const res  = await fetch(url, { headers: HEADERS });
    const json = await res.json();

    if (json.bars && json.bars.length > 0) {
      for (const b of json.bars) {
        allBars.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }

    if (json.next_page_token) {
      pageToken = json.next_page_token;
    } else {
      break;
    }
  }

  return allBars;
}

/**
 * Load bars for all universe tickers. Returns Map<ticker, bars[]>.
 * Fetches in parallel batches to avoid rate limits.
 */
async function loadAllData(startDate, endDate) {
  console.log(`\n[Backtester] Loading historical data: ${startDate} to ${endDate}`);
  console.log(`[Backtester] Universe size: ${UNIVERSE.length} tickers`);

  // Need extra lookback for indicators (220 days for 200-SMA)
  const lookbackDate = new Date(startDate);
  lookbackDate.setDate(lookbackDate.getDate() - 300);
  const fetchStart = lookbackDate.toISOString().slice(0, 10);

  const dataMap = new Map();
  const BATCH_SIZE = 15;
  let loaded = 0;
  let failed = 0;

  for (let i = 0; i < UNIVERSE.length; i += BATCH_SIZE) {
    const batch = UNIVERSE.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async ticker => {
        const bars = await fetchAllBars(ticker, fetchStart, endDate);
        return { ticker, bars };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.bars.length > 0) {
        dataMap.set(r.value.ticker, r.value.bars);
        loaded++;
      } else {
        failed++;
      }
    }

    // Rate limiting
    if (i + BATCH_SIZE < UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 250));
    }

    process.stdout.write(`\r[Backtester] Loaded: ${loaded} tickers, failed: ${failed}, progress: ${Math.min(i + BATCH_SIZE, UNIVERSE.length)}/${UNIVERSE.length}`);
  }

  console.log(`\n[Backtester] Data loaded: ${dataMap.size} tickers with data`);
  return dataMap;
}

// ─── Slice bars up to a given date ──────────────────────────────────────────
function barsUpTo(allBars, dateStr) {
  // dateStr is YYYY-MM-DD; include bars whose date <= dateStr
  return allBars.filter(b => b.t.slice(0, 10) <= dateStr);
}

function barOnDate(allBars, dateStr) {
  return allBars.find(b => b.t.slice(0, 10) === dateStr) || null;
}

// ─── Signal generation (offline — no API calls) ─────────────────────────────

function generateBollingerSignals(dataMap, dateStr, vixBars) {
  // Approximate VIX from stored VIX data, or skip VIX gating for backtest
  // Since we can't reliably get historical VIX from Alpaca IEX feed,
  // we'll relax the VIX gate for backtesting purposes.
  const signals = [];

  for (const [ticker, allBars] of dataMap) {
    try {
      const bars = barsUpTo(allBars, dateStr);
      const cls  = closes(bars);
      if (cls.length < 25) continue;
      const price  = cls[cls.length - 1];
      const bb     = bollingerBands(cls, 20, 2);
      const rsiVal = rsi(cls, 14);
      if (!bb || rsiVal === null) continue;
      if ((bb.upper - bb.lower) / bb.mid < 0.05) continue;
      if (price < bb.lower && rsiVal < 35) {
        const dist  = (bb.lower - price) / bb.lower * 100;
        const score = Math.min(85, Math.round(dist * 8 + 5)); // simplified: no VIX component
        signals.push({
          ticker, direction: 'bullish', score,
          reason: `Bollinger: $${price.toFixed(2)} below lower $${bb.lower.toFixed(2)} (${dist.toFixed(1)}%), RSI=${rsiVal.toFixed(0)}`,
          source: 'bollinger',
        });
      }
    } catch {}
  }
  return signals;
}

function generateMACrossoverSignals(dataMap, dateStr) {
  const signals = [];
  for (const [ticker, allBars] of dataMap) {
    try {
      const bars = barsUpTo(allBars, dateStr);
      const cls  = closes(bars);
      const vols = volumes(bars);
      if (cls.length < 205) continue;
      const shortNow = sma(cls, 50), longNow = sma(cls, 200);
      const avgVol = sma(vols, 20), todayVol = vols[vols.length - 1];
      if (!shortNow || !longNow || !avgVol) continue;
      let crossed = false, daysAgo = 0;
      for (let i = 1; i <= 5; i++) {
        const ps = sma(cls.slice(0, -i), 50), pl = sma(cls.slice(0, -i), 200);
        if (ps && pl && ps < pl && shortNow > longNow) { crossed = true; daysAgo = i; break; }
      }
      if (!crossed || cls[cls.length - 1] <= longNow) continue;
      const volRatio = todayVol / avgVol;
      if (volRatio < 1.5) continue;
      const score = Math.min(80, 40 + (6 - daysAgo) * 5 + Math.min(20, Math.round((volRatio - 1) * 15)));
      signals.push({
        ticker, direction: 'bullish', score,
        reason: `Golden cross: 50MA > 200MA (${daysAgo}d ago), vol ${volRatio.toFixed(1)}x`,
        source: 'ma_crossover',
      });
    } catch {}
  }
  return signals;
}

function generateDowntrendSignals(dataMap, dateStr) {
  const signals = [];
  for (const [ticker, allBars] of dataMap) {
    try {
      const bars = barsUpTo(allBars, dateStr);
      const cls  = closes(bars);
      if (cls.length < 50) continue;
      const rsiVal = rsi(cls, 14);
      if (rsiVal === null || rsiVal > 35) continue;
      // Count downtrend days
      let count = 0;
      for (let i = cls.length - 1; i >= 20; i--) {
        const ma = cls.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
        if (cls[i] < ma) count++; else break;
      }
      if (count < 15) continue;
      // Simplified bullish divergence check
      let div = false;
      if (cls.length >= 30) {
        const recent = cls.slice(-30);
        const rsiSeries = [];
        for (let i = 14; i <= recent.length; i++) rsiSeries.push(rsi(recent.slice(0, i), 14));
        if (rsiSeries.length >= 10) {
          const prices = recent.slice(-20);
          let low1 = 0, low2 = 0;
          for (let i = 1; i < prices.length - 1; i++) {
            if (prices[i] < prices[low1]) { low2 = low1; low1 = i; }
            else if (prices[i] < prices[low2]) low2 = i;
          }
          if (low1 !== low2) {
            const [e, l] = low1 < low2 ? [low1, low2] : [low2, low1];
            div = prices[l] < prices[e] && rsiSeries[Math.max(0, l - 2)] > rsiSeries[Math.max(0, e - 2)];
          }
        }
      }
      let score = Math.min(50, 20 + count);
      if (div) score = Math.min(80, score + 25);
      signals.push({
        ticker, direction: 'bullish', score,
        reason: `Downtrend reversal: ${count}d downtrend, RSI=${rsiVal.toFixed(0)}${div ? ', RSI divergence' : ''}`,
        source: 'downtrend',
      });
    } catch {}
  }
  return signals;
}

function generatePairsTradingSignals(dataMap, dateStr) {
  const signals = [];
  for (const [A, B] of PAIRS) {
    try {
      const barsA = dataMap.get(A), barsB = dataMap.get(B);
      if (!barsA || !barsB) continue;
      const cA = closes(barsUpTo(barsA, dateStr));
      const cB = closes(barsUpTo(barsB, dateStr));
      if (cA.length < 60 || cB.length < 60) continue;
      const corr = correlation(returns(cA), returns(cB));
      if (corr < 0.70) continue;
      // z-score of log spread
      const n = Math.min(cA.length, cB.length);
      const spreadArr = Array.from({ length: n }, (_, i) =>
        Math.log(cA[cA.length - n + i]) - Math.log(cB[cB.length - n + i])
      );
      if (spreadArr.length < 10) continue;
      const mean = spreadArr.reduce((a, b) => a + b, 0) / spreadArr.length;
      const std2 = Math.sqrt(spreadArr.reduce((s, v) => s + (v - mean) ** 2, 0) / spreadArr.length);
      const z = std2 === 0 ? 0 : (spreadArr[spreadArr.length - 1] - mean) / std2;
      if (Math.abs(z) < 2.0) continue;
      const score = Math.min(75, Math.round(Math.abs(z) * 20));
      const [buy] = z > 2 ? [B, A] : [A, B];
      signals.push({
        ticker: buy, direction: 'bullish', score,
        reason: `Pairs ${A}/${B} z=${z.toFixed(2)} corr=${corr.toFixed(2)}`,
        source: 'relative_value',
      });
    } catch {}
  }
  return signals;
}

function generateAllSignals(dataMap, dateStr) {
  const all = [
    ...generateBollingerSignals(dataMap, dateStr),
    ...generateMACrossoverSignals(dataMap, dateStr),
    ...generateDowntrendSignals(dataMap, dateStr),
    ...generatePairsTradingSignals(dataMap, dateStr),
  ];
  return aggregateByTicker(all);
}

// ─── Risk gates (simplified for backtest) ───────────────────────────────────

function checkSectorLimit(positions, ticker, equity) {
  const sectorExposure = {};
  for (const pos of positions) {
    const sector = getSector(pos.ticker);
    sectorExposure[sector] = (sectorExposure[sector] || 0) + pos.currentValue;
  }
  const newSector = getSector(ticker);
  const currentVal = sectorExposure[newSector] || 0;
  const positionVal = equity * POSITION_PCT;
  const projectedPct = ((currentVal + positionVal) / equity) * 100;
  return projectedPct <= MAX_SECTOR_PCT;
}

function checkDrawdownKill(equity, peakEquity) {
  const ddPct = ((peakEquity - equity) / peakEquity) * 100;
  return ddPct < MAX_DRAWDOWN_PCT;
}

// ─── Build list of trading dates from data ──────────────────────────────────
function getTradingDates(dataMap, startDate, endDate) {
  const dateSet = new Set();
  for (const [, bars] of dataMap) {
    for (const b of bars) {
      const d = b.t.slice(0, 10);
      if (d >= startDate && d <= endDate) dateSet.add(d);
    }
  }
  return [...dateSet].sort();
}

// ─── Core simulation ────────────────────────────────────────────────────────

async function runBacktest(startDate, endDate, initialCapital) {
  const dataMap = await loadAllData(startDate, endDate);

  const tradingDates = getTradingDates(dataMap, startDate, endDate);
  console.log(`[Backtester] Trading days: ${tradingDates.length} (${tradingDates[0]} to ${tradingDates[tradingDates.length - 1]})`);

  // State
  let cash = initialCapital;
  let peakEquity = initialCapital;
  const positions = [];       // { ticker, entryDate, entryPrice, qty, peakPrice }
  const closedTrades = [];    // { ticker, entryDate, exitDate, entryPrice, exitPrice, qty, pnl, pnlPct, reason }
  const equityCurve = [];     // { date, equity, cash, invested, positionCount }
  let pendingBuys = [];       // { ticker, reason, date } — buy signals from previous day
  let dailyTradeCount = 0;
  let dailyTradeDate = '';
  const MAX_DAILY_TRADES = 10;

  for (let dayIdx = 0; dayIdx < tradingDates.length; dayIdx++) {
    const today = tradingDates[dayIdx];

    // Reset daily trade counter
    if (dailyTradeDate !== today) {
      dailyTradeCount = 0;
      dailyTradeDate = today;
    }

    // ── 1. Execute pending buys from previous day at today's open ──────
    if (pendingBuys.length > 0) {
      for (const pending of pendingBuys) {
        if (dailyTradeCount >= MAX_DAILY_TRADES) break;
        if (positions.length >= MAX_POSITIONS) break;

        const tickerBars = dataMap.get(pending.ticker);
        if (!tickerBars) continue;
        const todayBar = barOnDate(tickerBars, today);
        if (!todayBar) continue;

        const openPrice = todayBar.o;
        // Dynamic slippage based on liquidity, volatility, and order size
        const historicalForSlippage = barsUpTo(tickerBars, today);
        const estOrderValue = equity * POSITION_PCT;
        const slippagePct = estimateSlippage(pending.ticker, estOrderValue, historicalForSlippage);
        const fillPrice = openPrice * (1 + slippagePct / 100);

        // Calculate equity for position sizing
        const invested = positions.reduce((s, p) => {
          const pb = dataMap.get(p.ticker);
          const bar = pb ? barOnDate(pb, today) : null;
          const price = bar ? bar.o : p.entryPrice;
          return s + price * p.qty;
        }, 0);
        const equity = cash + invested;

        // Check exposure limit
        if (invested / equity >= MAX_EXPOSURE) continue;

        // Vol-adjusted position sizing
        const historicalBars = barsUpTo(tickerBars, today);
        const cls = closes(historicalBars);
        const rets = returns(cls);
        const adjSize = getVolAdjustedSize(rets, POSITION_PCT);
        const positionValue = equity * adjSize;
        const qty = Math.max(1, Math.floor(positionValue / fillPrice));
        const cost = qty * fillPrice;

        if (cost > cash) continue;
        if (!checkSectorLimit(positions, pending.ticker, equity)) continue;

        cash -= cost;
        positions.push({
          ticker: pending.ticker,
          entryDate: today,
          entryPrice: fillPrice,
          qty,
          peakPrice: fillPrice,
          reason: pending.reason,
          source: pending.source || 'unknown',
        });
        dailyTradeCount++;
      }
      pendingBuys = [];
    }

    // ── 2. Check existing positions for exits (strategy-specific) ─────
    const toClose = [];
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      const tickerBars = dataMap.get(pos.ticker);
      if (!tickerBars) continue;
      const todayBar = barOnDate(tickerBars, today);
      if (!todayBar) continue;

      const profile = getExitProfile(pos.source);
      const currentPrice = todayBar.c;
      const highPrice    = todayBar.h;
      const lowPrice     = todayBar.l;

      // Update peak price using today's high
      if (highPrice > pos.peakPrice) pos.peakPrice = highPrice;
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const highPnl = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // ── Trailing ladder: partial sells at profit milestones ──────────
      if (profile.ladder1 && pos.qty >= 3) {
        if (!pos.ladder1Sold && highPnl >= profile.ladder1) {
          const sellQty = Math.max(1, Math.floor(pos.qty * 0.33));
          const exitPrice = pos.entryPrice * (1 + profile.ladder1 / 100) * (1 - EXIT_SLIPPAGE_PCT / 100);
          // Record partial close
          toClose.push({ idx: i, exitPrice, reason: 'ladder_t1', partialQty: sellQty });
          pos.ladder1Sold = true;
          pos.activeTrail = profile.trail2; // tighten trail on remainder
          continue;
        }
        if (pos.ladder1Sold && !pos.ladder2Sold && highPnl >= profile.ladder2) {
          const sellQty = Math.max(1, Math.floor(pos.qty * 0.50));
          if (sellQty < pos.qty) {
            const exitPrice = pos.entryPrice * (1 + profile.ladder2 / 100) * (1 - EXIT_SLIPPAGE_PCT / 100);
            toClose.push({ idx: i, exitPrice, reason: 'ladder_t2', partialQty: sellQty });
            pos.ladder2Sold = true;
            pos.activeTrail = profile.trail3; // tightest trail on last tranche
            continue;
          }
        }
      }

      // Check profit target — only if the profile has one AND no ladder active
      if (profile.profitTarget && !pos.ladder1Sold) {
        if (highPnl >= profile.profitTarget) {
          const exitPrice = pos.entryPrice * (1 + profile.profitTarget / 100) * (1 - EXIT_SLIPPAGE_PCT / 100);
          toClose.push({ idx: i, exitPrice, reason: 'profit_target' });
          continue;
        }
      }

      // Check hard stop (strategy-specific)
      const lowPnl = ((lowPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (lowPnl <= -profile.hardStop) {
        const exitPrice = pos.entryPrice * (1 - profile.hardStop / 100) * (1 - EXIT_SLIPPAGE_PCT / 100);
        toClose.push({ idx: i, exitPrice, reason: 'hard_stop' });
        continue;
      }

      // Check trailing stop (uses tightened trail if ladder tranches sold)
      const activeTrail = pos.activeTrail || profile.trail;
      const trailDrop = ((pos.peakPrice - lowPrice) / pos.peakPrice) * 100;
      if (trailDrop >= activeTrail && pos.peakPrice > pos.entryPrice * 1.01) {
        const exitPrice = pos.peakPrice * (1 - activeTrail / 100) * (1 - EXIT_SLIPPAGE_PCT / 100);
        toClose.push({ idx: i, exitPrice, reason: 'trailing_stop' });
        continue;
      }
    }

    // Process closes (reverse order to keep indices valid)
    toClose.sort((a, b) => b.idx - a.idx);
    for (const close of toClose) {
      const pos = positions[close.idx];
      const isPartial = close.partialQty && close.partialQty < pos.qty;
      const closeQty = isPartial ? close.partialQty : pos.qty;
      const pnl = (close.exitPrice - pos.entryPrice) * closeQty;
      const pnlPct = ((close.exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      cash += close.exitPrice * closeQty;
      closedTrades.push({
        ticker: pos.ticker,
        entryDate: pos.entryDate,
        exitDate: today,
        entryPrice: pos.entryPrice,
        exitPrice: close.exitPrice,
        qty: closeQty,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        reason: close.reason,
      });
      if (isPartial) {
        pos.qty -= closeQty; // reduce position, keep remainder
      } else {
        positions.splice(close.idx, 1); // fully closed
      }
    }

    // ── 3. Calculate daily equity ─────────────────────────────────────
    let invested = 0;
    for (const pos of positions) {
      const tickerBars = dataMap.get(pos.ticker);
      if (!tickerBars) continue;
      const todayBar = barOnDate(tickerBars, today);
      const price = todayBar ? todayBar.c : pos.entryPrice;
      pos.currentValue = price * pos.qty;
      invested += pos.currentValue;
    }
    const equity = cash + invested;
    if (equity > peakEquity) peakEquity = equity;

    equityCurve.push({
      date: today,
      equity: Math.round(equity * 100) / 100,
      cash: Math.round(cash * 100) / 100,
      invested: Math.round(invested * 100) / 100,
      positionCount: positions.length,
    });

    // ── 4. Generate signals for tomorrow's buys ───────────────────────
    // Skip last day — no tomorrow to execute
    if (dayIdx >= tradingDates.length - 1) continue;

    // Drawdown kill
    if (!checkDrawdownKill(equity, peakEquity)) continue;

    // Generate signals using data up to today's close
    const ranked = generateAllSignals(dataMap, today);
    const candidates = ranked.filter(t => t.netScore >= BUY_THRESHOLD);

    const openTickers = new Set(positions.map(p => p.ticker));
    const slots = MAX_POSITIONS - positions.length;
    if (slots <= 0) continue;

    // Check exposure
    if (invested / equity >= MAX_EXPOSURE) continue;

    const toBuy = candidates
      .filter(c => !openTickers.has(c.ticker))
      .filter(c => c.confirmedByTech)  // must have a primary technical signal
      .filter(c => checkSectorLimit(positions, c.ticker, equity))
      .slice(0, Math.min(slots, MAX_DAILY_TRADES - dailyTradeCount));

    for (const c of toBuy) {
      const top = c.signals.sort((a, b) => b.score - a.score)[0];
      pendingBuys.push({
        ticker: c.ticker,
        reason: `Score ${c.netScore} [${c.sources.join('+')}] ${top?.reason || ''}`,
        date: today,
        source: top?.source || 'unknown',
      });
    }

    // Progress every 50 days
    if (dayIdx > 0 && dayIdx % 50 === 0) {
      process.stdout.write(`\r[Backtester] Day ${dayIdx}/${tradingDates.length} | Equity: $${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })} | Positions: ${positions.length} | Trades: ${closedTrades.length}`);
    }
  }

  // ── Close remaining positions at last day's close ─────────────────
  const lastDay = tradingDates[tradingDates.length - 1];
  for (const pos of positions) {
    const tickerBars = dataMap.get(pos.ticker);
    const todayBar = tickerBars ? barOnDate(tickerBars, lastDay) : null;
    const exitPrice = todayBar ? todayBar.c * (1 - EXIT_SLIPPAGE_PCT / 100) : pos.entryPrice;
    const pnl = (exitPrice - pos.entryPrice) * pos.qty;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    closedTrades.push({
      ticker: pos.ticker,
      entryDate: pos.entryDate,
      exitDate: lastDay,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
      reason: 'end_of_backtest',
    });
  }

  // ── Compute SPY benchmark for alpha comparison ──────────────────
  const spyBars = dataMap.get('SPY');
  let benchmarkReturn = null;
  if (spyBars && tradingDates.length >= 2) {
    const spyStart = barOnDate(spyBars, tradingDates[0]);
    const spyEnd = barOnDate(spyBars, tradingDates[tradingDates.length - 1]);
    if (spyStart && spyEnd) {
      benchmarkReturn = ((spyEnd.c - spyStart.o) / spyStart.o) * 100;
    }
  }

  console.log('');
  return { equityCurve, closedTrades, initialCapital, benchmarkReturn };
}

// ─── Performance metrics ────────────────────────────────────────────────────

function computeMetrics(equityCurve, closedTrades, initialCapital) {
  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;

  // Trading days
  const tradingDays = equityCurve.length;
  const years = tradingDays / 252;
  const annualizedReturn = (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100;

  // Daily returns for Sharpe/Sortino
  const dailyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
  }

  const riskFreeDaily = 0.04 / 252;

  // Sharpe ratio
  const excessReturns = dailyReturns.map(r => r - riskFreeDaily);
  const meanExcess = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
  const stdExcess = Math.sqrt(excessReturns.reduce((s, r) => s + (r - meanExcess) ** 2, 0) / excessReturns.length);
  const sharpe = stdExcess === 0 ? 0 : (meanExcess / stdExcess) * Math.sqrt(252);

  // Sortino ratio (downside deviation only)
  const downsideReturns = excessReturns.filter(r => r < 0);
  const downsideDev = downsideReturns.length === 0 ? 0 :
    Math.sqrt(downsideReturns.reduce((s, r) => s + r ** 2, 0) / excessReturns.length);
  const sortino = downsideDev === 0 ? 0 : (meanExcess / downsideDev) * Math.sqrt(252);

  // Max drawdown
  let peak = initialCapital;
  let maxDD = 0;
  let maxDDDuration = 0;
  let currentDDDuration = 0;
  let ddStart = null;

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
      currentDDDuration = 0;
    } else {
      currentDDDuration++;
      const dd = ((peak - point.equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      if (currentDDDuration > maxDDDuration) maxDDDuration = currentDDDuration;
    }
  }

  // Calmar ratio
  const calmar = maxDD === 0 ? 0 : annualizedReturn / maxDD;

  // Trade stats
  const wins  = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);
  const winRate = closedTrades.length === 0 ? 0 : (wins.length / closedTrades.length) * 100;

  const grossWins  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses === 0 ? Infinity : grossWins / grossLosses;

  const avgWinPct  = wins.length === 0 ? 0 : wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length;
  const avgLossPct = losses.length === 0 ? 0 : losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length;

  // Holding periods
  const holdingDays = closedTrades.map(t => {
    const entry = new Date(t.entryDate);
    const exit  = new Date(t.exitDate);
    return Math.round((exit - entry) / 86400000);
  });
  const avgHoldingDays = holdingDays.length === 0 ? 0 : holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length;

  const bestTrade  = closedTrades.length === 0 ? null : closedTrades.reduce((best, t) => t.pnlPct > best.pnlPct ? t : best);
  const worstTrade = closedTrades.length === 0 ? null : closedTrades.reduce((worst, t) => t.pnlPct < worst.pnlPct ? t : worst);

  // Exit breakdown
  const exitBreakdown = {};
  for (const t of closedTrades) {
    exitBreakdown[t.reason] = (exitBreakdown[t.reason] || 0) + 1;
  }

  return {
    initialCapital,
    finalEquity: Math.round(finalEquity * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    annualizedReturn: Math.round(annualizedReturn * 100) / 100,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownDuration: maxDDDuration,
    sharpe: Math.round(sharpe * 100) / 100,
    sortino: Math.round(sortino * 100) / 100,
    calmar: Math.round(calmar * 100) / 100,
    totalTrades: closedTrades.length,
    winRate: Math.round(winRate * 100) / 100,
    profitFactor: profitFactor === Infinity ? 'Inf' : Math.round(profitFactor * 100) / 100,
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    avgHoldingDays: Math.round(avgHoldingDays * 10) / 10,
    bestTrade: bestTrade ? `${bestTrade.ticker} +${bestTrade.pnlPct}%` : 'N/A',
    worstTrade: worstTrade ? `${worstTrade.ticker} ${worstTrade.pnlPct}%` : 'N/A',
    grossWins: Math.round(grossWins * 100) / 100,
    grossLosses: Math.round(grossLosses * 100) / 100,
    tradingDays,
    exitBreakdown,
  };
}

function addBenchmarkMetrics(metrics, benchmarkReturn) {
  if (benchmarkReturn !== null && benchmarkReturn !== undefined) {
    metrics.benchmarkReturn = Math.round(benchmarkReturn * 100) / 100;
    metrics.alpha = Math.round((metrics.totalReturn - benchmarkReturn) * 100) / 100;
    metrics.beatsBenchmark = metrics.totalReturn > benchmarkReturn;
  }
  return metrics;
}

// ─── Walk-forward ───────────────────────────────────────────────────────────

async function runWalkForward(startDate, endDate, initialCapital, trainMonths = 6, testMonths = 1, advanceMonths = 1) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`WALK-FORWARD ANALYSIS`);
  console.log(`Train: ${trainMonths}mo | Test: ${testMonths}mo | Advance: ${advanceMonths}mo`);
  console.log(`${'='.repeat(70)}`);

  const start = new Date(startDate);
  const end   = new Date(endDate);
  const windows = [];

  let cursor = new Date(start);
  while (true) {
    const trainStart = new Date(cursor);
    const trainEnd   = new Date(cursor);
    trainEnd.setMonth(trainEnd.getMonth() + trainMonths);
    const testStart  = new Date(trainEnd);
    testStart.setDate(testStart.getDate() + 1);
    const testEnd    = new Date(testStart);
    testEnd.setMonth(testEnd.getMonth() + testMonths);

    if (testEnd > end) break;

    windows.push({
      trainStart: trainStart.toISOString().slice(0, 10),
      trainEnd: trainEnd.toISOString().slice(0, 10),
      testStart: testStart.toISOString().slice(0, 10),
      testEnd: testEnd.toISOString().slice(0, 10),
    });

    cursor.setMonth(cursor.getMonth() + advanceMonths);
  }

  console.log(`[Walk-Forward] ${windows.length} windows\n`);

  const allTestResults = [];
  const allTestTrades  = [];
  const allTestEquity  = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    console.log(`\n--- Window ${i + 1}/${windows.length}: Train ${w.trainStart} to ${w.trainEnd} | Test ${w.testStart} to ${w.testEnd} ---`);

    // Train phase (just run to see metrics, but we don't optimize params yet)
    console.log(`[Train]`);
    const trainResult = await runBacktest(w.trainStart, w.trainEnd, initialCapital);
    const trainMetrics = computeMetrics(trainResult.equityCurve, trainResult.closedTrades, initialCapital);
    console.log(`  Train Return: ${trainMetrics.totalReturn}% | Sharpe: ${trainMetrics.sharpe} | Trades: ${trainMetrics.totalTrades}`);

    // Test phase (out-of-sample)
    console.log(`[Test]`);
    const testResult = await runBacktest(w.testStart, w.testEnd, initialCapital);
    const testMetrics = computeMetrics(testResult.equityCurve, testResult.closedTrades, initialCapital);
    console.log(`  Test Return: ${testMetrics.totalReturn}% | Sharpe: ${testMetrics.sharpe} | Trades: ${testMetrics.totalTrades}`);

    allTestResults.push({ window: i + 1, ...w, trainMetrics, testMetrics });
    allTestTrades.push(...testResult.closedTrades);
    allTestEquity.push(...testResult.equityCurve);
  }

  // ── Per-window detailed results ──────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log('PER-WINDOW RESULTS (Out-of-Sample)');
  console.log(`${'='.repeat(70)}`);
  console.log(`  ${'#'.padEnd(4)} ${'Test Period'.padEnd(26)} ${'Return'.padStart(9)} ${'Sharpe'.padStart(8)} ${'MaxDD'.padStart(8)} ${'WinRate'.padStart(9)} ${'Trades'.padStart(7)}`);
  console.log(`  ${'-'.repeat(71)}`);

  for (const r of allTestResults) {
    const m = r.testMetrics;
    const retStr = (m.totalReturn >= 0 ? '+' : '') + m.totalReturn.toFixed(2) + '%';
    const sharpeStr = m.sharpe.toFixed(2);
    const ddStr = '-' + m.maxDrawdown.toFixed(2) + '%';
    const wrStr = m.winRate.toFixed(1) + '%';
    console.log(`  ${String(r.window).padEnd(4)} ${(r.testStart + ' to ' + r.testEnd).padEnd(26)} ${retStr.padStart(9)} ${sharpeStr.padStart(8)} ${ddStr.padStart(8)} ${wrStr.padStart(9)} ${String(m.totalTrades).padStart(7)}`);
  }

  // ── Aggregate out-of-sample metrics ─────────────────────────────────
  console.log(`\n${'='.repeat(70)}`);
  console.log('WALK-FORWARD AGGREGATE (Out-of-Sample)');
  console.log(`${'='.repeat(70)}`);

  const oosReturns = allTestResults.map(r => r.testMetrics.totalReturn);
  const oosSharpes = allTestResults.map(r => r.testMetrics.sharpe);
  const oosDrawdowns = allTestResults.map(r => r.testMetrics.maxDrawdown);
  const oosWinRates = allTestResults.map(r => r.testMetrics.winRate);

  const avgOOS = oosReturns.reduce((a, b) => a + b, 0) / oosReturns.length;
  const avgSharpe = oosSharpes.reduce((a, b) => a + b, 0) / oosSharpes.length;
  const maxDD = Math.max(...oosDrawdowns);
  const avgWinRate = oosWinRates.reduce((a, b) => a + b, 0) / oosWinRates.length;
  const positiveWindows = oosReturns.filter(r => r > 0).length;
  const consistencyRatio = (positiveWindows / windows.length * 100);

  console.log(`  Windows:              ${windows.length}`);
  console.log(`  Avg OOS Return:       ${avgOOS >= 0 ? '+' : ''}${avgOOS.toFixed(2)}%`);
  console.log(`  Avg OOS Sharpe:       ${avgSharpe.toFixed(2)}`);
  console.log(`  Avg OOS Win Rate:     ${avgWinRate.toFixed(1)}%`);
  console.log(`  Worst OOS Drawdown:   -${maxDD.toFixed(2)}%`);
  console.log(`  Best Window:          ${Math.max(...oosReturns).toFixed(2)}%`);
  console.log(`  Worst Window:         ${Math.min(...oosReturns).toFixed(2)}%`);
  console.log(`  Total OOS Trades:     ${allTestTrades.length}`);

  if (allTestTrades.length > 0) {
    const oosWins = allTestTrades.filter(t => t.pnl > 0);
    console.log(`  OOS Win Rate (all):   ${(oosWins.length / allTestTrades.length * 100).toFixed(1)}%`);
  }

  console.log(`  Consistency Ratio:    ${positiveWindows}/${windows.length} (${consistencyRatio.toFixed(0)}%)`);

  // Consistency assessment
  if (consistencyRatio >= 70) {
    console.log(`\n  Assessment: STRONG — Strategy is profitable in ${consistencyRatio.toFixed(0)}% of out-of-sample windows`);
  } else if (consistencyRatio >= 50) {
    console.log(`\n  Assessment: MODERATE — Strategy is profitable in ${consistencyRatio.toFixed(0)}% of out-of-sample windows`);
  } else {
    console.log(`\n  Assessment: WEAK — Strategy is profitable in only ${consistencyRatio.toFixed(0)}% of out-of-sample windows`);
  }

  return { windows: allTestResults, allTestTrades, allTestEquity };
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printResults(metrics) {
  const line = '-'.repeat(50);
  console.log(`\n${'='.repeat(50)}`);
  console.log('  BACKTEST RESULTS');
  console.log(`${'='.repeat(50)}`);

  console.log(`\n  RETURNS`);
  console.log(`  ${line}`);
  console.log(`  Initial Capital:     $${metrics.initialCapital.toLocaleString()}`);
  console.log(`  Final Equity:        $${metrics.finalEquity.toLocaleString()}`);
  console.log(`  Total Return:        ${metrics.totalReturn >= 0 ? '+' : ''}${metrics.totalReturn}%`);
  console.log(`  Annualized Return:   ${metrics.annualizedReturn >= 0 ? '+' : ''}${metrics.annualizedReturn}%`);
  if (metrics.benchmarkReturn !== undefined) {
    console.log(`  SPY Benchmark:       ${metrics.benchmarkReturn >= 0 ? '+' : ''}${metrics.benchmarkReturn}%`);
    console.log(`  Alpha vs SPY:        ${metrics.alpha >= 0 ? '+' : ''}${metrics.alpha}% ${metrics.beatsBenchmark ? '(BEATING)' : '(LAGGING)'}`);
  }

  console.log(`\n  RISK`);
  console.log(`  ${line}`);
  console.log(`  Max Drawdown:        -${metrics.maxDrawdown}%`);
  console.log(`  Max DD Duration:     ${metrics.maxDrawdownDuration} days`);
  console.log(`  Sharpe Ratio:        ${metrics.sharpe}`);
  console.log(`  Sortino Ratio:       ${metrics.sortino}`);
  console.log(`  Calmar Ratio:        ${metrics.calmar}`);

  console.log(`\n  TRADES`);
  console.log(`  ${line}`);
  console.log(`  Total Trades:        ${metrics.totalTrades}`);
  console.log(`  Win Rate:            ${metrics.winRate}%`);
  console.log(`  Profit Factor:       ${metrics.profitFactor}`);
  console.log(`  Avg Win:             +${metrics.avgWinPct}%`);
  console.log(`  Avg Loss:            ${metrics.avgLossPct}%`);
  console.log(`  Avg Holding Period:  ${metrics.avgHoldingDays} days`);
  console.log(`  Best Trade:          ${metrics.bestTrade}`);
  console.log(`  Worst Trade:         ${metrics.worstTrade}`);
  console.log(`  Gross Wins:          $${metrics.grossWins.toLocaleString()}`);
  console.log(`  Gross Losses:        $${metrics.grossLosses.toLocaleString()}`);

  console.log(`\n  EXIT BREAKDOWN`);
  console.log(`  ${line}`);
  for (const [reason, count] of Object.entries(metrics.exitBreakdown)) {
    console.log(`  ${reason.padEnd(22)} ${count}`);
  }

  console.log(`\n  Trading Days:        ${metrics.tradingDays}`);
  console.log(`${'='.repeat(50)}\n`);
}

function saveResults(metrics, equityCurve, closedTrades) {
  const dir = path.join(__dirname, 'trade_history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const resultsFile = path.join(dir, 'backtest_results.json');
  const equityFile  = path.join(dir, 'backtest_equity.json');

  const output = {
    generatedAt: new Date().toISOString(),
    metrics,
    tradeLog: closedTrades,
  };

  fs.writeFileSync(resultsFile, JSON.stringify(output, null, 2));
  fs.writeFileSync(equityFile, JSON.stringify(equityCurve, null, 2));

  console.log(`[Backtester] Results saved to ${resultsFile}`);
  console.log(`[Backtester] Equity curve saved to ${equityFile}`);
  console.log(`[Backtester] Trade log: ${closedTrades.length} trades`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    startDate: null,
    endDate: null,
    capital: 100000,
    walkforward: false,
    trainMonths: 6,
    testMonths: 1,
    advanceMonths: 1,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start':     opts.startDate = args[++i]; break;
      case '--end':       opts.endDate = args[++i]; break;
      case '--capital':   opts.capital = parseFloat(args[++i]); break;
      case '--walkforward': opts.walkforward = true; break;
      case '--train':     opts.trainMonths = parseInt(args[++i]); break;
      case '--test':      opts.testMonths = parseInt(args[++i]); break;
      case '--advance':   opts.advanceMonths = parseInt(args[++i]); break;
    }
  }

  // Defaults: last 2 years
  if (!opts.endDate) {
    opts.endDate = new Date().toISOString().slice(0, 10);
  }
  if (!opts.startDate) {
    const d = new Date(opts.endDate);
    d.setFullYear(d.getFullYear() - 2);
    opts.startDate = d.toISOString().slice(0, 10);
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  console.log(`${'='.repeat(70)}`);
  console.log(`  BACKTESTER — Trading System Historical Simulation`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  Period:   ${opts.startDate} to ${opts.endDate}`);
  console.log(`  Capital:  $${opts.capital.toLocaleString()}`);
  console.log(`  Mode:     ${opts.walkforward ? 'Walk-Forward' : 'Full Backtest'}`);
  console.log(`  Slippage: ${EXIT_SLIPPAGE_PCT}% per trade`);
  console.log(`${'='.repeat(70)}`);

  const startTime = Date.now();

  if (opts.walkforward) {
    const wfResult = await runWalkForward(
      opts.startDate, opts.endDate, opts.capital,
      opts.trainMonths, opts.testMonths, opts.advanceMonths
    );
    // Save walk-forward results
    const dir = path.join(__dirname, 'trade_history');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'backtest_results.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'walkforward', windows: wfResult.windows, tradeLog: wfResult.allTestTrades }, null, 2)
    );
    fs.writeFileSync(
      path.join(dir, 'backtest_equity.json'),
      JSON.stringify(wfResult.allTestEquity, null, 2)
    );
    console.log(`\n[Backtester] Walk-forward results saved to trade_history/`);
  } else {
    const result = await runBacktest(opts.startDate, opts.endDate, opts.capital);
    const metrics = addBenchmarkMetrics(computeMetrics(result.equityCurve, result.closedTrades, result.initialCapital), result.benchmarkReturn);
    printResults(metrics);
    saveResults(metrics, equityCurve, closedTrades);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Backtester] Done in ${elapsed}s`);
}

main().catch(err => {
  console.error('[Backtester] Fatal error:', err);
  process.exit(1);
});
