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
  const isAlive      = schedulerAge !== null && schedulerAge < 360; // dead if no cycle in 6 min

  // Watchdog restarts
  const wdLines    = readLastLines(WATCHDOG_LOG, 50);
  const restarts   = wdLines.filter(l => l.includes('restart #') && !l.includes('restart #0')).length;
  const wdOnline   = wdLines.some(l => l.includes('Watchdog online'));

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

  return {
    isAlive, lastCycleTime, nextCycleMs, schedulerAge,
    restarts, wdOnline, slowSigs, fastSigs, fastRefreshTime,
    activityLines
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
    const mv    = parseFloat(p.market_value || 0);
    const pnl   = parseFloat(p.unrealized_pl || 0);
    const pnlPct = parseFloat(p.unrealized_plpc || 0) * 100;
    const entry = parseFloat(p.avg_entry_price || 0);
    const curr  = parseFloat(p.current_price || 0);
    const stop  = ord.find(o => o.symbol === p.symbol && o.side === 'sell' && o.type === 'trailing_stop');
    return {
      symbol: p.symbol, qty: p.qty, entry: entry.toFixed(2),
      current: curr.toFixed(2), mv: mv.toFixed(0),
      pnl: pnl.toFixed(2), pnlPct: pnlPct.toFixed(2),
      stopPrice: stop ? parseFloat(stop.stop_price).toFixed(2) : '—',
      trailPct: stop ? stop.trail_percent + '%' : '—',
    };
  }).sort((a, b) => parseFloat(b.mv) - parseFloat(a.mv));

  return { equity, bp, dayPnl, dayPnlPct, totalPnl, totalPnlPct, unrealizedPnl, invested, exposure, positions: posData, openOrders: ord.length };
}

async function getStatus() {
  const [api, sched] = await Promise.all([getApiData(), Promise.resolve(getSchedulerInfo())]);
  return {
    time: etTime(),
    marketStatus: marketStatus(),
    ...api,
    scheduler: sched,
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
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo">⬡ ALGO TRADER</div>
    <div id="market-badge" class="market-badge badge-closed">LOADING</div>
    <div class="et-time" id="et-time">-- : -- : -- ET</div>
  </div>
  <div class="last-update" id="last-update">Connecting...</div>
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
    setDot('dot-scheduler', data.scheduler.isAlive ? 'green' : 'red');
    document.getElementById('status-scheduler').textContent = data.scheduler.isAlive
      ? (data.scheduler.schedulerAge + 's ago') : 'OFFLINE';
    setDot('dot-watchdog', data.scheduler.wdOnline ? (data.scheduler.restarts > 0 ? 'yellow' : 'green') : 'red');
    document.getElementById('status-watchdog').textContent = data.scheduler.wdOnline
      ? (data.scheduler.restarts > 0 ? data.scheduler.restarts + ' restart(s)' : 'Running') : 'Offline';

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
        const up     = parseFloat(p.pnlPct) >= 0;
        const ar     = up ? '▲' : '▼';
        const badge  = up ? 'pnl-badge pnl-badge-green' : 'pnl-badge pnl-badge-red';
        const isTiny = parseFloat(p.mv) < 1000;
        const priceArrow = parseFloat(p.current) >= parseFloat(p.entry)
          ? '<span style="color:var(--green);margin-left:4px">▲</span>'
          : '<span style="color:var(--red);margin-left:4px">▼</span>';
        return \`<tr>
          <td>\${p.symbol}\${isTiny ? ' <span class="tag-tiny">(legacy)</span>' : ''}</td>
          <td>\${p.qty}</td>
          <td>$\${p.entry}</td>
          <td>$\${p.current}\${priceArrow}</td>
          <td>$\${parseInt(p.mv).toLocaleString()}</td>
          <td><span class="\${badge}">\${ar} \${p.pnlPct >= 0 ? '+' : ''}\${p.pnlPct}%</span><br><span style="font-size:11px;color:\${up?'var(--green)':'var(--red)'}">\${p.pnl >= 0 ? '+' : ''}$\${fmt(p.pnl)}</span></td>
          <td style="color:var(--dim)">\${p.stopPrice !== '—' ? '$'+p.stopPrice : '—'}</td>
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
