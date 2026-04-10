const fs   = require('fs');
const path = require('path');
const { logTrade }           = require('./logger');
const { assessPositionRisk, assessShortRisk } = require('./strategies/montecarlo');
const { isEarningsBlock }    = require('./monitors/earnings_guard');
const { evaluateTrade, reconcileStops, recordTradeExecuted, updatePeakEquity, evaluateShortTrade, recordShortExecuted } = require('./governor');
const { processClosedTrades } = require('./postmortem');
const { tracker } = require('./signal_lifecycle');
const { isSystemHealthy } = require('./signal_cache');
const { isStrategyKilled } = require('./strategy_calibrator');
const { criticalAlert, warningAlert, infoAlert } = require('./alerts');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key,...rest]=line.split('='); if(key&&rest.length) process.env[key.trim()]=rest.join('=').trim();
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;

const MAX_POSITIONS  = 20;
const POSITION_PCT   = 0.08;
const MAX_EXPOSURE   = 0.96;
const COOLDOWN_HOURS = 24;
const BUY_THRESHOLD  = 65;

// ─── Strategy-specific exit templates ────────────────────────────────────────
// Mean reversion needs wider stops and no fixed profit target (let trail handle it)
// Trend-following needs moderate stops and room to run
// Relative value uses tighter stops with a fixed profit target
const EXIT_PROFILES = {
  mean_reversion: { hardStop: 10, trail: 8, profitTarget: null,  label: 'mean-reversion' },  // downtrend, bollinger
  trend:          { hardStop: 8,  trail: 6, profitTarget: null,  label: 'trend' },            // ma_crossover
  relative_value: { hardStop: 6,  trail: 5, profitTarget: 10,    label: 'relative-value' },   // relative_value
  default:        { hardStop: 8,  trail: 6, profitTarget: 12,    label: 'default' },           // insider, techsector, etc
};

const SOURCE_TO_PROFILE = {
  downtrend: 'mean_reversion', bollinger: 'mean_reversion',
  ma_crossover: 'trend',
  relative_value: 'relative_value',
};

function getExitProfile(source) {
  return EXIT_PROFILES[SOURCE_TO_PROFILE[source] || 'default'];
}

// Legacy constants kept as absolute maximums
const TRAIL_PERCENT  = 8;     // max trailing stop (used for overnight placement)
const HARD_STOP_PCT  = 10;    // absolute max hard stop
const PROFIT_TARGET  = 12;    // absolute max profit target

const STATE_FILE = path.join(__dirname, 'trade_history/engine_state.json');

// Lazy-load database to avoid circular deps
let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./database'); } catch { _db = false; }
  }
  return _db || null;
}

function loadState() {
  // Try database first (primary source of truth)
  try {
    const db = getDb();
    if (db) {
      const dbState = db.getEngineState();
      if (dbState && Object.keys(dbState).length > 0) {
        return { stoppedOut: dbState.stoppedOut || {}, ...dbState };
      }
    }
  } catch (err) {
    // Fall through to JSON
  }

  // Fallback to JSON
  if (fs.existsSync(STATE_FILE)) try { return JSON.parse(fs.readFileSync(STATE_FILE)); } catch {}
  return { stoppedOut:{} };
}
function saveState(s) {
  // Save to JSON (backup / transition)
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2));

  // Also persist to SQLite database
  try {
    const db = getDb();
    if (db) db.saveEngineState(s);
  } catch (err) {
    // JSON already saved as backup
  }
}
function isOnCooldown(ticker, state) {
  const ts = state.stoppedOut?.[ticker];
  return ts && (Date.now()-new Date(ts).getTime())/(3600000) < COOLDOWN_HOURS;
}

