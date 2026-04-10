/**
 * Trading Dashboard — local web server on http://localhost:3000
 * Professional dark-theme UI showing live account status, positions,
 * scheduler health, signals, and activity feed.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

// Load env
fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
  line = line.trim();
  const i = line.indexOf('=');
  if (i > 0) { const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim(); if (k) process.env[k] = v; }
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;
const PORT            = 3001;
const INITIAL_EQUITY  = 100000; // Starting paper account value
const SCHEDULER_LOG = path.join(__dirname, 'scheduler.log');
const WATCHDOG_LOG  = path.join(__dirname, 'watchdog.log');
const ENGINE_STATE  = path.join(__dirname, 'trade_history/engine_state.json');
const GOV_STATE     = path.join(__dirname, 'trade_history/governor_state.json');
const CYCLE_LOG     = path.join(__dirname, 'trade_history/cycle_log.jsonl');
const HALT_FLAG     = path.join(__dirname, 'trade_history/halt.flag');
const ALERTS_FILE   = path.join(__dirname, 'trade_history/alerts.jsonl');

function alpaca(method, endpoint) {
  return fetch(ALPACA_URL + '/v2' + endpoint, {
    method,
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
  }).then(r => r.json()).catch(() => null);
}

function etTime() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

function marketStatus() {
  const now  = new Date();
  const et   = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [h, m] = et.split(':').map(Number);
  const mins = h * 60 + m;
  const day  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  if (day === 0 || day === 6) return 'WEEKEND';
  if (mins < 480) return 'OVERNIGHT';
  if (mins < 570) return 'PRE-MARKET';
  if (mins < 960) return 'MARKET OPEN';
  if (mins < 1200) return 'AFTER-HOURS';
  return 'OVERNIGHT';
}

function logAlert(type, extra = {}) {
  try {
    const dir = path.join(__dirname, 'trade_history');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(ALERTS_FILE, JSON.stringify({ type, timestamp: new Date().toISOString(), ...extra }) + '\n');
  } catch (e) { console.error('[Dashboard] Failed to log alert:', e.message); }
}

function readLastLines(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n').filter(l => l.trim());
    return lines.slice(-n);
  } catch { return []; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function getSchedulerInfo() {
  const lines      = readLastLines(SCHEDULER_LOG, 500);
  const cycleLines = lines.filter(l => l.includes('[Engine] Trade cycle:'));
  const lastCycle  = cycleLines.length ? cycleLines[cycleLines.length - 1] : null;
  let lastCycleTime = null;
  if (lastCycle) {
    const match = lastCycle.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
    if (match) lastCycleTime = new Date(match[1]);
  }

  const nextCycleMs  = lastCycleTime ? Math.max(0, lastCycleTime.getTime() + 5 * 60 * 1000 - Date.now()) : null;
  const schedulerAge = lastCycleTime ? Math.round((Date.now() - lastCycleTime.getTime()) / 1000) : null;

  // Watchdog restarts — count only within the CURRENT session (after last "Watchdog online")
  const wdLines    = readLastLines(WATCHDOG_LOG, 200);
  const lastOnlineIdx = wdLines.reduce((acc, l, i) => l.includes('Watchdog online') ? i : acc, -1);
  const sessionLines  = lastOnlineIdx >= 0 ? wdLines.slice(lastOnlineIdx) : wdLines;
  const restarts   = sessionLines.filter(l => l.includes('restart #') && !l.includes('restart #0')).length;
  const wdOnline   = lastOnlineIdx >= 0;

  // Market hours check (ET)
  const etNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();
  const etDay  = etNow.getDay();
  const isMktHours = etDay >= 1 && etDay <= 5 && etMins >= 570 && etMins < 960;

  // During market hours: require a trade cycle in last 10 min
  // Outside market hours: scheduler is "sleeping" — check watchdog started it in last 24h
  let isAlive, schedStatus;
  if (isMktHours) {
    isAlive    = schedulerAge !== null && schedulerAge < 600;
    schedStatus = isAlive ? (schedulerAge + 's ago') : 'OFFLINE';
  } else {
    const cutoff24h  = Date.now() - 24 * 60 * 60 * 1000;
    const wdStarted  = wdLines.some(l => {
      if (!l.includes('Starting scheduler.js')) return false;
      const m = l.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      return m && new Date(m[1]).getTime() > cutoff24h;
    });
    // Also accept any [Scheduler] log line in last 24h as proof of life
    const recentLog  = lines.some(l => {
      if (!l.includes('[Scheduler]') && !l.includes('Trading Scheduler')) return false;
      const m = l.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      return m && new Date(m[1]).getTime() > cutoff24h;
    });
    isAlive     = wdStarted || recentLog;
    const mktStatus = marketStatus();
    schedStatus = isAlive
      ? (mktStatus === 'OVERNIGHT' ? 'Sleeping — opens 9:30 AM' : mktStatus === 'PRE-MARKET' ? 'Pre-market' : 'After-hours')
      : 'OFFLINE';
  }

  // Signal counts from last cache refresh
  const slowMatch  = lines.slice().reverse().find(l => l.includes('[Cache] SLOW updated'));
  const fastMatch  = lines.slice().reverse().find(l => l.includes('[Cache] FAST updated'));
  const slowSigs   = slowMatch ? (slowMatch.match(/(\d+) signals/) || [])[1] : '—';
  const fastSigs   = fastMatch ? (fastMatch.match(/(\d+) signals/) || [])[1] : '—';

  // Last FAST refresh time
  const fastRefreshLine = lines.slice().reverse().find(l => l.includes('FAST refresh'));
  const fastRefreshTime = fastRefreshLine ? fastRefreshLine.match(/(\d{2}:\d{2} [AP]M)/)?.[1] : '—';

  // Activity feed — buys, sells, blocks, risk skips
  const activityLines = lines.filter(l =>
    l.includes('[BUY]') || l.includes('[SELL]') || l.includes('[STOP OUT]') ||
    l.includes('[PROFIT]') || l.includes('Cycle complete') || l.includes('[GOV BLOCK]') ||
    l.includes('[SKIP]') || l.includes('Trade cycle:') || l.includes('MARKET OPEN') ||
    l.includes('PRE-MARKET') || l.includes('AFTER HOURS') || l.includes('Watchdog')
  ).slice(-40);

  const isHalted = fs.existsSync(HALT_FLAG);

  return {
    isAlive, schedStatus, lastCycleTime, nextCycleMs, schedulerAge,
    restarts, wdOnline, slowSigs, fastSigs, fastRefreshTime,
    activityLines, isHalted
  };
}

async function getApiData() {
  const [account, positions, orders] = await Promise.all([
    alpaca('GET', '/account'),
    alpaca('GET', '/positions'),
    alpaca('GET', '/orders?status=open&limit=50'),
  ]);

  const equity      = parseFloat(account?.equity || 0);
  const bp          = parseFloat(account?.buying_power || 0);
  const lastEquity  = parseFloat(account?.last_equity || equity);
  const dayPnl      = equity - lastEquity;
  const dayPnlPct   = lastEquity > 0 ? (dayPnl / lastEquity * 100) : 0;
  const totalPnl    = equity - INITIAL_EQUITY;
  const totalPnlPct = (totalPnl / INITIAL_EQUITY * 100);

  const pos = Array.isArray(positions) ? positions : [];
  const ord = Array.isArray(orders) ? orders : [];

  const invested = pos.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
  const exposure = equity > 0 ? (invested / equity * 100) : 0;
  const unrealizedPnl = pos.reduce((s, p) => s + parseFloat(p.unrealized_pl || 0), 0);

  const posData = pos.map(p => {
    const qty    = parseFloat(p.qty || 0);
    const isShort = qty < 0;
    const mv    = parseFloat(p.market_value || 0);
    const pnl   = parseFloat(p.unrealized_pl || 0);
    const pnlPct = parseFloat(p.unrealized_plpc || 0) * 100;
    const entry = parseFloat(p.avg_entry_price || 0);
    const curr  = parseFloat(p.current_price || 0);
    // Long: trailing stop is a sell order; Short: cover stop would be a buy order (market/limit)
    const stop  = isShort
      ? null  // shorts managed by engine hard stop — no resting stop order
      : ord.find(o => o.symbol === p.symbol && o.side === 'sell' && o.type === 'trailing_stop');
    return {
      symbol: p.symbol, qty: p.qty, isShort,
      entry: entry.toFixed(2),
      current: curr.toFixed(2), mv: mv.toFixed(0),
      pnl: pnl.toFixed(2), pnlPct: pnlPct.toFixed(2),
      stopPrice: stop ? parseFloat(stop.stop_price).toFixed(2) : '—',
      trailPct: stop ? stop.trail_percent + '%' : '—',
    };
  }).sort((a, b) => Math.abs(parseFloat(b.mv)) - Math.abs(parseFloat(a.mv)));

  return { equity, bp, dayPnl, dayPnlPct, totalPnl, totalPnlPct, unrealizedPnl, invested, exposure, positions: posData, openOrders: ord.length };
}

async function getIndexData() {
  const headers = { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET };
  const snap = await fetch('https://data.alpaca.markets/v2/stocks/snapshots?symbols=SPY,QQQ,DIA&feed=iex', { headers })
    .then(r => r.json()).catch(() => null);
  const result = {};
  for (const sym of ['SPY','QQQ','DIA']) {
    const s    = snap?.[sym];
    const curr = parseFloat(s?.dailyBar?.c || s?.latestTrade?.p || 0);
    const prev = parseFloat(s?.prevDailyBar?.c || curr);
    if (curr > 0) {
      const chg    = curr - prev;
      const chgPct = prev > 0 ? (chg / prev * 100) : 0;
      result[sym]  = { price: curr.toFixed(2), change: chg.toFixed(2), changePct: chgPct.toFixed(2) };
    } else {
      result[sym] = { price: '—', change: '0.00', changePct: '0.00' };
    }
  }
  return result;
}

function getLastNewsRun() {
  try {
    const TASK_LOG = path.join(__dirname, 'trade_history/task_log.jsonl');
    if (!fs.existsSync(TASK_LOG)) return null;
    const lines = fs.readFileSync(TASK_LOG, 'utf8').trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.task === 'midday_news' || entry.task === 'pre_market') {
          return { task: entry.task, status: entry.status, at: entry.at, et: entry.et };
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function getStatus() {
  const [api, sched, indices] = await Promise.all([getApiData(), Promise.resolve(getSchedulerInfo()), getIndexData()]);

  // Aggressive engine summary for main dashboard
  let aggressive = null;
  try {
    const aggStatePath = path.join(__dirname, 'trade_history/aggressive_state.json');
    if (fs.existsSync(aggStatePath)) {
      const aggState = JSON.parse(fs.readFileSync(aggStatePath, 'utf8'));
      const aggPositions = Array.isArray(aggState.positions) ? aggState.positions : [];
      const deployed = aggPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || p.mv || 0)), 0);
      aggressive = { active: true, positions: aggPositions.length, deployed: Math.round(deployed) };
    } else {
      aggressive = { active: false, positions: 0, deployed: 0 };
    }
  } catch { aggressive = { active: false, positions: 0, deployed: 0 }; }

  return {
    time: etTime(),
    marketStatus: marketStatus(),
    ...api,
    scheduler: sched,
    schedulerHalted: sched.isHalted,
    indices,
    lastNewsRun: getLastNewsRun(),
    aggressive,
  };
}

// ─── HTML ───────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Dashboard</title>
<style>
  :root {
    --bg:      #060b11;
    --panel:   #0e1824;
    --border:  #1e3050;
    --accent:  #2979ff;
    --green:   #00e676;
    --red:     #ff5252;
    --yellow:  #ffca28;
    --dim:     #7a9abf;
    --text:    #ddeeff;
    --bright:  #ffffff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', 'Courier New', monospace; font-size: 14px; min-height: 100vh; }

  /* ── Header ── */
  .header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; }
  .header-left { display: flex; align-items: center; gap: 24px; }
  .logo { font-size: 18px; font-weight: bold; color: var(--accent); letter-spacing: 2px; }
  .market-badge { padding: 5px 12px; border-radius: 4px; font-size: 13px; font-weight: bold; letter-spacing: 1px; }
  .badge-open   { background: rgba(0,230,118,0.15); color: var(--green); border: 1px solid rgba(0,230,118,0.4); }
  .badge-closed { background: rgba(255,82,82,0.15); color: var(--red);   border: 1px solid rgba(255,82,82,0.4); }
  .badge-pre    { background: rgba(255,202,40,0.15); color: var(--yellow);border: 1px solid rgba(255,202,40,0.4); }
  .et-time      { color: var(--text); font-size: 14px; font-weight: 600; }
  .last-update  { color: var(--dim); font-size: 12px; }

  /* ── Layout ── */
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; background: var(--border); }
  .grid-wide { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); }
  .grid-full { background: var(--border); }
  .panel { background: var(--panel); padding: 16px 18px; }
  .panel-title { font-size: 11px; letter-spacing: 2px; color: var(--dim); text-transform: uppercase; margin-bottom: 14px; border-bottom: 1px solid var(--border); padding-bottom: 8px; font-weight: 600; }

  /* ── Stat cards ── */
  .stat-row { display: flex; justify-content: space-between; margin-bottom: 8px; align-items: center; }
  .stat-label { color: var(--dim); font-size: 13px; }
  .stat-value { color: var(--bright); font-weight: bold; font-size: 14px; }
  .big-number { font-size: 26px; color: var(--bright); font-weight: bold; letter-spacing: 1px; }
  .sub-number { font-size: 13px; color: var(--dim); margin-top: 4px; }

  /* ── P&L colors ── */
  .pos  { color: var(--green); }
  .neg  { color: var(--red); }
  .neu  { color: var(--dim); }

  /* ── Status indicators ── */
  .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot-green  { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot-red    { background: var(--red);   box-shadow: 0 0 8px var(--red); }
  .dot-yellow { background: var(--yellow);box-shadow: 0 0 8px var(--yellow); }
  .status-label { color: var(--bright); font-size: 14px; font-weight: 600; }
  .status-sub   { color: var(--text);  font-size: 13px; margin-left: auto; }

  /* ── Countdown ── */
  .countdown { font-size: 34px; color: var(--accent); font-weight: bold; letter-spacing: 4px; font-variant-numeric: tabular-nums; }
  .countdown-label { font-size: 12px; color: var(--dim); letter-spacing: 1px; margin-top: 6px; }

  /* ── Positions table ── */
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--border); font-weight: 600; }
  th:first-child { text-align: left; }
  td { padding: 7px 10px; text-align: right; border-bottom: 1px solid rgba(30,48,80,0.7); font-variant-numeric: tabular-nums; font-size: 13px; color: var(--text); }
  td:first-child { text-align: left; color: var(--bright); font-weight: bold; font-size: 14px; }
  tr:hover td { background: rgba(41,121,255,0.07); }
  .tag-tiny { font-size: 11px; color: var(--dim); font-weight: normal; }

  /* ── Activity feed ── */
  .feed { height: 280px; overflow-y: auto; font-size: 12px; line-height: 1.9; }
  .feed::-webkit-scrollbar { width: 4px; }
  .feed::-webkit-scrollbar-track { background: var(--bg); }
  .feed::-webkit-scrollbar-thumb { background: var(--border); }
  .feed-line { padding: 2px 0; border-bottom: 1px solid rgba(30,48,80,0.4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .feed-buy    { color: var(--green); font-weight: 600; }
  .feed-sell   { color: var(--red); font-weight: 600; }
  .feed-cycle  { color: var(--accent); }
  .feed-block  { color: #5a7a9f; }
  .feed-market { color: var(--yellow); font-weight: bold; }
  .feed-normal { color: var(--text); }

  /* ── Progress bar ── */
  .progress-wrap { background: rgba(26,39,64,0.8); border-radius: 2px; height: 6px; margin-top: 6px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }
  .fill-blue   { background: linear-gradient(90deg, #0044bb, #0088ff); }
  .fill-green  { background: linear-gradient(90deg, #007a30, #00c853); }
  .fill-yellow { background: linear-gradient(90deg, #b38800, #ffc107); }

  /* ── Exposure arc (simple) ── */
  .exposure-display { text-align: center; padding: 8px 0; }
  .exposure-pct { font-size: 40px; font-weight: bold; letter-spacing: 2px; }

  .divider { height: 1px; background: var(--border); margin: 10px 0; }

  /* ── Index ticker bar ── */
  .ticker-bar { background: #07101a; border-bottom: 1px solid var(--border); display: flex; justify-content: space-around; align-items: center; padding: 12px 20px; }
  .ticker-item { display: flex; align-items: center; gap: 12px; }
  .ticker-divider { width: 1px; height: 30px; background: var(--border); }
  .ticker-name { color: var(--bright); font-weight: bold; font-size: 16px; letter-spacing: 0.5px; }
  .ticker-sym  { color: var(--dim); font-size: 12px; }
  .ticker-price { font-size: 20px; font-weight: bold; color: var(--bright); font-variant-numeric: tabular-nums; }
  .ticker-change { display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px; border-radius: 5px; font-size: 14px; font-weight: bold; }

  /* ── Translucent value boxes ── */
  .val-box {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 6px;
    font-weight: bold; letter-spacing: 0.5px;
    backdrop-filter: blur(4px);
  }
  .val-box-green {
    background: rgba(0,230,118,0.12);
    border: 1px solid rgba(0,230,118,0.30);
    color: var(--green);
  }
  .val-box-red {
    background: rgba(255,82,82,0.12);
    border: 1px solid rgba(255,82,82,0.30);
    color: var(--red);
  }
  .val-box-blue {
    background: rgba(41,121,255,0.12);
    border: 1px solid rgba(41,121,255,0.30);
    color: #7eb3ff;
  }
  .val-box-yellow {
    background: rgba(255,202,40,0.12);
    border: 1px solid rgba(255,202,40,0.30);
    color: var(--yellow);
  }
  .arrow { font-size: 1.1em; line-height: 1; }

  /* ── P&L badge in table ── */
  .pnl-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; border-radius: 4px; font-size: 13px; font-weight: 600;
  }
  .pnl-badge-green { background: rgba(0,230,118,0.12); border: 1px solid rgba(0,230,118,0.25); color: var(--green); }
  .pnl-badge-red   { background: rgba(255,82,82,0.12);  border: 1px solid rgba(255,82,82,0.25);  color: var(--red); }

  /* ── Stat value boxes ── */
  .stat-val-box {
    display: inline-block; padding: 2px 10px; border-radius: 4px;
    font-weight: bold; font-size: 14px;
    background: rgba(41,121,255,0.10); border: 1px solid rgba(41,121,255,0.20); color: #9ec8ff;
  }
/* ── Emergency controls dropdown ── */
.emergency-wrap { position:relative; display:inline-block; }
.emergency-dropdown {
  display:none; position:absolute; top:calc(100% + 6px); right:0;
  background:#0e1824; border:1px solid #1e3050; border-radius:6px;
  box-shadow:0 8px 32px rgba(0,0,0,0.7); z-index:1000; min-width:220px; overflow:hidden;
}
.emergency-dropdown.open { display:block; }
.emergency-item {
  display:block; width:100%; padding:11px 16px; background:none; border:none;
  color:var(--text); font-size:13px; font-weight:bold; letter-spacing:0.5px;
  text-align:left; cursor:pointer; transition:background 0.15s;
  border-bottom:1px solid rgba(30,48,80,0.7);
}
.emergency-item:last-child { border-bottom:none; }
.emergency-item:hover { background:rgba(255,255,255,0.07); }
.emergency-item.amber { color:#ffb300; }
.emergency-item.red   { color:var(--red); }
.halt-badge {
  padding:5px 12px; border-radius:4px; font-size:12px; font-weight:bold;
  letter-spacing:1px; background:rgba(255,82,82,0.15); color:var(--red);
  border:1px solid rgba(255,82,82,0.4); display:none; cursor:pointer;
}
.halt-badge.visible { display:inline-block; }
/* Chart tabs */
.chart-tab {
  padding:3px 10px; border-radius:3px; border:1px solid var(--border);
  background:transparent; color:var(--dim); font-size:11px; font-weight:bold;
  cursor:pointer; transition:all 0.15s; letter-spacing:0.5px;
}
.chart-tab:hover, .chart-tab.active {
  border-color:var(--accent); color:var(--accent); background:rgba(41,121,255,0.08);
}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo">⬡ ALGO TRADER</div>
    <div id="market-badge" class="market-badge badge-closed">LOADING</div>
    <div class="et-time" id="et-time">-- : -- : -- ET</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px;">
    <span class="halt-badge" id="halt-badge" title="Click to resume scheduler">&#9208; SCHEDULER HALTED</span>
    <button onclick="window.open('/news','_blank','width=1200,height=800')" style="padding:7px 18px;background:var(--accent);border:none;color:#fff;border-radius:5px;cursor:pointer;font-weight:bold;font-size:13px;letter-spacing:0.5px;transition:background 0.2s;" onmouseover="this.style.background='#448aff'" onmouseout="this.style.background='var(--accent)'">News</button>
    <button onclick="window.open('/aggressive','_blank','width=1400,height=900')" style="padding:7px 18px;background:#ff6d00;border:none;color:#fff;border-radius:5px;cursor:pointer;font-weight:bold;font-size:13px;letter-spacing:0.5px;transition:background 0.2s;" onmouseover="this.style.background='#ff9100'" onmouseout="this.style.background='#ff6d00'">Aggressive</button>
    <div class="emergency-wrap" id="emergency-wrap">
      <button id="emergency-btn" onclick="toggleEmergencyMenu()" style="padding:7px 18px;background:var(--red);border:2px solid #ff1744;color:#fff;border-radius:5px;cursor:pointer;font-weight:bold;font-size:13px;letter-spacing:1px;transition:all 0.2s;text-transform:uppercase;box-shadow:0 0 12px rgba(255,23,68,0.4);" onmouseover="this.style.background='#ff1744';this.style.boxShadow='0 0 20px rgba(255,23,68,0.7)'" onmouseout="this.style.background='var(--red)';this.style.boxShadow='0 0 12px rgba(255,23,68,0.4)'">&#9888; EMERGENCY &#9660;</button>
      <div class="emergency-dropdown" id="emergency-dropdown">
        <button class="emergency-item amber" onclick="cancelOrders()">&#128683; Cancel All Orders</button>
        <button class="emergency-item amber" onclick="closePositions()">&#128200; Close All Positions</button>
        <button class="emergency-item red"   onclick="fullKillSwitch()">&#9762; Full Kill Switch</button>
      </div>
    </div>
    <div class="last-update" id="last-update">Connecting...</div>
  </div>
</div>

<!-- Index Ticker Bar -->
<div class="ticker-bar">
  <div class="ticker-item">
    <span class="ticker-name">S&amp;P 500</span>
    <span class="ticker-sym">SPY</span>
    <span id="idx-spy-price" class="ticker-price">—</span>
    <span id="idx-spy-change" class="ticker-change val-box-blue">—</span>
  </div>
  <div class="ticker-divider"></div>
  <div class="ticker-item">
    <span class="ticker-name">NASDAQ</span>
    <span class="ticker-sym">QQQ</span>
    <span id="idx-qqq-price" class="ticker-price">—</span>
    <span id="idx-qqq-change" class="ticker-change val-box-blue">—</span>
  </div>
  <div class="ticker-divider"></div>
  <div class="ticker-item">
    <span class="ticker-name">DOW</span>
    <span class="ticker-sym">DIA</span>
    <span id="idx-dia-price" class="ticker-price">—</span>
    <span id="idx-dia-change" class="ticker-change val-box-blue">—</span>
  </div>
</div>

<!-- P&L Banner -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border)">
  <div class="panel" style="display:flex;align-items:center;justify-content:space-around;padding:14px 20px;flex-wrap:wrap;gap:12px">
    <div style="text-align:center">
      <div style="font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Today's P&amp;L</div>
      <div id="banner-day-pnl" class="val-box val-box-blue" style="font-size:24px">—</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Today %</div>
      <div id="banner-day-pct" class="val-box val-box-blue" style="font-size:24px">—</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Unrealized</div>
      <div id="banner-unrealized" class="val-box val-box-blue" style="font-size:24px">—</div>
    </div>
  </div>
  <div class="panel" style="display:flex;align-items:center;justify-content:space-around;padding:14px 20px;flex-wrap:wrap;gap:12px">
    <div style="text-align:center">
      <div style="font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Overall P&amp;L</div>
      <div id="banner-total-pnl" class="val-box val-box-blue" style="font-size:24px">—</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Overall %</div>
      <div id="banner-total-pct" class="val-box val-box-blue" style="font-size:24px">—</div>
    </div>
    <div style="text-align:center">
      <div style="font-size:11px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Starting Capital</div>
      <div class="val-box val-box-blue" style="font-size:24px">$100,000</div>
    </div>
  </div>
</div>

<!-- P&L Chart -->
<div class="panel" style="margin:1px 0;padding:0;overflow:hidden;">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px 0 16px;">
    <div class="panel-title" style="margin:0">Portfolio Performance</div>
    <div id="chart-tabs" style="display:flex;gap:4px;">
      <button class="chart-tab active" data-range="1D" onclick="switchChartRange('1D',this)">1D</button>
      <button class="chart-tab" data-range="1W" onclick="switchChartRange('1W',this)">1W</button>
      <button class="chart-tab" data-range="1M" onclick="switchChartRange('1M',this)">1M</button>
      <button class="chart-tab" data-range="1Y" onclick="switchChartRange('1Y',this)">1Y</button>
      <button class="chart-tab" data-range="ALL" onclick="switchChartRange('ALL',this)">ALL</button>
    </div>
  </div>
  <div style="position:relative;padding:8px 16px 12px;">
    <div id="chart-info" style="position:absolute;top:8px;left:20px;font-size:12px;color:var(--dim);z-index:2;"></div>
    <canvas id="pnl-chart" width="1200" height="220" style="width:100%;height:220px;cursor:crosshair;"></canvas>
  </div>
</div>

<!-- Row 1: Account, Exposure, System Health -->
<div class="grid">

  <div class="panel">
    <div class="panel-title">Account</div>
    <div class="big-number" id="equity">$—</div>
    <div class="sub-number" id="day-pnl">Day P&amp;L: —</div>
    <div class="divider"></div>
    <div class="stat-row"><span class="stat-label">Buying Power</span><span class="stat-val-box" id="bp">—</span></div>
    <div class="stat-row"><span class="stat-label">Invested</span><span class="stat-val-box" id="invested">—</span></div>
    <div class="stat-row"><span class="stat-label">Open Positions</span><span class="stat-val-box" id="pos-count">—</span></div>
    <div class="stat-row"><span class="stat-label">Open Orders</span><span class="stat-val-box" id="ord-count">—</span></div>
  </div>

  <div class="panel">
    <div class="panel-title">Deployment</div>
    <div class="exposure-display">
      <div class="exposure-pct" id="exposure-pct">—%</div>
      <div class="sub-number">Target: 96%</div>
    </div>
    <div class="progress-wrap"><div class="progress-fill fill-blue" id="exposure-bar" style="width:0%"></div></div>
    <div class="divider"></div>
    <div class="stat-row"><span class="stat-label">Signals (Slow)</span><span class="stat-value" id="slow-sigs">—</span></div>
    <div class="stat-row"><span class="stat-label">Signals (Fast)</span><span class="stat-value" id="fast-sigs">—</span></div>
    <div class="stat-row"><span class="stat-label">Last Fast Refresh</span><span class="stat-value" id="fast-refresh">—</span></div>
  </div>

  <div class="panel">
    <div class="panel-title">System Health</div>
    <div class="status-row">
      <div class="dot" id="dot-alpaca"></div>
      <div class="status-label">Alpaca API</div>
      <div class="status-sub" id="status-alpaca">—</div>
    </div>
    <div class="status-row">
      <div class="dot" id="dot-scheduler"></div>
      <div class="status-label">Scheduler</div>
      <div class="status-sub" id="status-scheduler">—</div>
    </div>
    <div class="status-row">
      <div class="dot" id="dot-watchdog"></div>
      <div class="status-label">Watchdog</div>
      <div class="status-sub" id="status-watchdog">—</div>
    </div>
    <div class="status-row">
      <div class="dot" id="dot-news"></div>
      <div class="status-label">News Scraper</div>
      <div class="status-sub" id="status-news">—</div>
    </div>
    <div class="status-row">
      <div class="dot" id="dot-aggressive"></div>
      <div class="status-label">Aggressive Engine</div>
      <div class="status-sub" id="status-aggressive">—</div>
    </div>
    <div class="divider"></div>
    <div class="panel-title" style="margin-bottom:8px">Next Trade Cycle</div>
    <div class="countdown" id="countdown">--:--</div>
    <div class="countdown-label" id="last-cycle">Last cycle: —</div>
  </div>

</div>

<!-- Row 2: Positions + Activity -->
<div class="grid-wide">

  <div class="panel">
    <div class="panel-title">Positions</div>
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Qty</th>
          <th>Entry</th>
          <th>Current</th>
          <th>Value</th>
          <th>P&amp;L</th>
          <th>Trail Stop</th>
        </tr>
      </thead>
      <tbody id="positions-body">
        <tr><td colspan="7" style="text-align:center;color:var(--dim);padding:20px">Loading...</td></tr>
      </tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel-title">Activity Feed</div>
    <div class="feed" id="activity-feed">
      <div class="feed-line feed-normal">Connecting to system...</div>
    </div>
  </div>

</div>

<script>
let countdown = 0;

function fmt(n, decimals=2) { return parseFloat(n).toLocaleString('en-US', {minimumFractionDigits:decimals, maximumFractionDigits:decimals}); }
function fmtDollar(n) { return '$' + fmt(n); }

function setDot(id, state) {
  const el = document.getElementById(id);
  el.className = 'dot ' + (state === 'green' ? 'dot-green' : state === 'yellow' ? 'dot-yellow' : 'dot-red');
}

function marketBadgeClass(status) {
  if (status === 'MARKET OPEN') return 'market-badge badge-open';
  if (status === 'PRE-MARKET') return 'market-badge badge-pre';
  return 'market-badge badge-closed';
}

function colorClass(val) { return parseFloat(val) >= 0 ? 'pos' : 'neg'; }

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
}

function feedClass(line) {
  if (line.includes('[BUY]')) return 'feed-buy';
  if (line.includes('[SELL]') || line.includes('[STOP OUT]') || line.includes('[PROFIT]')) return 'feed-sell';
  if (line.includes('Trade cycle:') || line.includes('Cycle complete')) return 'feed-cycle';
  if (line.includes('GOV BLOCK') || line.includes('[SKIP]')) return 'feed-block';
  if (line.includes('MARKET OPEN') || line.includes('PRE-MARKET') || line.includes('AFTER HOURS')) return 'feed-market';
  return 'feed-normal';
}

function cleanLine(line) {
  // Strip leading whitespace/brackets
  return line.replace(/^\\s+/, '').replace(/^[─]+\\s*/, '');
}

// ── Emergency controls ────────────────────────────────────────────────────────
function toggleEmergencyMenu() {
  document.getElementById('emergency-dropdown').classList.toggle('open');
}
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('emergency-wrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('emergency-dropdown').classList.remove('open');
});

async function cancelOrders() {
  document.getElementById('emergency-dropdown').classList.remove('open');
  if (!confirm('Cancel ALL open orders?\\n\\nPositions will NOT be closed. Scheduler will NOT be stopped.')) return;
  try {
    const res  = await fetch('/api/cancel-orders', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Error: ' + data.error); return; }
    alert('Orders cancelled: ' + (data.ordersCancelled || 'done'));
    refresh();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function closePositions() {
  document.getElementById('emergency-dropdown').classList.remove('open');
  if (!confirm('Close ALL open positions?\\n\\n(Associated orders will also be cancelled.)\\nScheduler will NOT be stopped.')) return;
  try {
    const res  = await fetch('/api/close-positions', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Error: ' + data.error); return; }
    alert('Positions closed: ' + (data.positionsClosed || 'done'));
    refresh();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function fullKillSwitch() {
  document.getElementById('emergency-dropdown').classList.remove('open');
  if (!confirm('FULL KILL SWITCH\\n\\n\u2022 Stop the scheduler\\n\u2022 Cancel all open orders\\n\u2022 Liquidate all positions\\n\\nAre you sure?')) return;
  if (!confirm('CONFIRM: Liquidate ALL positions and halt the trading scheduler?')) return;
  try {
    const res  = await fetch('/api/kill', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Error: ' + data.error); return; }
    alert('Kill switch executed.\\n\\nScheduler halted: ' + (data.schedulerHalted ? 'yes' : 'no') +
      '\\nOrders cancelled: ' + (data.ordersCancelled || 'done') +
      '\\nPositions closed: ' + (data.positionsClosed || 'done'));
    refresh();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function resumeScheduler() {
  if (!confirm('Resume the trading scheduler?\\n\\nHalt flag will be cleared. Trading resumes on next cycle.')) return;
  try {
    const res  = await fetch('/api/resume-scheduler', { method: 'POST' });
    const data = await res.json();
    if (data.error) { alert('Error: ' + data.error); return; }
    alert('Scheduler resumed. It will pick up on the next cycle (up to 60s).');
    refresh();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function refresh() {
  try {
    const res  = await fetch('/api/status');
    const data = await res.json();

    // Header
    document.getElementById('et-time').textContent = data.time + ' ET';
    const badge = document.getElementById('market-badge');
    badge.textContent = data.marketStatus;
    badge.className   = marketBadgeClass(data.marketStatus);
    document.getElementById('last-update').textContent = 'Updated ' + data.time;

    // Index Ticker Bar
    if (data.indices) {
      const idxMap = { spy: data.indices.SPY, qqq: data.indices.QQQ, dia: data.indices.DIA };
      for (const [key, idx] of Object.entries(idxMap)) {
        if (!idx || idx.price === '—') continue;
        const up = parseFloat(idx.changePct) >= 0;
        document.getElementById(\`idx-\${key}-price\`).textContent = '$' + idx.price;
        const chgEl = document.getElementById(\`idx-\${key}-change\`);
        chgEl.className = 'ticker-change ' + (up ? 'val-box-green' : 'val-box-red');
        chgEl.innerHTML = (up ? '▲ +' : '▼ ') + idx.changePct + '%';
      }
    }

    // P&L Banner
    const sign  = v => v >= 0 ? '+' : '';
    const arrow = v => v >= 0 ? '▲' : '▼';
    const boxClass = v => v >= 0 ? 'val-box val-box-green' : 'val-box val-box-red';

    function setPnl(id, val) {
      const el = document.getElementById(id);
      el.className = boxClass(val) + ' ' + el.style.cssText; // preserve inline font-size
      el.innerHTML = \`<span class="arrow">\${arrow(val)}</span> \${sign(val)}\${fmtDollar(val)}\`;
      el.style.fontSize = '24px';
    }
    function setPct(id, val) {
      const el = document.getElementById(id);
      el.className = boxClass(val);
      el.innerHTML = \`<span class="arrow">\${arrow(val)}</span> \${sign(val)}\${fmt(val)}%\`;
      el.style.fontSize = '24px';
    }
    setPnl('banner-day-pnl',    data.dayPnl);
    setPct('banner-day-pct',    data.dayPnlPct);
    setPnl('banner-unrealized', data.unrealizedPnl);
    setPnl('banner-total-pnl',  data.totalPnl);
    setPct('banner-total-pct',  data.totalPnlPct);

    // Account
    document.getElementById('equity').textContent   = fmtDollar(data.equity);
    const pnlEl = document.getElementById('day-pnl');
    pnlEl.textContent = 'Day P&L: ' + sign(data.dayPnl) + fmtDollar(data.dayPnl) + ' (' + sign(data.dayPnlPct) + fmt(data.dayPnlPct) + '%)';
    pnlEl.className   = 'sub-number ' + colorClass(data.dayPnl);
    document.getElementById('bp').textContent        = fmtDollar(data.bp);
    document.getElementById('invested').textContent  = fmtDollar(data.invested);
    document.getElementById('pos-count').textContent = data.positions.length;
    document.getElementById('ord-count').textContent = data.openOrders;

    // Exposure
    const expPct = parseFloat(data.exposure).toFixed(1);
    document.getElementById('exposure-pct').textContent = expPct + '%';
    document.getElementById('exposure-pct').className   = 'exposure-pct ' + (expPct >= 90 ? 'pos' : expPct >= 50 ? '' : 'neg');
    document.getElementById('exposure-bar').style.width = Math.min(100, expPct) + '%';
    document.getElementById('exposure-bar').className   = 'progress-fill ' + (expPct >= 90 ? 'fill-green' : expPct >= 50 ? 'fill-blue' : 'fill-yellow');

    // Signals
    document.getElementById('slow-sigs').textContent    = data.scheduler.slowSigs;
    document.getElementById('fast-sigs').textContent    = data.scheduler.fastSigs;
    document.getElementById('fast-refresh').textContent = data.scheduler.fastRefreshTime;

    // Health
    setDot('dot-alpaca', data.equity > 0 ? 'green' : 'red');
    document.getElementById('status-alpaca').textContent = data.equity > 0 ? fmtDollar(data.equity) : 'Disconnected';
    // Halt badge + scheduler dot
    const haltBadge = document.getElementById('halt-badge');
    if (data.schedulerHalted) {
      haltBadge.classList.add('visible');
      haltBadge.onclick = resumeScheduler;
      setDot('dot-scheduler', 'red');
      document.getElementById('status-scheduler').textContent = 'HALTED \u2014 click badge to resume';
    } else {
      haltBadge.classList.remove('visible');
      haltBadge.onclick = null;
      setDot('dot-scheduler', data.scheduler.isAlive ? 'green' : 'red');
      document.getElementById('status-scheduler').textContent = data.scheduler.schedStatus || 'OFFLINE';
    }
    setDot('dot-watchdog', data.scheduler.wdOnline ? (data.scheduler.restarts > 0 ? 'yellow' : 'green') : 'red');
    document.getElementById('status-watchdog').textContent = data.scheduler.wdOnline
      ? (data.scheduler.restarts > 0 ? data.scheduler.restarts + ' restart(s)' : 'Running') : 'Offline';

    // News scraper status
    const news = data.lastNewsRun;
    if (news) {
      const newsTime = new Date(news.at).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false});
      setDot('dot-news', news.status === 'completed' ? 'green' : 'red');
      document.getElementById('status-news').textContent = news.status === 'completed' ? newsTime + ' ET' : 'FAILED ' + newsTime;
    } else {
      setDot('dot-news', 'yellow');
      document.getElementById('status-news').textContent = 'Not yet run';
    }

    // Aggressive engine status
    if (data.aggressive) {
      const agg = data.aggressive;
      if (agg.active) {
        setDot('dot-aggressive', agg.positions > 0 ? 'green' : 'yellow');
        document.getElementById('status-aggressive').textContent = agg.positions + ' pos | $' + (agg.deployed||0).toLocaleString();
      } else {
        setDot('dot-aggressive', 'red');
        document.getElementById('status-aggressive').textContent = 'Inactive';
      }
    } else {
      setDot('dot-aggressive', 'yellow');
      document.getElementById('status-aggressive').textContent = 'No data';
    }

    // Countdown
    countdown = data.scheduler.nextCycleMs !== null ? data.scheduler.nextCycleMs : 0;
    document.getElementById('countdown').textContent = fmtCountdown(countdown);
    if (data.scheduler.lastCycleTime) {
      const d = new Date(data.scheduler.lastCycleTime);
      document.getElementById('last-cycle').textContent = 'Last: ' + d.toLocaleTimeString('en-US', {timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) + ' ET';
    }

    // Positions
    const tbody = document.getElementById('positions-body');
    if (data.positions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--dim);padding:20px">No open positions</td></tr>';
    } else {
      tbody.innerHTML = data.positions.map(p => {
        const pnlF   = parseFloat(p.pnlPct);
        const up     = pnlF >= 0;
        const ar     = up ? '▲' : '▼';
        const badge  = up ? 'pnl-badge pnl-badge-green' : 'pnl-badge pnl-badge-red';
        const isTiny = Math.abs(parseFloat(p.mv)) < 1000;
        // For shorts: price going DOWN is good (green); price going UP is bad (red)
        const priceUp = parseFloat(p.current) >= parseFloat(p.entry);
        const priceColor = p.isShort
          ? (priceUp ? 'var(--red)' : 'var(--green)')
          : (priceUp ? 'var(--green)' : 'var(--red)');
        const priceArrow = \`<span style="color:\${priceColor};margin-left:4px">\${priceUp ? '▲' : '▼'}</span>\`;
        const shortBadge = p.isShort ? ' <span style="background:rgba(255,152,0,0.2);color:#ff9800;border:1px solid rgba(255,152,0,0.5);padding:1px 5px;border-radius:3px;font-size:10px;font-weight:bold;letter-spacing:0.5px;margin-left:4px">SHORT</span>' : '';
        const mvDisplay = Math.abs(parseInt(p.mv)).toLocaleString();
        return \`<tr\${p.isShort ? ' style="background:rgba(255,152,0,0.04)"' : ''}>
          <td>\${p.symbol}\${shortBadge}\${isTiny ? ' <span class="tag-tiny">(legacy)</span>' : ''}</td>
          <td>\${p.qty}</td>
          <td>$\${p.entry}</td>
          <td>$\${p.current}\${priceArrow}</td>
          <td>$\${mvDisplay}\${p.isShort ? ' <span style="font-size:10px;color:var(--dim)">(short)</span>' : ''}</td>
          <td><span class="\${badge}">\${ar} \${pnlF >= 0 ? '+' : ''}\${p.pnlPct}%</span><br><span style="font-size:11px;color:\${up?'var(--green)':'var(--red)'}">\${parseFloat(p.pnl) >= 0 ? '+' : ''}$\${fmt(p.pnl)}</span></td>
          <td style="color:var(--dim)">\${p.isShort ? 'engine-managed' : (p.stopPrice !== '—' ? '$'+p.stopPrice : '—')}</td>
        </tr>\`;
      }).join('');
    }

    // Activity feed
    const feed = document.getElementById('activity-feed');
    feed.innerHTML = data.scheduler.activityLines.map(line =>
      \`<div class="feed-line \${feedClass(line)}">\${cleanLine(line)}</div>\`
    ).join('');
    feed.scrollTop = feed.scrollHeight;

  } catch(e) {
    document.getElementById('last-update').textContent = 'Error: ' + e.message;
  }
}

// Tick countdown every second
setInterval(() => {
  countdown = Math.max(0, countdown - 1000);
  document.getElementById('countdown').textContent = fmtCountdown(countdown);
  // Update clock
  const et = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());
  document.getElementById('et-time').textContent = et + ' ET';
}, 1000);

// Full refresh every 10 seconds
setInterval(refresh, 10000);
refresh();

// ─── P&L Chart ──────────────────────────────────────────────────────────────
let chartData = [];
let currentRange = '1M';

function switchChartRange(range, btn) {
  currentRange = range;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  drawChart();
}

function filterByRange(points, range) {
  if (!points.length) return points;
  const now = new Date();
  let cutoff;
  if (range === '1D') cutoff = new Date(now - 86400000);
  else if (range === '1W') cutoff = new Date(now - 7 * 86400000);
  else if (range === '1M') cutoff = new Date(now - 30 * 86400000);
  else if (range === '1Y') cutoff = new Date(now - 365 * 86400000);
  else return points; // ALL
  const cutStr = cutoff.toISOString().slice(0, 10);
  return points.filter(p => p.date >= cutStr);
}

function drawChart() {
  const canvas = document.getElementById('pnl-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  ctx.clearRect(0, 0, W, H);

  let points = filterByRange(chartData, currentRange);
  if (points.length < 2) {
    ctx.fillStyle = '#556b8a';
    ctx.font = '13px Segoe UI, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No equity data for this period', W/2, H/2);
    document.getElementById('chart-info').textContent = '';
    return;
  }

  const pad = { top: 25, right: 60, bottom: 25, left: 10 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const vals = points.map(p => p.pnlPct);
  let minV = Math.min(...vals, 0);
  let maxV = Math.max(...vals, 0);
  const range = maxV - minV || 1;
  minV -= range * 0.08;
  maxV += range * 0.08;

  const xScale = cW / (points.length - 1);
  const yScale = cH / (maxV - minV);
  const toX = i => pad.left + i * xScale;
  const toY = v => pad.top + (maxV - v) * yScale;

  // Zero line
  const zeroY = toY(0);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Grid lines
  ctx.fillStyle = '#556b8a';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = minV + (maxV - minV) * (1 - i / steps);
    const y = pad.top + (i / steps) * cH;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(2) + '%', W - 5, y + 3);
  }

  // Gradient fill
  const lastVal = vals[vals.length - 1];
  const isUp = lastVal >= 0;
  const grad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
  if (isUp) {
    grad.addColorStop(0, 'rgba(0,230,118,0.25)');
    grad.addColorStop(1, 'rgba(0,230,118,0.02)');
  } else {
    grad.addColorStop(0, 'rgba(255,82,82,0.02)');
    grad.addColorStop(1, 'rgba(255,82,82,0.25)');
  }
  ctx.beginPath();
  ctx.moveTo(toX(0), zeroY);
  for (let i = 0; i < points.length; i++) ctx.lineTo(toX(i), toY(vals[i]));
  ctx.lineTo(toX(points.length - 1), zeroY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(vals[0]));
  for (let i = 1; i < points.length; i++) ctx.lineTo(toX(i), toY(vals[i]));
  ctx.strokeStyle = isUp ? '#00e676' : '#ff5252';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Current value dot
  const lastX = toX(points.length - 1), lastY = toY(lastVal);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = isUp ? '#00e676' : '#ff5252';
  ctx.fill();

  // Info text
  const p = points[points.length - 1];
  const sign = p.pnlPct >= 0 ? '+' : '';
  document.getElementById('chart-info').innerHTML =
    '<span style="color:' + (isUp ? 'var(--green)' : 'var(--red)') + ';font-size:18px;font-weight:bold;">' +
    sign + p.pnlPct.toFixed(2) + '%</span> ' +
    '<span style="color:var(--dim);">($' + sign + p.pnlDollar.toFixed(0) + ')</span> ' +
    '<span style="color:var(--dim);font-size:10px;">' + points.length + ' days</span>';

  // Hover crosshair
  canvas.onmousemove = function(e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const idx = Math.round((mx - pad.left) / xScale);
    if (idx >= 0 && idx < points.length) {
      const pt = points[idx];
      const s = pt.pnlPct >= 0 ? '+' : '';
      document.getElementById('chart-info').innerHTML =
        '<span style="color:' + (pt.pnlPct >= 0 ? 'var(--green)' : 'var(--red)') + ';font-size:18px;font-weight:bold;">' +
        s + pt.pnlPct.toFixed(2) + '%</span> ' +
        '<span style="color:var(--dim);">($' + s + pt.pnlDollar.toFixed(0) + ')</span> ' +
        '<span style="color:var(--dim);font-size:10px;">' + pt.date + '</span>';
    }
  };
  canvas.onmouseleave = function() { drawChart(); }; // redraw to reset info
}

async function loadEquityChart() {
  try {
    const res = await fetch('/api/equity-history');
    const data = await res.json();
    chartData = data.points || [];
    drawChart();
  } catch {}
}
loadEquityChart();
setInterval(loadEquityChart, 60000); // refresh chart every minute
window.addEventListener('resize', drawChart);
</script>

</body>
</html>`;

// ─── Equity History for P&L Chart ────────────────────────────────────────────
function getEquityHistory() {
  const INITIAL = 100000;
  const points = [];

  // Load daily snapshots from equity_curve.json or DB
  try {
    const EQUITY_FILE = path.join(__dirname, 'trade_history/equity_curve.json');
    if (fs.existsSync(EQUITY_FILE)) {
      const data = JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8'));
      if (data.snapshots) {
        for (const s of data.snapshots) {
          points.push({ date: s.date, equity: s.equity, positions: s.positions || 0 });
        }
      }
    }
  } catch {}

  // Also pull from DB if available
  try {
    const db = require('./database');
    const dbSnaps = db.getEquityCurve();
    if (dbSnaps && dbSnaps.length > 0) {
      const existing = new Set(points.map(p => p.date));
      for (const s of dbSnaps) {
        if (!existing.has(s.date)) {
          points.push({ date: s.date, equity: parseFloat(s.equity), positions: s.positions || 0 });
        }
      }
    }
  } catch {}

  // Sort by date
  points.sort((a, b) => a.date.localeCompare(b.date));

  // Compute P&L % relative to initial capital
  for (const p of points) {
    p.pnlPct = ((p.equity - INITIAL) / INITIAL) * 100;
    p.pnlDollar = p.equity - INITIAL;
  }

  return { points, initialCapital: INITIAL };
}

// ─── News Data Fetcher ──────────────────────────────────────────────────────
async function getNewsData() {
  try {
    const { fetchAllNews } = require('./Scraper/scraper');
    const { batchSummarize } = require('./Scraper/summarizer');
    const { cacheStats } = require('./Scraper/cache');

    const articles = await fetchAllNews();
    const enriched = await batchSummarize(articles);
    const stats = cacheStats();

    // Build source counts
    const sourceCounts = {};
    for (const a of articles) sourceCounts[a.source] = (sourceCounts[a.source] || 0) + 1;

    // Sentiment counts
    const sentiment = { bullish: 0, bearish: 0, neutral: 0 };
    const analyzed = enriched.filter(a => a.analysis);
    for (const a of analyzed) sentiment[a.analysis.sentiment] = (sentiment[a.analysis.sentiment] || 0) + 1;

    // Build article list for display
    const displayArticles = analyzed.map(a => ({
      title: a.title,
      source: a.source,
      url: a.url,
      publishedAt: a.publishedAt,
      tickers: [...new Set([...(a.tickers || []), ...(a.analysis?.tickers || [])])],
      sentiment: a.analysis?.sentiment || 'neutral',
      confidence: a.analysis?.confidence || 'low',
      urgency: a.analysis?.urgency || 'low',
      summary: a.analysis?.summary || a.title,
      marketImpact: a.analysis?.marketImpact || '',
      sectors: a.analysis?.sectors || [],
    })).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Build signals
    const { UNIVERSE } = require('./data/universe');
    const UNIVERSE_SET = new Set(UNIVERSE);
    const CONF = { high: 1.5, medium: 1.0, low: 0.5 };
    const URG  = { high: 1.3, medium: 1.0, low: 0.8 };
    const tickerData = {};
    for (const a of analyzed) {
      if (!a.analysis || a.analysis.sentiment === 'neutral') continue;
      const allTickers = new Set([...(a.tickers || []), ...(a.analysis.tickers || [])]);
      for (const t of allTickers) {
        if (!UNIVERSE_SET.has(t)) continue;
        if (!tickerData[t]) tickerData[t] = { bull: 0, bear: 0, confSum: 0, urgSum: 0, count: 0, sources: new Set(), topTitle: '' };
        if (a.analysis.sentiment === 'bullish') tickerData[t].bull++;
        else tickerData[t].bear++;
        tickerData[t].confSum += CONF[a.analysis.confidence] || 1;
        tickerData[t].urgSum += URG[a.analysis.urgency] || 1;
        tickerData[t].count++;
        tickerData[t].sources.add(a.source);
        if (!tickerData[t].topTitle) tickerData[t].topTitle = a.analysis.summary || a.title;
      }
    }
    const signals = [];
    for (const [ticker, d] of Object.entries(tickerData)) {
      if (d.count < 2) continue;
      const base = d.bull * 15 - d.bear * 10;
      const avgConf = d.confSum / d.count;
      const avgUrg = d.urgSum / d.count;
      const score = Math.min(80, Math.max(0, Math.round(base * avgConf * avgUrg)));
      signals.push({ ticker, direction: d.bull >= d.bear ? 'bullish' : 'bearish', score, bull: d.bull, bear: d.bear, sources: [...d.sources], topTitle: d.topTitle });
    }
    signals.sort((a, b) => b.score - a.score);

    return { articles: displayArticles, signals, sourceCounts, sentiment, totalArticles: articles.length, cache: stats, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { error: e.message, articles: [], signals: [], sourceCounts: {}, sentiment: { bullish: 0, bearish: 0, neutral: 0 }, totalArticles: 0 };
  }
}

// ─── News Page HTML ─────────────────────────────────────────────────────────
const NEWS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>News Sentiment — Algo Trader</title>
<style>
  :root { --bg:#060b11; --panel:#0e1824; --border:#1e3050; --accent:#2979ff; --green:#00e676; --red:#ff5252; --yellow:#ffca28; --text:#ddeeff; --dim:#556b8a; --bright:#ffffff; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI','Courier New',monospace; font-size:13px; }
  .top-bar { background:var(--panel); border-bottom:1px solid var(--border); padding:14px 24px; display:flex; align-items:center; justify-content:space-between; }
  .top-bar h1 { font-size:16px; color:var(--bright); font-weight:700; }
  .top-bar .info { color:var(--dim); font-size:12px; }
  .btn { padding:6px 14px; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:bold; transition:opacity 0.2s; }
  .btn:hover { opacity:0.85; }
  .btn-accent { background:var(--accent); color:#fff; }
  .btn-dim { background:rgba(255,255,255,0.08); color:var(--text); }

  .stats-bar { display:flex; gap:12px; padding:12px 24px; flex-wrap:wrap; }
  .stat-card { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:12px 18px; min-width:140px; }
  .stat-card .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  .stat-card .value { font-size:22px; font-weight:bold; color:var(--bright); }
  .stat-card .value.green { color:var(--green); }
  .stat-card .value.red { color:var(--red); }
  .stat-card .value.yellow { color:var(--yellow); }

  .content { display:grid; grid-template-columns:1fr 340px; gap:16px; padding:16px 24px; height:calc(100vh - 160px); }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:6px; overflow:hidden; display:flex; flex-direction:column; }
  .panel-header { padding:10px 16px; border-bottom:1px solid var(--border); font-weight:bold; font-size:13px; color:var(--bright); display:flex; justify-content:space-between; align-items:center; }
  .panel-body { overflow-y:auto; flex:1; padding:0; }

  /* Articles */
  .article { padding:10px 16px; border-bottom:1px solid rgba(30,48,80,0.4); transition:background 0.15s; cursor:default; }
  .article:hover { background:rgba(41,121,255,0.05); }
  .article-header { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:4px; }
  .article-title { font-size:13px; color:var(--bright); font-weight:600; line-height:1.3; flex:1; }
  .article-title a { color:var(--bright); text-decoration:none; }
  .article-title a:hover { color:var(--accent); text-decoration:underline; }
  .article-meta { display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap; }
  .badge { display:inline-block; padding:1px 7px; border-radius:3px; font-size:10px; font-weight:bold; text-transform:uppercase; letter-spacing:0.3px; }
  .badge-bull { background:rgba(0,230,118,0.15); color:var(--green); border:1px solid rgba(0,230,118,0.3); }
  .badge-bear { background:rgba(255,82,82,0.15); color:var(--red); border:1px solid rgba(255,82,82,0.3); }
  .badge-neutral { background:rgba(255,255,255,0.06); color:var(--dim); border:1px solid rgba(255,255,255,0.1); }
  .badge-conf { background:rgba(41,121,255,0.1); color:#6ea8ff; border:1px solid rgba(41,121,255,0.2); }
  .badge-urg { background:rgba(255,202,40,0.1); color:var(--yellow); border:1px solid rgba(255,202,40,0.2); }
  .badge-source { background:rgba(255,255,255,0.05); color:var(--dim); border:1px solid rgba(255,255,255,0.08); }
  .badge-ticker { background:rgba(41,121,255,0.12); color:var(--accent); border:1px solid rgba(41,121,255,0.25); cursor:pointer; }
  .article-impact { font-size:11px; color:var(--dim); margin-top:3px; font-style:italic; }
  .article-time { font-size:11px; color:var(--dim); white-space:nowrap; }

  /* Signals sidebar */
  .signal-row { padding:10px 16px; border-bottom:1px solid rgba(30,48,80,0.4); }
  .signal-ticker { font-size:15px; font-weight:bold; }
  .signal-ticker.bull { color:var(--green); }
  .signal-ticker.bear { color:var(--red); }
  .signal-score { float:right; font-size:18px; font-weight:bold; color:var(--bright); }
  .signal-detail { font-size:11px; color:var(--dim); margin-top:3px; }
  .signal-bar { height:4px; border-radius:2px; margin-top:6px; background:rgba(255,255,255,0.06); }
  .signal-bar-fill { height:100%; border-radius:2px; }

  /* Filters */
  .filters { padding:8px 16px; border-bottom:1px solid var(--border); display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .filter-btn { padding:3px 10px; border-radius:3px; border:1px solid var(--border); background:transparent; color:var(--dim); font-size:11px; cursor:pointer; transition:all 0.15s; }
  .filter-btn:hover, .filter-btn.active { border-color:var(--accent); color:var(--accent); background:rgba(41,121,255,0.08); }

  .loading { text-align:center; padding:60px 20px; color:var(--dim); }
  .loading .spinner { display:inline-block; width:24px; height:24px; border:3px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin 0.8s linear infinite; margin-bottom:12px; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .error { text-align:center; padding:40px; color:var(--red); }

  /* Scrollbar */
  ::-webkit-scrollbar { width:6px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  ::-webkit-scrollbar-thumb:hover { background:#2a4a70; }
</style>
</head>
<body>

<div class="top-bar">
  <h1>News Sentiment Dashboard</h1>
  <div style="display:flex;gap:10px;align-items:center;">
    <span class="info" id="fetch-time">Loading...</span>
    <button class="btn btn-accent" onclick="loadNews()">Refresh</button>
  </div>
</div>

<div class="stats-bar" id="stats-bar">
  <div class="stat-card"><div class="label">Total Articles</div><div class="value" id="stat-total">-</div></div>
  <div class="stat-card"><div class="label">Bullish</div><div class="value green" id="stat-bull">-</div></div>
  <div class="stat-card"><div class="label">Bearish</div><div class="value red" id="stat-bear">-</div></div>
  <div class="stat-card"><div class="label">Neutral</div><div class="value" id="stat-neutral">-</div></div>
  <div class="stat-card"><div class="label">Signals</div><div class="value yellow" id="stat-signals">-</div></div>
  <div class="stat-card"><div class="label">Sources</div><div class="value" id="stat-sources" style="font-size:13px;">-</div></div>
</div>

<div class="content">
  <div class="panel">
    <div class="panel-header">
      <span>Articles</span>
      <span id="article-count" style="color:var(--dim);font-weight:normal;font-size:12px;"></span>
    </div>
    <div class="filters" id="filters">
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="bullish">Bullish</button>
      <button class="filter-btn" data-filter="bearish">Bearish</button>
      <button class="filter-btn" data-filter="high-conf">High Confidence</button>
      <button class="filter-btn" data-filter="urgent">Urgent</button>
    </div>
    <div class="panel-body" id="articles-list">
      <div class="loading"><div class="spinner"></div><br>Fetching news...</div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-header">Trading Signals</div>
    <div class="panel-body" id="signals-list">
      <div class="loading"><div class="spinner"></div><br>Analyzing...</div>
    </div>
  </div>
</div>

<script>
let allArticles = [];
let currentFilter = 'all';

function timeAgo(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
  return Math.floor(ms/86400000) + 'd ago';
}

function renderArticles(articles) {
  const el = document.getElementById('articles-list');
  if (!articles.length) { el.innerHTML = '<div class="loading" style="color:var(--dim)">No articles match filter</div>'; return; }
  el.innerHTML = articles.map(a => {
    const sentClass = a.sentiment === 'bullish' ? 'badge-bull' : a.sentiment === 'bearish' ? 'badge-bear' : 'badge-neutral';
    const tickers = (a.tickers||[]).map(t => '<span class="badge badge-ticker">'+t+'</span>').join(' ');
    return '<div class="article">'
      + '<div class="article-header">'
      + '<div class="article-title"><a href="'+a.url+'" target="_blank">'+a.title+'</a></div>'
      + '<div class="article-time">'+timeAgo(a.publishedAt)+'</div>'
      + '</div>'
      + '<div class="article-meta">'
      + '<span class="badge '+sentClass+'">'+a.sentiment+'</span>'
      + '<span class="badge badge-conf">'+a.confidence+'</span>'
      + (a.urgency==='high'?'<span class="badge badge-urg">URGENT</span>':'')
      + '<span class="badge badge-source">'+a.source+'</span>'
      + (a.sectors||[]).map(s=>'<span class="badge badge-source">'+s+'</span>').join('')
      + ' '+tickers
      + '</div>'
      + (a.marketImpact?'<div class="article-impact">'+a.marketImpact+'</div>':'')
      + '</div>';
  }).join('');
  document.getElementById('article-count').textContent = articles.length + ' shown';
}

function renderSignals(signals) {
  const el = document.getElementById('signals-list');
  if (!signals.length) { el.innerHTML = '<div class="loading" style="color:var(--dim)">No signals yet (need 2+ articles per ticker)</div>'; return; }
  el.innerHTML = signals.map(s => {
    const cls = s.direction === 'bullish' ? 'bull' : 'bear';
    const color = s.direction === 'bullish' ? 'var(--green)' : 'var(--red)';
    return '<div class="signal-row">'
      + '<span class="signal-score">'+s.score+'</span>'
      + '<div class="signal-ticker '+cls+'">'+s.ticker+' <span style="font-size:11px;font-weight:normal;color:var(--dim)">'+s.direction.toUpperCase()+'</span></div>'
      + '<div class="signal-detail">'+s.bull+' bullish, '+s.bear+' bearish &mdash; '+s.sources.join(', ')+'</div>'
      + '<div class="signal-detail" style="margin-top:2px;">'+s.topTitle+'</div>'
      + '<div class="signal-bar"><div class="signal-bar-fill" style="width:'+s.score+'%;background:'+color+';"></div></div>'
      + '</div>';
  }).join('');
}

function applyFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  let filtered = allArticles;
  if (filter === 'bullish') filtered = allArticles.filter(a => a.sentiment === 'bullish');
  else if (filter === 'bearish') filtered = allArticles.filter(a => a.sentiment === 'bearish');
  else if (filter === 'high-conf') filtered = allArticles.filter(a => a.confidence === 'high');
  else if (filter === 'urgent') filtered = allArticles.filter(a => a.urgency === 'high');
  renderArticles(filtered);
}

document.getElementById('filters').addEventListener('click', e => {
  if (e.target.classList.contains('filter-btn')) applyFilter(e.target.dataset.filter);
});

async function loadNews() {
  document.getElementById('articles-list').innerHTML = '<div class="loading"><div class="spinner"></div><br>Fetching & analyzing news...</div>';
  document.getElementById('signals-list').innerHTML = '<div class="loading"><div class="spinner"></div><br>Generating signals...</div>';
  try {
    const res = await fetch('/api/news');
    const data = await res.json();
    if (data.error) { document.getElementById('articles-list').innerHTML = '<div class="error">Error: '+data.error+'</div>'; return; }

    allArticles = data.articles || [];
    document.getElementById('stat-total').textContent = data.totalArticles || 0;
    document.getElementById('stat-bull').textContent = data.sentiment?.bullish || 0;
    document.getElementById('stat-bear').textContent = data.sentiment?.bearish || 0;
    document.getElementById('stat-neutral').textContent = data.sentiment?.neutral || 0;
    document.getElementById('stat-signals').textContent = (data.signals||[]).length;
    const srcList = Object.entries(data.sourceCounts||{}).map(([k,v])=>k+': '+v).join(', ');
    document.getElementById('stat-sources').textContent = srcList || '-';
    document.getElementById('fetch-time').textContent = 'Updated: ' + new Date(data.fetchedAt).toLocaleTimeString();

    applyFilter(currentFilter);
    renderSignals(data.signals || []);
  } catch(e) {
    document.getElementById('articles-list').innerHTML = '<div class="error">Failed to load: '+e.message+'</div>';
  }
}

loadNews();
</script>
</body>
</html>`;

// ─── Aggressive Engine Data ─────────────────────────────────────────────────
const AGG_STATE_PATH  = path.join(__dirname, 'trade_history/aggressive_state.json');
const PERF_LEDGER     = path.join(__dirname, 'trade_history/performance_ledger.json');
const AGG_ALLOCATION  = 10000;

async function getAggressiveData() {
  // 1. Read aggressive state file
  let aggState = { positions: [], dailyTrades: [] };
  try {
    if (fs.existsSync(AGG_STATE_PATH)) {
      aggState = JSON.parse(fs.readFileSync(AGG_STATE_PATH, 'utf8'));
    }
  } catch {}

  // 2. Get live Alpaca positions tagged as aggressive
  // State file uses aggressivePositions object: { MRVL: { entryTime, source, score, orderId } }
  const aggPositionMap = aggState.aggressivePositions || {};
  const aggSymbols = new Set(Object.keys(aggPositionMap));

  let livePositions = [];
  try {
    const allPositions = await alpaca('GET', '/positions');
    if (Array.isArray(allPositions)) {
      livePositions = allPositions.filter(p => aggSymbols.has(p.symbol)).map(p => {
        const qty = parseFloat(p.qty || 0);
        const entry = parseFloat(p.avg_entry_price || 0);
        const curr = parseFloat(p.current_price || 0);
        const pnl = parseFloat(p.unrealized_pl || 0);
        const pnlPct = parseFloat(p.unrealized_plpc || 0) * 100;
        const mv = parseFloat(p.market_value || 0);
        // Find entry time from aggState position map
        const statePos = aggPositionMap[p.symbol];
        const entryTime = statePos?.entryTime || null;
        const strategy = statePos?.source || 'aggressive';
        return {
          symbol: p.symbol, qty, entry: entry.toFixed(2), current: curr.toFixed(2),
          pnl: pnl.toFixed(2), pnlPct: pnlPct.toFixed(2), mv: mv.toFixed(2),
          entryTime, strategy, status: 'OPEN',
        };
      });
    }
  } catch {}

  // If no live positions found, fall back to state file
  if (livePositions.length === 0 && aggSymbols.size > 0) {
    livePositions = [...aggSymbols].map(sym => {
      const p = aggPositionMap[sym];
      return {
        symbol: sym, qty: '?', entry: '?', current: '?',
        pnl: '?', pnlPct: '?', mv: '?',
        entryTime: p?.entryTime || null,
        strategy: p?.source || 'aggressive',
        status: 'PENDING',
      };
    });
  }

  // 3. Read performance ledger for aggressive trades
  let allTrades = [];
  try {
    if (fs.existsSync(PERF_LEDGER)) {
      const ledger = JSON.parse(fs.readFileSync(PERF_LEDGER, 'utf8'));
      allTrades = (ledger.trades || []).filter(t => t.isAggressive || t.is_aggressive);
    }
  } catch {}

  // 4. Compute stats
  const deployed = livePositions.reduce((s, p) => s + Math.abs(parseFloat(p.mv || 0)), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = (aggState.dailyTrades || allTrades).filter(t => {
    const tDate = (t.exit_time || t.exitTime || t.entry_time || t.entryTime || '').slice(0, 10);
    return tDate === today;
  });
  const todayPnl = todayTrades.reduce((s, t) => s + parseFloat(t.pnl_dollar || t.pnlDollar || 0), 0);
  const totalPnl = allTrades.reduce((s, t) => s + parseFloat(t.pnl_dollar || t.pnlDollar || 0), 0);

  const wins = allTrades.filter(t => t.is_win || t.isWin);
  const losses = allTrades.filter(t => !t.is_win && !t.isWin);
  const winRate = allTrades.length > 0 ? (wins.length / allTrades.length * 100) : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + parseFloat(t.pnl_pct || t.pnlPct || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + parseFloat(t.pnl_pct || t.pnlPct || 0), 0) / losses.length : 0;

  // 5. Signals pipeline — read from file written by scheduler's signal_cache
  let signals = [];
  try {
    const PIPELINE_FILE = path.join(__dirname, 'trade_history/aggressive_pipeline.json');
    if (fs.existsSync(PIPELINE_FILE)) {
      const pipeline = JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8'));
      signals = (pipeline.candidates || []).map(c => ({
        ticker: c.ticker,
        score: c.netScore,
        source: c.topSource || c.sources?.[0] || '?',
        direction: c.direction || 'bullish',
        reason: c.topReason || '',
      }));
    }
  } catch {}

  // 6. Recent trades (last 10)
  const recentTrades = allTrades.slice(-10).reverse().map(t => ({
    symbol: t.symbol,
    pnl: parseFloat(t.pnl_dollar || t.pnlDollar || 0).toFixed(2),
    pnlPct: parseFloat(t.pnl_pct || t.pnlPct || 0).toFixed(2),
    exitReason: t.exit_reason || t.exitReason || '',
    exitTime: t.exit_time || t.exitTime || '',
  }));

  return {
    allocation: AGG_ALLOCATION,
    deployed: Math.round(deployed),
    positions: livePositions,
    todayTrades: todayTrades.length,
    todayPnl: parseFloat(todayPnl.toFixed(2)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    signals,
    winRate: parseFloat(winRate.toFixed(1)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    recentTrades,
  };
}

// ─── Aggressive Engine Page HTML ────────────────────────────────────────────
const AGGRESSIVE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aggressive Engine — Algo Trader</title>
<style>
  :root { --bg:#060b11; --panel:#0e1824; --border:#1e3050; --accent:#ff6d00; --green:#00e676; --red:#ff5252; --yellow:#ffca28; --text:#ddeeff; --dim:#556b8a; --bright:#ffffff; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI','Courier New',monospace; font-size:13px; }

  .top-bar { background:var(--panel); border-bottom:2px solid var(--accent); padding:14px 24px; display:flex; align-items:center; justify-content:space-between; }
  .top-bar h1 { font-size:16px; color:var(--bright); font-weight:700; }
  .top-bar h1 span { color:var(--accent); }
  .top-bar .alloc { color:var(--dim); font-size:13px; margin-left:16px; }
  .top-bar .alloc strong { color:var(--accent); font-size:14px; }
  .top-bar .info { color:var(--dim); font-size:12px; }
  .btn { padding:6px 14px; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:bold; transition:opacity 0.2s; }
  .btn:hover { opacity:0.85; }
  .btn-accent { background:var(--accent); color:#fff; }

  .stats-bar { display:flex; gap:12px; padding:12px 24px; flex-wrap:wrap; }
  .stat-card { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:12px 18px; min-width:140px; flex:1; }
  .stat-card .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  .stat-card .value { font-size:22px; font-weight:bold; color:var(--bright); }
  .stat-card .value.green { color:var(--green); }
  .stat-card .value.red { color:var(--red); }
  .stat-card .value.orange { color:var(--accent); }

  .content { display:grid; grid-template-columns:1fr 380px; gap:16px; padding:16px 24px; height:calc(100vh - 160px); }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:6px; overflow:hidden; display:flex; flex-direction:column; }
  .panel-header { padding:10px 16px; border-bottom:1px solid var(--border); font-weight:bold; font-size:13px; color:var(--bright); display:flex; justify-content:space-between; align-items:center; }
  .panel-header .badge { background:rgba(255,109,0,0.15); color:var(--accent); border:1px solid rgba(255,109,0,0.3); padding:2px 8px; border-radius:3px; font-size:10px; font-weight:bold; text-transform:uppercase; }
  .panel-body { overflow-y:auto; flex:1; padding:0; }

  /* Tables */
  table { width:100%; border-collapse:collapse; }
  th { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:0.5px; padding:8px 10px; text-align:right; border-bottom:1px solid var(--border); font-weight:600; }
  th:first-child { text-align:left; }
  td { padding:7px 10px; text-align:right; border-bottom:1px solid rgba(30,48,80,0.5); font-variant-numeric:tabular-nums; font-size:13px; color:var(--text); }
  td:first-child { text-align:left; color:var(--bright); font-weight:bold; font-size:14px; }
  tr:hover td { background:rgba(255,109,0,0.05); }
  .pos { color:var(--green); }
  .neg { color:var(--red); }

  /* Countdown badge */
  .hold-badge { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:bold; }
  .hold-ok { background:rgba(0,230,118,0.12); color:var(--green); border:1px solid rgba(0,230,118,0.25); }
  .hold-warn { background:rgba(255,202,40,0.12); color:var(--yellow); border:1px solid rgba(255,202,40,0.25); }
  .hold-danger { background:rgba(255,82,82,0.12); color:var(--red); border:1px solid rgba(255,82,82,0.25); }

  /* Signal rows */
  .signal-row { padding:8px 16px; border-bottom:1px solid rgba(30,48,80,0.4); display:flex; align-items:center; gap:10px; }
  .signal-row:hover { background:rgba(255,109,0,0.04); }
  .signal-ticker { font-size:14px; font-weight:bold; color:var(--bright); min-width:50px; }
  .signal-score { font-size:16px; font-weight:bold; color:var(--accent); min-width:36px; text-align:right; }
  .signal-meta { font-size:11px; color:var(--dim); flex:1; }
  .signal-dir { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:bold; text-transform:uppercase; }
  .signal-dir.bull { background:rgba(0,230,118,0.12); color:var(--green); }
  .signal-dir.bear { background:rgba(255,82,82,0.12); color:var(--red); }

  /* Trade rows */
  .trade-row { padding:6px 16px; border-bottom:1px solid rgba(30,48,80,0.4); display:flex; align-items:center; justify-content:space-between; font-size:12px; }
  .trade-row:hover { background:rgba(255,109,0,0.04); }
  .trade-sym { font-weight:bold; color:var(--bright); min-width:50px; }
  .trade-pnl { font-weight:bold; min-width:70px; text-align:right; }
  .trade-reason { color:var(--dim); font-size:11px; }
  .trade-time { color:var(--dim); font-size:11px; min-width:70px; text-align:right; }

  .empty-state { text-align:center; padding:40px 20px; color:var(--dim); }
  .empty-state .icon { font-size:32px; margin-bottom:8px; }

  .right-col { display:flex; flex-direction:column; gap:16px; }

  /* Scrollbar */
  ::-webkit-scrollbar { width:6px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
  ::-webkit-scrollbar-thumb:hover { background:#2a4a70; }

  .spinner { display:inline-block; width:20px; height:20px; border:3px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin 0.8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>

<div class="top-bar">
  <div style="display:flex;align-items:center;">
    <h1><span>&#9889;</span> Aggressive Engine Dashboard</h1>
    <span class="alloc">Allocation: <strong id="alloc-display">$10,000 (10%)</strong></span>
  </div>
  <div style="display:flex;gap:10px;align-items:center;">
    <span class="info" id="last-update">Loading...</span>
    <button class="btn btn-accent" onclick="loadData()">Refresh</button>
  </div>
</div>

<div class="stats-bar" id="stats-bar">
  <div class="stat-card"><div class="label">Deployed Capital</div><div class="value orange" id="stat-deployed">-</div></div>
  <div class="stat-card"><div class="label">Today's P&amp;L</div><div class="value" id="stat-today-pnl">-</div></div>
  <div class="stat-card"><div class="label">Total P&amp;L</div><div class="value" id="stat-total-pnl">-</div></div>
  <div class="stat-card"><div class="label">Win Rate</div><div class="value" id="stat-winrate">-</div></div>
  <div class="stat-card"><div class="label">Active Positions</div><div class="value orange" id="stat-positions">-</div></div>
  <div class="stat-card"><div class="label">Today's Trades</div><div class="value" id="stat-today-trades">-</div></div>
</div>

<div class="content">
  <div class="panel">
    <div class="panel-header">
      <span>Active Positions</span>
      <span class="badge" id="pos-count-badge">0</span>
    </div>
    <div class="panel-body" id="positions-table">
      <div class="empty-state"><div class="spinner"></div><br>Loading...</div>
    </div>
  </div>

  <div class="right-col">
    <div class="panel" style="flex:1;">
      <div class="panel-header">
        <span>Signal Pipeline</span>
        <span class="badge" id="signal-count-badge">0</span>
      </div>
      <div class="panel-body" id="signals-list">
        <div class="empty-state"><div class="spinner"></div><br>Loading...</div>
      </div>
    </div>

    <div class="panel" style="flex:1;">
      <div class="panel-header">
        <span>Recent Trades</span>
        <span class="badge" id="trade-count-badge">0</span>
      </div>
      <div class="panel-body" id="trades-list">
        <div class="empty-state"><div class="spinner"></div><br>Loading...</div>
      </div>
    </div>
  </div>
</div>

<script>
function fmt(v) { return parseFloat(v).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtDollar(v) { return '$' + fmt(Math.abs(v)); }
function sign(v) { return v >= 0 ? '+' : ''; }
function pnlClass(v) { return parseFloat(v) >= 0 ? 'pos' : 'neg'; }

function holdTime(entryTime) {
  if (!entryTime) return { text: '--', hoursLeft: 48 };
  const ms = Date.now() - new Date(entryTime).getTime();
  const hours = ms / 3600000;
  const hoursLeft = Math.max(0, 48 - hours);
  if (hours < 1) return { text: Math.floor(ms/60000) + 'm', hoursLeft };
  if (hours < 48) return { text: hours.toFixed(1) + 'h', hoursLeft };
  return { text: Math.floor(hours) + 'h', hoursLeft: 0 };
}

function holdBadge(hoursLeft) {
  if (hoursLeft <= 0) return '<span class="hold-badge hold-danger">EXPIRED</span>';
  if (hoursLeft <= 6) return '<span class="hold-badge hold-danger">' + hoursLeft.toFixed(1) + 'h left</span>';
  if (hoursLeft <= 12) return '<span class="hold-badge hold-warn">' + hoursLeft.toFixed(1) + 'h left</span>';
  return '<span class="hold-badge hold-ok">' + hoursLeft.toFixed(1) + 'h left</span>';
}

function renderPositions(positions) {
  const el = document.getElementById('positions-table');
  document.getElementById('pos-count-badge').textContent = positions.length;
  if (!positions.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">&#128203;</div>No active aggressive positions</div>';
    return;
  }
  let html = '<table><thead><tr><th>Ticker</th><th>Qty</th><th>Entry</th><th>Current</th><th>P&L%</th><th>P&L$</th><th>Hold Time</th><th>Strategy</th><th>Status</th></tr></thead><tbody>';
  for (const p of positions) {
    const pnlPct = parseFloat(p.pnlPct);
    const pnlDollar = parseFloat(p.pnl);
    const cls = pnlClass(pnlPct);
    const hold = holdTime(p.entryTime);
    const strat = (p.strategy || '').length > 20 ? (p.strategy.slice(0,20) + '...') : (p.strategy || '-');
    html += '<tr>'
      + '<td>' + p.symbol + '</td>'
      + '<td>' + p.qty + '</td>'
      + '<td>$' + p.entry + '</td>'
      + '<td>$' + p.current + '</td>'
      + '<td class="' + cls + '">' + sign(pnlPct) + fmt(pnlPct) + '%</td>'
      + '<td class="' + cls + '">' + sign(pnlDollar) + fmtDollar(pnlDollar) + '</td>'
      + '<td>' + hold.text + ' ' + holdBadge(hold.hoursLeft) + '</td>'
      + '<td style="font-size:11px;color:var(--dim);">' + strat + '</td>'
      + '<td><span class="hold-badge hold-ok">' + (p.status || 'OPEN') + '</span></td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderSignals(signals) {
  const el = document.getElementById('signals-list');
  document.getElementById('signal-count-badge').textContent = signals.length;
  if (!signals.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">&#128225;</div>No signals in pipeline</div>';
    return;
  }
  const sorted = signals.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  el.innerHTML = sorted.map(s => {
    const dirClass = (s.direction || '').toLowerCase() === 'bearish' ? 'bear' : 'bull';
    return '<div class="signal-row">'
      + '<span class="signal-ticker">' + (s.ticker || s.symbol || '?') + '</span>'
      + '<span class="signal-score">' + (s.score || 0) + '</span>'
      + '<span class="signal-meta">' + (s.source || s.strategy || '-') + '</span>'
      + '<span class="signal-dir ' + dirClass + '">' + (s.direction || 'LONG') + '</span>'
      + '</div>';
  }).join('');
}

function renderTrades(trades) {
  const el = document.getElementById('trades-list');
  document.getElementById('trade-count-badge').textContent = trades.length;
  if (!trades.length) {
    el.innerHTML = '<div class="empty-state"><div class="icon">&#128200;</div>No aggressive trades yet</div>';
    return;
  }
  el.innerHTML = trades.map(t => {
    const pnl = parseFloat(t.pnl);
    const cls = pnlClass(pnl);
    const time = t.exitTime ? new Date(t.exitTime).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '-';
    return '<div class="trade-row">'
      + '<span class="trade-sym">' + t.symbol + '</span>'
      + '<span class="trade-reason">' + (t.exitReason || '-') + '</span>'
      + '<span class="trade-time">' + time + '</span>'
      + '<span class="trade-pnl ' + cls + '">' + sign(pnl) + fmtDollar(pnl) + ' (' + sign(parseFloat(t.pnlPct)) + t.pnlPct + '%)</span>'
      + '</div>';
  }).join('');
}

async function loadData() {
  try {
    const res = await fetch('/api/aggressive');
    const data = await res.json();

    // Allocation
    document.getElementById('alloc-display').textContent = '$' + (data.allocation||10000).toLocaleString() + ' (10%)';

    // Stats bar
    document.getElementById('stat-deployed').textContent = '$' + (data.deployed||0).toLocaleString();
    const todayPnl = data.todayPnl || 0;
    const todayEl = document.getElementById('stat-today-pnl');
    todayEl.textContent = sign(todayPnl) + fmtDollar(todayPnl);
    todayEl.className = 'value ' + (todayPnl >= 0 ? 'green' : 'red');

    const totalPnl = data.totalPnl || 0;
    const totalEl = document.getElementById('stat-total-pnl');
    totalEl.textContent = sign(totalPnl) + fmtDollar(totalPnl);
    totalEl.className = 'value ' + (totalPnl >= 0 ? 'green' : 'red');

    const wr = data.winRate || 0;
    const wrEl = document.getElementById('stat-winrate');
    wrEl.textContent = wr.toFixed(1) + '%';
    wrEl.className = 'value ' + (wr >= 50 ? 'green' : wr >= 30 ? 'orange' : 'red');

    document.getElementById('stat-positions').textContent = (data.positions||[]).length;
    document.getElementById('stat-today-trades').textContent = data.todayTrades || 0;

    // Panels
    renderPositions(data.positions || []);
    renderSignals(data.signals || []);
    renderTrades(data.recentTrades || []);

    document.getElementById('last-update').textContent = 'Updated: ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('last-update').textContent = 'Error: ' + e.message;
  }
}

// Initial load + auto-refresh every 10s
loadData();
setInterval(loadData, 10000);
</script>
</body>
</html>`;

// ─── Server ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  } else if (req.url === '/api/status') {
    try {
      const data = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url.startsWith('/api/equity-history')) {
    try {
      const data = getEquityHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/cancel-orders' && req.method === 'POST') {
    try {
      console.log('[Dashboard] CANCEL ORDERS activated at', new Date().toISOString());
      const cancelRes = await fetch(ALPACA_URL + '/v2/orders', {
        method: 'DELETE',
        headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
      });
      const cancelStatus = cancelRes.status;
      const result = {
        success: true,
        ordersCancelled: (cancelStatus === 207 || cancelStatus === 200) ? 'success' : `status ${cancelStatus}`,
        timestamp: new Date().toISOString(),
      };
      console.log('[Dashboard] Cancel orders result:', JSON.stringify(result));
      logAlert('CANCEL_ORDERS', { ordersCancelled: result.ordersCancelled });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[Dashboard] Cancel orders error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/close-positions' && req.method === 'POST') {
    try {
      console.log('[Dashboard] CLOSE POSITIONS activated at', new Date().toISOString());
      const closeRes = await fetch(ALPACA_URL + '/v2/positions?cancel_orders=true', {
        method: 'DELETE',
        headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
      });
      let closedPositions = [];
      try { closedPositions = await closeRes.json(); } catch {}
      const result = {
        success: true,
        positionsClosed: Array.isArray(closedPositions) ? closedPositions.length : 'done',
        timestamp: new Date().toISOString(),
      };
      console.log('[Dashboard] Close positions result:', JSON.stringify(result));
      logAlert('CLOSE_POSITIONS', { positionsClosed: result.positionsClosed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[Dashboard] Close positions error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/resume-scheduler' && req.method === 'POST') {
    try {
      if (fs.existsSync(HALT_FLAG)) fs.unlinkSync(HALT_FLAG);
      console.log('[Dashboard] Scheduler halt flag cleared at', new Date().toISOString());
      logAlert('SCHEDULER_RESUMED', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, resumed: true, timestamp: new Date().toISOString() }));
    } catch (e) {
      console.error('[Dashboard] Resume scheduler error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/kill' && req.method === 'POST') {
    try {
      console.log('[Dashboard] FULL KILL SWITCH activated at', new Date().toISOString());

      // Step 1: Write halt flag to stop scheduler on next tick
      let schedulerHalted = false;
      try {
        fs.writeFileSync(HALT_FLAG, new Date().toISOString());
        schedulerHalted = true;
        console.log('[Dashboard] Halt flag written');
      } catch (haltErr) {
        console.error('[Dashboard] Failed to write halt flag:', haltErr.message);
      }

      // Step 2: Cancel all open orders
      const cancelRes = await fetch(ALPACA_URL + '/v2/orders', {
        method: 'DELETE',
        headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
      });
      const cancelStatus = cancelRes.status;

      // Step 3: Close all positions
      const closeRes = await fetch(ALPACA_URL + '/v2/positions?cancel_orders=true', {
        method: 'DELETE',
        headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
      });
      let closedPositions = [];
      try { closedPositions = await closeRes.json(); } catch {}

      const result = {
        success: true,
        schedulerHalted,
        ordersCancelled: (cancelStatus === 207 || cancelStatus === 200) ? 'success' : `status ${cancelStatus}`,
        positionsClosed: Array.isArray(closedPositions) ? closedPositions.length : 'done',
        timestamp: new Date().toISOString(),
      };

      console.log('[Dashboard] Full kill switch result:', JSON.stringify(result));
      logAlert('KILL_SWITCH', {
        schedulerHalted: result.schedulerHalted,
        ordersCancelled: result.ordersCancelled,
        positionsClosed: result.positionsClosed,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[Dashboard] Kill switch error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/api/aggressive') {
    try {
      const data = await getAggressiveData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/aggressive') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(AGGRESSIVE_HTML);
  } else if (req.url === '/api/news') {
    try {
      const data = await getNewsData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url === '/news') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(NEWS_HTML);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Dashboard] Port ${PORT} in use — retrying in 10s...`);
    setTimeout(() => server.listen(PORT, '127.0.0.1'), 10000);
  } else {
    console.error('[Dashboard] Server error:', err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
});

// Prevent any unhandled async error from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[Dashboard] Uncaught exception (kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Dashboard] Unhandled rejection (kept alive):', reason);
});
