/**
 * Aggressive Trading Engine — Momentum-Based Fast Execution
 *
 * Runs alongside the main engine with 10% of capital.
 * Separate position tracking, faster exits, lower entry bar.
 *
 * Key differences from main engine:
 *   - 10% of total equity allocation
 *   - 12.5% per position (of aggressive allocation, ~$1,250 on $10K)
 *   - Lower buy threshold (50 vs 65)
 *   - Tight stops: 4% hard stop, 6% trail, 15% profit target
 *   - Max 48-hour hold time
 *   - 4-hour cooldown (vs 24h)
 *   - NO earnings guard (wants catalysts)
 *   - NO correlation check (positions too small/short-lived)
 */

const fs   = require('fs');
const path = require('path');
const { logTrade }           = require('./logger');
const { evaluateAggressiveTrade, recordAggressiveExecuted, updatePeakEquity } = require('./governor');
const { isSystemHealthy }    = require('./signal_cache');
const { isStrategyKilled }   = require('./strategy_calibrator');
const { criticalAlert, warningAlert, infoAlert } = require('./alerts');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key,...rest]=line.split('='); if(key&&rest.length) process.env[key.trim()]=rest.join('=').trim();
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;

// ─── Aggressive Parameters ──────────────────────────────────────────────────
const AGGRESSIVE_ALLOCATION = 0.10;  // 10% of total equity
const POSITION_PCT   = 0.125;        // 12.5% of aggressive allocation per trade (~$1,250 on $10K)
const MAX_POSITIONS  = 8;
const BUY_THRESHOLD  = 50;           // Lower bar — accept more signals
const PROFIT_TARGET  = 15;           // Take profits at +15%
const HARD_STOP      = 4;            // Cut losers fast at -4%
const TRAIL_PERCENT  = 6;
const MAX_HOLD_HOURS = 48;           // Exit after 2 days max
const COOLDOWN_HOURS = 4;            // Much shorter cooldown

const STATE_FILE = path.join(__dirname, 'trade_history/aggressive_state.json');

// Lazy-load database to avoid circular deps
let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./database'); } catch { _db = false; }
  }
  return _db || null;
}

// ─── State persistence ──────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) try { return JSON.parse(fs.readFileSync(STATE_FILE)); } catch {}
  return { stoppedOut: {}, aggressivePositions: {}, positionSources: {} };
}

function saveState(s) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function isOnCooldown(ticker, state) {
  const ts = state.stoppedOut?.[ticker];
  return ts && (Date.now() - new Date(ts).getTime()) / 3600000 < COOLDOWN_HOURS;
}