async function alpaca(method, endpoint, body) {
  const res = await fetch(`${ALPACA_URL}/v2${endpoint}`, {
    method, headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET,'Content-Type':'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function getAccount()       { return alpaca('GET','/account'); }
async function getOpenPositions() { const p=await alpaca('GET','/positions'); return Array.isArray(p)?p:[]; }
async function getOpenOrders()    { const o=await alpaca('GET','/orders?status=open'); return Array.isArray(o)?o:[]; }

async function getVolatilityAdjustedSize(ticker, baseSize) {
  const BASELINE_VOL = 0.25; // 25% — typical S&P 500 stock annualized vol
  const MIN_SIZE = 0.02;     // 2% floor
  const MAX_SIZE = 0.12;     // 12% ceiling
  try {
    const { getBars, closes, returns } = require('./data/prices');
    const bars = await getBars(ticker, 60);
    const cls  = closes(bars);
    const rets = returns(cls);
    // Use last 30 daily returns for realized vol
    const recentRets = rets.slice(-30);
    if (recentRets.length < 20) return baseSize; // not enough data, return base
    const mean = recentRets.reduce((a, b) => a + b, 0) / recentRets.length;
    const variance = recentRets.reduce((s, r) => s + (r - mean) ** 2, 0) / recentRets.length;
    const dailyVol = Math.sqrt(variance);
    const realizedVol = dailyVol * Math.sqrt(252); // annualize
    // Scale inversely to volatility
    const adjusted = baseSize * (BASELINE_VOL / Math.max(realizedVol, 0.01));
    const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, adjusted));
    console.log(`  [SIZE] ${ticker}: base=${(baseSize*100).toFixed(1)}%, vol-adjusted=${(clamped*100).toFixed(1)}%, vol=${(realizedVol*100).toFixed(1)}%`);
    return clamped;
  } catch (e) {
    console.warn(`  [SIZE] ${ticker}: vol-adjust failed (${e.message}), using base=${(baseSize*100).toFixed(1)}%`);
    return baseSize;
  }
}

async function getATRStop(ticker, multiplier = 2.0) {
  const MIN_STOP = 3;  // 3% minimum stop distance
  const MAX_STOP = 10; // 10% maximum stop distance
  try {
    const { getBars } = require('./data/prices');
    const bars = await getBars(ticker, 20);
    if (bars.length < 14) return HARD_STOP_PCT; // fallback
    // Calculate 14-day ATR
    const atrBars = bars.slice(-14);
    let atrSum = 0;
    for (let i = 0; i < atrBars.length; i++) {
      const high = atrBars[i].h;
      const low  = atrBars[i].l;
      const prevClose = i === 0 ? atrBars[i].o : atrBars[i - 1].c; // use open for first bar
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      atrSum += tr;
    }
    const atr = atrSum / atrBars.length;
    const currentPrice = atrBars[atrBars.length - 1].c;
    const stopPct = (atr * multiplier) / currentPrice * 100;
    const clamped = Math.max(MIN_STOP, Math.min(MAX_STOP, stopPct));
    return clamped;
  } catch (e) {
    console.warn(`  [STOP] ${ticker}: ATR calc failed (${e.message}), using hard stop=${HARD_STOP_PCT}%`);
    return HARD_STOP_PCT;
  }
}

async function calcQty(ticker, equity, riskMaxPct) {
  try {
    const { getBars, closes } = require('./data/prices');
    const bars  = await getBars(ticker, 5);
    const price = closes(bars).slice(-1)[0];
    // Get volatility-adjusted position size
    const volAdjustedSize = await getVolatilityAdjustedSize(ticker, POSITION_PCT);
    // Use the lesser of vol-adjusted size and Monte Carlo's suggested max pct
    const effectivePct = riskMaxPct ? Math.min(volAdjustedSize, riskMaxPct / 100) : volAdjustedSize;
    const qty   = Math.floor((equity * effectivePct) / price);
    if (effectivePct < volAdjustedSize) console.log(`  [SIZE] ${ticker}: Monte Carlo capped to ${(effectivePct*100).toFixed(1)}% (was ${(volAdjustedSize*100).toFixed(1)}%)`);
    return Math.max(1, qty);
  } catch { return 1; }
}

// ─── Order idempotency: prevent duplicate orders within 60s window ──────────
const recentOrders = new Map(); // ticker → timestamp
const IDEMPOTENCY_WINDOW_MS = 60000;

function isRecentDuplicate(ticker) {
  const last = recentOrders.get(ticker);
  if (last && Date.now() - last < IDEMPOTENCY_WINDOW_MS) return true;
  // Also check Alpaca for recent orders on this ticker
  return false;
}

async function checkAlpacaDuplicate(ticker) {
  try {
    const recent = await alpaca('GET', `/orders?status=open&symbols=${ticker}&limit=5`);
    if (Array.isArray(recent) && recent.some(o => o.side === 'buy' && Date.now() - new Date(o.submitted_at).getTime() < IDEMPOTENCY_WINDOW_MS)) {
      console.log(`  [IDEMPOTENT] ${ticker}: buy order already submitted within ${IDEMPOTENCY_WINDOW_MS/1000}s — skipping`);
      return true;
    }
  } catch {}
  return false;
}

async function placeBuy(ticker, reason, equity, riskMaxPct) {
  // Idempotency guard: check both local cache and Alpaca
  if (isRecentDuplicate(ticker)) {
    console.log(`  [IDEMPOTENT] ${ticker}: duplicate buy blocked (local cache)`);
    return null;
  }
  if (await checkAlpacaDuplicate(ticker)) return null;

  const qty   = await calcQty(ticker, equity, riskMaxPct);
  const order = await alpaca('POST','/orders',{ symbol:ticker, qty:String(qty), side:'buy', type:'market', time_in_force:'day' });
  if (!order.id) { console.error(`  [BUY FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  recentOrders.set(ticker, Date.now()); // mark as recently ordered
  logTrade({...order, engine_reason:reason});
  console.log(`  [BUY]  ${ticker} x${qty} — ${reason}`);

  // Await fill resolution (market orders fill nearly instantly, 6s max wait)
  try { await pollForFill(order.id, ticker, reason); }
  catch (e) { console.warn(`  [FILL POLL] ${ticker}: ${e.message} — entry price may be unresolved`); }

  return order;
}

async function pollForFill(orderId, ticker, reason) {
  const HISTORY_DIR = path.join(__dirname, 'trade_history');
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(r => setTimeout(r, 2000)); // wait 2s between attempts
    const filled = await alpaca('GET', `/orders/${orderId}`);
    if (filled.filled_avg_price && parseFloat(filled.filled_avg_price) > 0) {
      // Update the logged JSON file with fill data
      const date = new Date(filled.submitted_at || Date.now()).toISOString().slice(0, 10);
      const jsonFile = path.join(HISTORY_DIR, `${date}_${ticker}_buy_${orderId.slice(0,8)}.json`);
      try {
        if (fs.existsSync(jsonFile)) {
          const data = JSON.parse(fs.readFileSync(jsonFile));
          data.filled_avg_price = filled.filled_avg_price;
          data.filled_qty = filled.filled_qty;
          data.filled_at = filled.filled_at;
          data.status = filled.status;
          fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2));
          console.log(`  [FILL] ${ticker}: $${filled.filled_avg_price} x${filled.filled_qty} — logged`);
        }
      } catch {}
      return;
    }
    if (filled.status === 'canceled' || filled.status === 'expired' || filled.status === 'rejected') return;
  }
}

async function placeTrailingStop(ticker, qty, entryPrice, trailPct) {
  const trail = trailPct || TRAIL_PERCENT;
  const order = await alpaca('POST','/orders',{ symbol:ticker, qty:String(qty), side:'sell', type:'trailing_stop', trail_percent:String(trail), time_in_force:'gtc' });
  if (!order.id) { console.error(`  [TRAIL STOP FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  logTrade({...order, engine_reason:`Trailing stop ${trail}% from peak`});
  console.log(`  [TRAIL STOP] ${ticker} — ${trail}% trail placed`);
  return order;
}

async function hasTrailingStop(ticker, openOrders) {
  return openOrders.some(o=>o.symbol===ticker&&o.side==='sell'&&(o.type==='trailing_stop'||o.type==='stop'));
}

async function detectStopOuts(state) {
  const orders = await alpaca('GET','/orders?status=closed&limit=50').catch(()=>[]);
  if (!Array.isArray(orders)) return;
  for (const o of orders) {
    if ((o.type==='trailing_stop'||o.type==='stop')&&o.status==='filled'&&o.side==='sell') {
      const t = o.symbol;
      if (!state.stoppedOut?.[t]||new Date(o.filled_at)>new Date(state.stoppedOut[t])) {
        if (!state.stoppedOut) state.stoppedOut={};
        state.stoppedOut[t]=o.filled_at;
        console.log(`  [STOP HIT] ${t} stopped out — cooldown ${COOLDOWN_HOURS}h`);
      }
    }
  }
}

async function placeOvernightTrailingStops() {
  const state = loadState();
  const [positions, openOrders] = await Promise.all([getOpenPositions(),getOpenOrders()]);
  let placed=0;
  for (const pos of positions) {
    if (await hasTrailingStop(pos.symbol,openOrders)) continue;
    const source = state.positionSources?.[pos.symbol] || 'unknown';
    const profile = getExitProfile(source);
    await placeTrailingStop(pos.symbol, pos.qty, parseFloat(pos.avg_entry_price), profile.trail);
    placed++;
    await new Promise(r=>setTimeout(r,300));
  }
  console.log(`[Engine] Overnight trailing stops placed: ${placed}`);
}

async function runTradeCycle(getCandidatesFn) {
  const now   = new Date().toISOString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[Engine] Trade cycle: ${now}`);
  const state = loadState();
  try {
    const account = await getAccount();
    if (account.trading_blocked) { console.warn('[Engine] Trading blocked.'); return; }

    // System health check — halt new trades if too many data sources failing
    if (!isSystemHealthy()) {
      console.warn('[Engine] ⚠ SYSTEM KILL: Data sources degraded — managing stops only, no new buys');
    }
    const equity  = parseFloat(account.equity);
    const buyPow  = parseFloat(account.buying_power);
    console.log(`[Engine] Equity: $${equity.toLocaleString()} | Buying power: $${buyPow.toLocaleString()}`);

    // Governor: track peak equity + drawdown
    const peak = updatePeakEquity(equity);
    const ddPct = ((peak - equity) / peak * 100).toFixed(2);
    console.log(`[Engine] Peak: $${peak.toLocaleString()} | Drawdown: -${ddPct}%`);

    await detectStopOuts(state);

    // Postmortem: analyze any newly closed trades
    const closedOrders = await alpaca('GET', '/orders?status=closed&limit=50').catch(() => []);
    if (Array.isArray(closedOrders)) await processClosedTrades(closedOrders);

    const [positions, openOrders] = await Promise.all([getOpenPositions(),getOpenOrders()]);
    console.log(`[Engine] Positions: ${positions.length} | Open orders: ${openOrders.length}`);

    // Governor: reconcile stops every cycle
    await reconcileStops(positions, openOrders);

    for (const pos of positions) {
      // Short positions are managed by runShortCycle — skip in long exit loop
      if (parseFloat(pos.qty) < 0) continue;

      const ticker   = pos.symbol;
      const entry    = parseFloat(pos.avg_entry_price);
      const pnlPct   = parseFloat(pos.unrealized_plpc)*100;

      // Get strategy-specific exit profile
      const source  = state.positionSources?.[ticker] || 'unknown';
      const profile = getExitProfile(source);
      console.log(`  ${ticker.padEnd(6)} entry=$${entry.toFixed(2)} P&L=${pnlPct.toFixed(2)}% [${profile.label}]`);

      // Profit target — only if the profile has one (mean reversion and trend use trail instead)
      if (profile.profitTarget && pnlPct >= profile.profitTarget) {
        const sell = await alpaca('POST','/orders',{symbol:ticker,qty:pos.qty,side:'sell',type:'market',time_in_force:'day'});
        if (sell.id) { logTrade({...sell,engine_reason:`Profit target (${profile.label}): +${pnlPct.toFixed(2)}%`}); console.log(`  [PROFIT TAKE] ${ticker} +${pnlPct.toFixed(2)}% (${profile.label} target=${profile.profitTarget}%)`); infoAlert('Profit Target Hit', `${ticker} hit +${pnlPct.toFixed(2)}%`, { ticker, pnlPct: '+' + pnlPct.toFixed(2) + '%', target: profile.profitTarget + '%', profile: profile.label }); }
        if (state.positionSources) delete state.positionSources[ticker];
        continue;
      }

      // Hard stop — strategy-specific, with ATR adjustment
      const atrStop = await getATRStop(ticker);
      const effectiveStop = Math.min(atrStop, profile.hardStop);
      console.log(`  [STOP] ${ticker}: ATR=${atrStop.toFixed(1)}%, profile-max=${profile.hardStop}%, effective=${effectiveStop.toFixed(1)}%`);
      if (pnlPct <= -effectiveStop) {
        const sell = await alpaca('POST','/orders',{symbol:ticker,qty:pos.qty,side:'sell',type:'market',time_in_force:'day'});
        if (sell.id) { logTrade({...sell,engine_reason:`Stop (${profile.label}, ATR=${atrStop.toFixed(1)}%): ${pnlPct.toFixed(2)}%`}); console.log(`  [HARD STOP] ${ticker} at ${effectiveStop.toFixed(1)}% (${profile.label})`); warningAlert('Hard Stop Hit', `${ticker} stopped out at ${pnlPct.toFixed(2)}%`, { ticker, pnlPct: pnlPct.toFixed(2) + '%', stopLevel: effectiveStop.toFixed(1) + '%', profile: profile.label }); if(!state.stoppedOut)state.stoppedOut={}; state.stoppedOut[ticker]=now; }
        if (state.positionSources) delete state.positionSources[ticker];
        continue;
      }

      const openedToday = new Date(pos.created_at||0).toDateString()===new Date().toDateString();
      if (!(await hasTrailingStop(ticker,openOrders))) {
        if (openedToday) console.log(`  [SKIP TRAIL] ${ticker} — opened today, will place tonight`);
        else await placeTrailingStop(ticker, pos.qty, entry, profile.trail);
      }
    }

    // Reset lifecycle tracker for this cycle
    tracker.reset();

    // System kill — skip buy logic entirely if data is degraded
    if (!isSystemHealthy()) {
      saveState(state);
      console.log('[Engine] Cycle complete — stops managed, no new trades (system kill)');
      return;
    }

    const ranked    = await getCandidatesFn();
    const candidates = ranked.filter(t=>t.netScore>=BUY_THRESHOLD);
    // Exclude any ticker we are currently short on (don't go long while short)
    const shortTickers = new Set(positions.filter(p => parseFloat(p.qty) < 0).map(p => p.symbol));
    const openTickers = new Set(positions.map(p=>p.symbol));
    // Long-only positions for slot counting
    const longPositions = positions.filter(p => parseFloat(p.qty) > 0);

    // Check long exposure — stop buying once 96% deployed (long side only)
    const totalInvested = longPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
    const exposurePct = totalInvested / equity;
    console.log(`[Engine] Long exposure: $${totalInvested.toLocaleString()} / $${equity.toLocaleString()} = ${(exposurePct * 100).toFixed(1)}% | Shorts: ${shortTickers.size}`);
    if (exposurePct >= MAX_EXPOSURE) { console.log(`[Engine] Target exposure reached (${(exposurePct*100).toFixed(1)}% >= ${MAX_EXPOSURE*100}%).`); saveState(state); tracker.logCycle(equity, positions.length); return; }

    const slots = MAX_POSITIONS - longPositions.length;
    if (slots <= 0) { console.log('[Engine] Max positions reached.'); saveState(state); tracker.logCycle(equity, positions.length); return; }

    const ACTIVE_BUY_STATES = new Set(['pending_new','new','accepted','partially_filled','pending_cancel','pending_replace','held','calculated']);
    const pendingBuys = new Set(openOrders.filter(o=>o.side==='buy'&&ACTIVE_BUY_STATES.has(o.status)).map(o=>o.symbol));
    const toTrade = candidates.filter(c=>!openTickers.has(c.ticker)&&!shortTickers.has(c.ticker)&&!pendingBuys.has(c.ticker)&&!isOnCooldown(c.ticker,state)).slice(0,slots);
    if (toTrade.length===0) console.log('[Engine] No new buy candidates this cycle.');

    // Register all candidates in lifecycle tracker
    for (const c of toTrade) {
      const top = c.signals.sort((a,b)=>b.score-a.score)[0];
      c._lifecycleId = tracker.register(c.ticker, top?.source || 'unknown', c.netScore, 'bullish', top?.reason || '');
      // Check technical confirmation
      if (c.confirmedByTech) tracker.confirm(c._lifecycleId);
      else tracker.reject(c._lifecycleId, 'REJECTED_UNCONFIRMED', 'No primary technical signal');
    }

    const boughtThisCycle = new Set();
    let newTrades = 0;
    for (const c of toTrade) {
      if (boughtThisCycle.has(c.ticker)) continue;
      // Skip unconfirmed signals (rejected in lifecycle)
      const sig = tracker.signals.get(c._lifecycleId);
      if (sig && sig.state !== 'CONFIRMED') continue;

      const top = c.signals.sort((a,b)=>b.score-a.score)[0];

      // Check if the primary source strategy has been killed by calibrator
      if (top && isStrategyKilled(top.source)) {
        console.log(`  [SKIP] ${c.ticker} — strategy '${top.source}' killed by calibrator (losing streak)`);
        tracker.reject(c._lifecycleId, 'REJECTED_RISK', `Strategy ${top.source} disabled`);
        continue;
      }

      // Governor evaluation (drawdown, sector, daily cap, liquidity)
      const govResult = await evaluateTrade(c.ticker, equity, positions, openOrders);
      if (!govResult.approved) {
        for (const r of govResult.reasons) console.log(`  [GOV BLOCK] ${c.ticker} — ${r}`);
        if (govResult.reasons.some(r => r.includes('DRAWDOWN KILL'))) {
          criticalAlert('Drawdown Kill Triggered', govResult.reasons.find(r => r.includes('DRAWDOWN KILL')), { ticker: c.ticker, equity: equity.toFixed(2) });
        }
        tracker.reject(c._lifecycleId, 'REJECTED_GOVERNOR', govResult.reasons[0]);
        continue;
      }

      const earningsBlock = await isEarningsBlock(c.ticker).catch(()=>false);
      if (earningsBlock) {
        console.log(`  [SKIP] ${c.ticker} — earnings within 5 days`);
        tracker.reject(c._lifecycleId, 'REJECTED_EARNINGS', 'Earnings within 5 days');
        continue;
      }

      const risk = await assessPositionRisk(c.ticker, equity, top?.source);
      console.log(`  [RISK] ${c.ticker}: ${risk.reason}`);
      if (!risk.safe) {
        console.log(`  [SKIP] ${c.ticker} — risk gate failed`);
        tracker.reject(c._lifecycleId, 'REJECTED_RISK', risk.reason);
        continue;
      }

      // All gates passed → APPROVED
      tracker.approve(c._lifecycleId);

      const reason = `Score ${c.netScore}/100 [${c.sources.join('+')}] | ${top.reason}`;
      const order = await placeBuy(c.ticker, reason, equity, risk.maxPct);

      if (order && order.id) {
        tracker.execute(c._lifecycleId, order.id);
        newTrades++;
        boughtThisCycle.add(c.ticker);
        recordTradeExecuted();
        // Track signal source for strategy-specific exits
        if (!state.positionSources) state.positionSources = {};
        state.positionSources[c.ticker] = top?.source || 'unknown';
        const profile = getExitProfile(top?.source);
        console.log(`  [EXIT PROFILE] ${c.ticker}: ${profile.label} (stop=${profile.hardStop}%, trail=${profile.trail}%, target=${profile.profitTarget||'none'})`);
      } else {
        console.log(`  [BUY FAILED] ${c.ticker} — order rejected, not counting toward cap`);
        tracker.reject(c._lifecycleId, 'REJECTED_FILL', 'Order placement failed');
      }
    }

    // Lifecycle summary
    const cycleSummary = tracker.logCycle(equity, positions.length);
    tracker.printRejectionHistogram();

    saveState(state);
    console.log(`[Engine] Cycle complete — new trades: ${newTrades}`);
  } catch(err) { console.error('[Engine] Cycle error:', err.message); saveState(state); }
}

// ─── Short Engine ─────────────────────────────────────────────────────────────
const SHORT_STOP_PCT   = 5;   // Stop loss: 5% adverse move (price up)
const SHORT_TARGET_PCT = 12;  // Profit target: 12% decline
const SHORT_RSI_COVER  = 30;  // RSI oversold cover trigger
const SHORT_TRAIL_PCT  = 4;   // Trailing stop: cover if stock bounces 4% from its low
const SHORT_MAX_HOLD_H = 168; // Max hold: 7 trading days (shorts have decay risk)

async function calcShortQty(ticker, equity, maxPct) {
  try {
    const { getBars, closes, returns } = require('./data/prices');
    const bars  = await getBars(ticker, 60);
    const cls   = closes(bars);
    const price = cls.slice(-1)[0];
    // Volatility-adjusted sizing for shorts (same logic as longs)
    const BASELINE_VOL = 0.25;
    const rets = returns(cls);
    let pct = maxPct ? Math.min(maxPct / 100, 0.05) : 0.05;
    if (rets.length >= 20) {
      const recent = rets.slice(-30);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
      const realizedVol = Math.sqrt(variance) * Math.sqrt(252);
      pct = Math.max(0.02, Math.min(0.05, pct * (BASELINE_VOL / Math.max(realizedVol, 0.01))));
    }
    const qty   = Math.floor((equity * pct) / price);
    return Math.max(1, qty);
  } catch { return 1; }
}

async function placeShort(ticker, reason, equity, maxPct) {
  const qty   = await calcShortQty(ticker, equity, maxPct);
  const order = await alpaca('POST', '/orders', { symbol: ticker, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day' });
  if (!order.id) { console.error(`  [SHORT FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  logTrade({ ...order, engine_reason: `SHORT: ${reason}` });
  console.log(`  [SHORT] ${ticker} x${qty} (sell to open) — ${reason}`);
  return order;
}

async function coverShort(ticker, qty, reason) {
  // qty should be absolute value — we buy to cover
  const absQty = Math.abs(parseFloat(qty));
  const order = await alpaca('POST', '/orders', { symbol: ticker, qty: String(absQty), side: 'buy', type: 'market', time_in_force: 'day' });
  if (!order.id) { console.error(`  [COVER FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  logTrade({ ...order, engine_reason: `COVER: ${reason}` });
  console.log(`  [COVER] ${ticker} x${absQty} (buy to cover) — ${reason}`);
  return order;
}

async function runShortCycle(getShortCandidatesFn) {
  const now = new Date().toISOString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[ShortEngine] Cycle: ${now}`);

  try {
    const account = await getAccount();
    if (account.trading_blocked) { console.warn('[ShortEngine] Trading blocked.'); return; }
    if (!isSystemHealthy()) {
      console.warn('[ShortEngine] System degraded — skipping short cycle');
      return;
    }

    const equity    = parseFloat(account.equity);
    const [positions, openOrders] = await Promise.all([getOpenPositions(), getOpenOrders()]);
    const shorts    = positions.filter(p => parseFloat(p.qty) < 0);
    console.log(`[ShortEngine] Equity: $${equity.toLocaleString()} | Open shorts: ${shorts.length}`);

    // ── Manage existing short positions ────────────────────────────────────
    const { getBars, closes, rsi } = require('./data/prices');
    for (const pos of shorts) {
      const ticker  = pos.symbol;
      const qty     = parseFloat(pos.qty);            // negative
      const entry   = parseFloat(pos.avg_entry_price);
      const curr    = parseFloat(pos.current_price);
      // For shorts: pnl% is positive when price falls, negative when price rises
      // unrealized_plpc from Alpaca is already correct: negative qty, so gain = price drop
      const pnlPct  = parseFloat(pos.unrealized_plpc) * 100;

      console.log(`  SHORT ${ticker.padEnd(6)} entry=$${entry.toFixed(2)} curr=$${curr.toFixed(2)} P&L=${pnlPct.toFixed(2)}%`);

      // Stop loss: price rose 5%+ (pnlPct will be negative = loss)
      if (pnlPct <= -SHORT_STOP_PCT) {
        console.log(`  [SHORT STOP] ${ticker}: adverse move ${pnlPct.toFixed(2)}% — covering`);
        await coverShort(ticker, qty, `Stop loss: ${pnlPct.toFixed(2)}% adverse`);
        warningAlert('Short Stop Hit', `${ticker} short stopped out at ${pnlPct.toFixed(2)}%`, { ticker, pnlPct: pnlPct.toFixed(2) + '%' });
        continue;
      }

      // Profit target: price fell 12%+
      if (pnlPct >= SHORT_TARGET_PCT) {
        console.log(`  [SHORT PROFIT] ${ticker}: +${pnlPct.toFixed(2)}% — covering at target`);
        await coverShort(ticker, qty, `Profit target: +${pnlPct.toFixed(2)}%`);
        infoAlert('Short Profit Target', `${ticker} covered at +${pnlPct.toFixed(2)}%`, { ticker, pnlPct: '+' + pnlPct.toFixed(2) + '%' });
        continue;
      }

      // RSI oversold cover — don't ride a bounce
      try {
        const bars   = await getBars(ticker, 30);
        const cls    = closes(bars);
        const rsiVal = rsi(cls, 14);
        if (rsiVal !== null && rsiVal < SHORT_RSI_COVER) {
          console.log(`  [SHORT COVER-RSI] ${ticker}: RSI=${rsiVal.toFixed(0)} < ${SHORT_RSI_COVER} — covering (oversold bounce risk)`);
          await coverShort(ticker, qty, `RSI oversold: ${rsiVal.toFixed(0)}`);
          infoAlert('Short Covered RSI', `${ticker} covered — RSI=${rsiVal.toFixed(0)} (oversold)`, { ticker, rsi: rsiVal.toFixed(0) });
          continue;
        }
      } catch {}

      // Trailing stop for shorts: if stock bounced 4% from its low, cover
      // Track low water mark (lowest price since entry)
      if (!state.shortLows) state.shortLows = {};
      if (!state.shortLows[ticker] || curr < state.shortLows[ticker]) state.shortLows[ticker] = curr;
      const lowWater = state.shortLows[ticker];
      const bounceFromLow = ((curr - lowWater) / lowWater) * 100;
      if (bounceFromLow >= SHORT_TRAIL_PCT && lowWater < entry * 0.99) {
        console.log(`  [SHORT TRAIL] ${ticker}: bounced ${bounceFromLow.toFixed(1)}% from low $${lowWater.toFixed(2)} — covering`);
        await coverShort(ticker, qty, `Trailing stop: bounced ${bounceFromLow.toFixed(1)}% from low`);
        delete state.shortLows[ticker];
        infoAlert('Short Trailing Stop', `${ticker} covered — bounced ${bounceFromLow.toFixed(1)}% from low`, { ticker, bounceFromLow: bounceFromLow.toFixed(1) + '%' });
        continue;
      }

      // Max hold time: cover if held too long (shorts have carry/borrow cost risk)
      const shortHoldMs = Date.now() - new Date(pos.created_at || 0).getTime();
      const shortHoldHours = shortHoldMs / 3600000;
      if (shortHoldHours > SHORT_MAX_HOLD_H) {
        console.log(`  [SHORT TIME] ${ticker}: held ${shortHoldHours.toFixed(0)}h > ${SHORT_MAX_HOLD_H}h — covering`);
        await coverShort(ticker, qty, `Time exit: ${shortHoldHours.toFixed(0)}h > ${SHORT_MAX_HOLD_H}h max, P&L=${pnlPct.toFixed(2)}%`);
        if (state.shortLows) delete state.shortLows[ticker];
        continue;
      }
    }

    // ── Enter new short positions ───────────────────────────────────────────
    const candidates = getShortCandidatesFn();
    if (candidates.length === 0) { console.log('[ShortEngine] No short candidates this cycle.'); return; }

    const openShortTickers = new Set(shorts.map(p => p.symbol));
    const pendingSells = new Set(
      openOrders.filter(o => o.side === 'sell' && o.type === 'market').map(o => o.symbol)
    );

    let newShorts = 0;
    for (const c of candidates) {
      if (openShortTickers.has(c.ticker)) continue;
      if (pendingSells.has(c.ticker)) continue;

      // Governor short evaluation
      const govResult = await evaluateShortTrade(c.ticker, equity, positions);
      if (!govResult.approved) {
        for (const r of govResult.reasons) console.log(`  [SHORT GOV BLOCK] ${c.ticker} — ${r}`);
        continue;
      }

      // Monte Carlo squeeze risk
      const risk = await assessShortRisk(c.ticker, equity);
      console.log(`  [SHORT RISK] ${c.ticker}: ${risk.reason}`);
      if (!risk.safe) {
        console.log(`  [SHORT SKIP] ${c.ticker} — risk gate failed`);
        continue;
      }

      const order = await placeShort(c.ticker, c.reason, equity, risk.maxPct);
      if (order && order.id) {
        newShorts++;
        openShortTickers.add(c.ticker);
        recordShortExecuted();
      }

      if (newShorts >= 2) break; // Max 2 new shorts per cycle to avoid overloading
    }

    console.log(`[ShortEngine] Cycle complete — new shorts: ${newShorts}`);
  } catch (err) {
    console.error('[ShortEngine] Cycle error:', err.message);
  }
}

module.exports = { runTradeCycle, placeOvernightTrailingStops, runShortCycle };