// ─── Alpaca helpers ─────────────────────────────────────────────────────────
async function alpaca(method, endpoint, body) {
  const res = await fetch(`${ALPACA_URL}/v2${endpoint}`, {
    method,
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function getAccount()       { return alpaca('GET', '/account'); }
async function getOpenPositions() { const p = await alpaca('GET', '/positions'); return Array.isArray(p) ? p : []; }
async function getOpenOrders()    { const o = await alpaca('GET', '/orders?status=open'); return Array.isArray(o) ? o : []; }

// ─── Equity calculation ─────────────────────────────────────────────────────
function calcAggressiveEquity(totalEquity) {
  return totalEquity * AGGRESSIVE_ALLOCATION;
}

// ─── Position sizing ────────────────────────────────────────────────────────
async function calcQty(ticker, aggressiveEquity) {
  try {
    const { getBars, closes } = require('./data/prices');
    const bars  = await getBars(ticker, 5);
    const price = closes(bars).slice(-1)[0];
    const positionValue = aggressiveEquity * POSITION_PCT;
    const qty = Math.floor(positionValue / price);
    console.log(`  [Aggressive][SIZE] ${ticker}: $${positionValue.toFixed(0)} / $${price.toFixed(2)} = ${qty} shares`);
    return Math.max(1, qty);
  } catch { return 1; }
}

// ─── Order idempotency ──────────────────────────────────────────────────────
const recentOrders = new Map();
const IDEMPOTENCY_WINDOW_MS = 60000;

function isRecentDuplicate(ticker) {
  const last = recentOrders.get(ticker);
  return last && Date.now() - last < IDEMPOTENCY_WINDOW_MS;
}

async function checkAlpacaDuplicate(ticker) {
  try {
    const recent = await alpaca('GET', `/orders?status=open&symbols=${ticker}&limit=5`);
    if (Array.isArray(recent) && recent.some(o => o.side === 'buy' && Date.now() - new Date(o.submitted_at).getTime() < IDEMPOTENCY_WINDOW_MS)) {
      console.log(`  [Aggressive][IDEMPOTENT] ${ticker}: buy order already submitted — skipping`);
      return true;
    }
  } catch {}
  return false;
}

// ─── Buy order placement ────────────────────────────────────────────────────
async function placeBuy(ticker, reason, aggressiveEquity) {
  if (isRecentDuplicate(ticker)) {
    console.log(`  [Aggressive][IDEMPOTENT] ${ticker}: duplicate buy blocked (local cache)`);
    return null;
  }
  if (await checkAlpacaDuplicate(ticker)) return null;

  const qty = await calcQty(ticker, aggressiveEquity);
  const order = await alpaca('POST', '/orders', { symbol: ticker, qty: String(qty), side: 'buy', type: 'market', time_in_force: 'day' });
  if (!order.id) { console.error(`  [Aggressive][BUY FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  recentOrders.set(ticker, Date.now());
  logTrade({ ...order, engine_reason: `AGGRESSIVE: ${reason}` });
  console.log(`  [Aggressive][BUY] ${ticker} x${qty} — ${reason}`);

  // Poll for fill (market orders fill nearly instantly)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const filled = await alpaca('GET', `/orders/${order.id}`);
      if (filled.filled_avg_price && parseFloat(filled.filled_avg_price) > 0) {
        console.log(`  [Aggressive][FILL] ${ticker}: $${filled.filled_avg_price} x${filled.filled_qty}`);
        break;
      }
      if (filled.status === 'canceled' || filled.status === 'expired' || filled.status === 'rejected') break;
    }
  } catch (e) { console.warn(`  [Aggressive][FILL POLL] ${ticker}: ${e.message}`); }

  return order;
}

// ─── Trailing stop placement ────────────────────────────────────────────────
async function placeTrailingStop(ticker, qty, trailPct) {
  const trail = trailPct || TRAIL_PERCENT;
  const order = await alpaca('POST', '/orders', { symbol: ticker, qty: String(qty), side: 'sell', type: 'trailing_stop', trail_percent: String(trail), time_in_force: 'gtc' });
  if (!order.id) { console.error(`  [Aggressive][TRAIL STOP FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  logTrade({ ...order, engine_reason: `AGGRESSIVE: Trailing stop ${trail}% from peak` });
  console.log(`  [Aggressive][TRAIL STOP] ${ticker} — ${trail}% trail placed`);
  return order;
}

async function hasTrailingStop(ticker, openOrders) {
  return openOrders.some(o => o.symbol === ticker && o.side === 'sell' && (o.type === 'trailing_stop' || o.type === 'stop'));
}

// ─── Detect stop-outs for cooldown ──────────────────────────────────────────
async function detectStopOuts(state) {
  const orders = await alpaca('GET', '/orders?status=closed&limit=50').catch(() => []);
  if (!Array.isArray(orders)) return;
  for (const o of orders) {
    if ((o.type === 'trailing_stop' || o.type === 'stop') && o.status === 'filled' && o.side === 'sell') {
      const t = o.symbol;
      // Only track if this is one of our aggressive positions
      if (!state.aggressivePositions?.[t]) continue;
      if (!state.stoppedOut?.[t] || new Date(o.filled_at) > new Date(state.stoppedOut[t])) {
        if (!state.stoppedOut) state.stoppedOut = {};
        state.stoppedOut[t] = o.filled_at;
        console.log(`  [Aggressive][STOP HIT] ${t} stopped out — cooldown ${COOLDOWN_HOURS}h`);
      }
    }
  }
}

// ─── Check max hold time ────────────────────────────────────────────────────
function isHoldExpired(entryTime) {
  if (!entryTime) return false;
  const holdMs = Date.now() - new Date(entryTime).getTime();
  return holdMs / 3600000 >= MAX_HOLD_HOURS;
}

// ─── Main Aggressive Trade Cycle ────────────────────────────────────────────
async function runAggressiveCycle(getCandidatesFn) {
  const now = new Date().toISOString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[Aggressive] Trade cycle: ${now}`);
  const state = loadState();

  try {
    const account = await getAccount();
    if (account.trading_blocked) { console.warn('[Aggressive] Trading blocked.'); return; }

    // System health check
    if (!isSystemHealthy()) {
      console.warn('[Aggressive] System degraded — managing exits only, no new buys');
    }

    const totalEquity = parseFloat(account.equity);
    const aggressiveEquity = calcAggressiveEquity(totalEquity);
    console.log(`[Aggressive] Total equity: $${totalEquity.toLocaleString()} | Aggressive allocation (10%): $${aggressiveEquity.toLocaleString()}`);

    // Governor: track peak equity
    updatePeakEquity(totalEquity);

    await detectStopOuts(state);

    const [positions, openOrders] = await Promise.all([getOpenPositions(), getOpenOrders()]);

    // Identify aggressive positions (tagged in our state)
    if (!state.aggressivePositions) state.aggressivePositions = {};
    const aggressivePositions = positions.filter(p => state.aggressivePositions[p.symbol]);
    const allTickers = new Set(positions.map(p => p.symbol));

    console.log(`[Aggressive] Aggressive positions: ${aggressivePositions.length}/${MAX_POSITIONS} | All positions: ${positions.length}`);

    // ── Manage existing aggressive positions ────────────────────────────────
    for (const pos of aggressivePositions) {
      const ticker = pos.symbol;
      const entry  = parseFloat(pos.avg_entry_price);
      const pnlPct = parseFloat(pos.unrealized_plpc) * 100;
      const entryTime = state.aggressivePositions[ticker]?.entryTime;
      const qty = parseInt(pos.qty);

      console.log(`  [Aggressive] ${ticker.padEnd(6)} entry=$${entry.toFixed(2)} P&L=${pnlPct.toFixed(2)}% hold=${entryTime ? Math.round((Date.now() - new Date(entryTime).getTime()) / 3600000) + 'h' : '?'}`);

      // 1. Max hold time exit (48 hours)
      if (isHoldExpired(entryTime)) {
        const sell = await alpaca('POST', '/orders', { symbol: ticker, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day' });
        if (sell && sell.id) {
          logTrade({ ...sell, engine_reason: `AGGRESSIVE: Max hold ${MAX_HOLD_HOURS}h expired (P&L: ${pnlPct.toFixed(2)}%)` });
          console.log(`  [Aggressive][TIME EXIT] ${ticker} — held ${MAX_HOLD_HOURS}h+, P&L: ${pnlPct.toFixed(2)}%`);
          infoAlert('Aggressive Time Exit', `${ticker}: max hold ${MAX_HOLD_HOURS}h expired at ${pnlPct.toFixed(2)}%`, { ticker, pnlPct: pnlPct.toFixed(2) + '%' });
          delete state.aggressivePositions[ticker];
          if (state.positionSources) delete state.positionSources[ticker];
        }
        continue;
      }

      // 2. Profit target (+15%)
      if (pnlPct >= PROFIT_TARGET) {
        const sell = await alpaca('POST', '/orders', { symbol: ticker, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day' });
        if (sell && sell.id) {
          logTrade({ ...sell, engine_reason: `AGGRESSIVE: Profit target +${PROFIT_TARGET}%: +${pnlPct.toFixed(2)}%` });
          console.log(`  [Aggressive][PROFIT] ${ticker} +${pnlPct.toFixed(2)}% (target=${PROFIT_TARGET}%)`);
          infoAlert('Aggressive Profit Target', `${ticker}: hit +${pnlPct.toFixed(2)}%`, { ticker, pnlPct: '+' + pnlPct.toFixed(2) + '%' });
          delete state.aggressivePositions[ticker];
          if (state.positionSources) delete state.positionSources[ticker];
        }
        continue;
      }

      // 3. Hard stop (-4%)
      if (pnlPct <= -HARD_STOP) {
        const sell = await alpaca('POST', '/orders', { symbol: ticker, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day' });
        if (sell && sell.id) {
          logTrade({ ...sell, engine_reason: `AGGRESSIVE: Hard stop -${HARD_STOP}%: ${pnlPct.toFixed(2)}%` });
          console.log(`  [Aggressive][HARD STOP] ${ticker} ${pnlPct.toFixed(2)}% (stop=-${HARD_STOP}%)`);
          warningAlert('Aggressive Hard Stop', `${ticker}: stopped at ${pnlPct.toFixed(2)}%`, { ticker, pnlPct: pnlPct.toFixed(2) + '%' });
          if (!state.stoppedOut) state.stoppedOut = {};
          state.stoppedOut[ticker] = now;
          delete state.aggressivePositions[ticker];
          if (state.positionSources) delete state.positionSources[ticker];
        }
        continue;
      }

      // 4. Trailing stop placement
      if (!(await hasTrailingStop(ticker, openOrders))) {
        await placeTrailingStop(ticker, qty, TRAIL_PERCENT);
      }
    }

    // ── System kill — skip buy logic if data is degraded ────────────────────
    if (!isSystemHealthy()) {
      saveState(state);
      console.log('[Aggressive] Cycle complete — exits managed, no new trades (system kill)');
      return;
    }

    // ── New buy candidates ──────────────────────────────────────────────────
    const ranked = await getCandidatesFn();
    const candidates = ranked.filter(t => t.netScore >= BUY_THRESHOLD);

    const openTickers = new Set(positions.map(p => p.symbol));
    const shortTickers = new Set(positions.filter(p => parseFloat(p.qty) < 0).map(p => p.symbol));

    // Check how much of aggressive allocation is deployed
    const aggressiveInvested = aggressivePositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
    console.log(`[Aggressive] Deployed: $${aggressiveInvested.toLocaleString()} / $${aggressiveEquity.toLocaleString()} (${(aggressiveInvested / aggressiveEquity * 100).toFixed(1)}%)`);

    const slots = MAX_POSITIONS - aggressivePositions.length;
    if (slots <= 0) {
      console.log('[Aggressive] Max aggressive positions reached.');
      saveState(state);
      return;
    }

    const ACTIVE_BUY_STATES = new Set(['pending_new', 'new', 'accepted', 'partially_filled', 'pending_cancel', 'pending_replace', 'held', 'calculated']);
    const pendingBuys = new Set(openOrders.filter(o => o.side === 'buy' && ACTIVE_BUY_STATES.has(o.status)).map(o => o.symbol));

    const toTrade = candidates
      .filter(c => !openTickers.has(c.ticker) && !shortTickers.has(c.ticker) && !pendingBuys.has(c.ticker) && !isOnCooldown(c.ticker, state))
      .slice(0, slots);

    if (toTrade.length === 0) console.log('[Aggressive] No new aggressive buy candidates this cycle.');

    let newTrades = 0;
    const boughtThisCycle = new Set();

    for (const c of toTrade) {
      if (boughtThisCycle.has(c.ticker)) continue;

      const top = c.signals.sort((a, b) => b.score - a.score)[0];

      // Check if strategy killed by calibrator
      if (top && isStrategyKilled(top.source)) {
        console.log(`  [Aggressive][SKIP] ${c.ticker} — strategy '${top.source}' killed by calibrator`);
        continue;
      }

      // Governor evaluation (aggressive-specific: no sector, no correlation, no earnings)
      const govResult = await evaluateAggressiveTrade(c.ticker, totalEquity, positions);
      if (!govResult.approved) {
        for (const r of govResult.reasons) console.log(`  [Aggressive][GOV BLOCK] ${c.ticker} — ${r}`);
        continue;
      }

      // NO earnings guard — aggressive engine wants catalysts
      // NO correlation check — positions too small and short-lived
      // NO Monte Carlo risk assessment — positions are small enough

      const reason = `Score ${c.netScore}/100 [${c.sources.join('+')}] | ${top.reason}`;
      const order = await placeBuy(c.ticker, reason, aggressiveEquity);

      if (order && order.id) {
        newTrades++;
        boughtThisCycle.add(c.ticker);
        recordAggressiveExecuted();

        // Track in aggressive state
        state.aggressivePositions[c.ticker] = {
          entryTime: now,
          source: top?.source || 'unknown',
          score: c.netScore,
          orderId: order.id,
        };
        if (!state.positionSources) state.positionSources = {};
        state.positionSources[c.ticker] = top?.source || 'unknown';

        console.log(`  [Aggressive][EXIT PROFILE] ${c.ticker}: stop=${HARD_STOP}%, trail=${TRAIL_PERCENT}%, target=${PROFIT_TARGET}%, maxHold=${MAX_HOLD_HOURS}h`);
      } else {
        console.log(`  [Aggressive][BUY FAILED] ${c.ticker} — order rejected`);
      }
    }

    saveState(state);
    console.log(`[Aggressive] Cycle complete — new trades: ${newTrades}, total aggressive positions: ${aggressivePositions.length + newTrades}`);

    // Write intraday equity snapshot for aggressive P&L chart
    try {
      const unrealizedPnl = aggressivePositions.reduce((s, p) => s + parseFloat(p.unrealized_pl || 0), 0);
      const snapshot = {
        ts: Date.now(),
        equity: aggressiveEquity,
        deployed: aggressiveInvested,
        pnl: unrealizedPnl,
        positions: aggressivePositions.length + newTrades,
      };
      const snapshotDir = path.join(__dirname, 'trade_history');
      if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
      fs.appendFileSync(path.join(snapshotDir, 'aggressive_equity.jsonl'), JSON.stringify(snapshot) + '\n');
    } catch (snapErr) {
      console.warn('[Aggressive] Failed to write equity snapshot:', snapErr.message);
    }
  } catch (err) {
    console.error('[Aggressive] Cycle error:', err.message);
    saveState(state);
  }
}

module.exports = { runAggressiveCycle };
