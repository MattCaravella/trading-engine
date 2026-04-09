const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const i = line.indexOf('=');
  if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
});

const ALPACA_KEY          = process.env.ALPACA_API_KEY;
const ALPACA_SECRET       = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL          = process.env.ALPACA_BASE_URL;
const SUMMARIES_DIR       = 'C:\\Users\\Matth\\OneDrive\\TradingSummaries';
const SUMMARIES_DIR_LOCAL = path.join(__dirname, 'trade_history', 'summaries');
const HARD_STOP_PCT       = 6;
const INITIAL_EQUITY      = 100000;

const { recordDailySnapshot, getPerformanceReport } = require('./performance_tracker');

async function alpaca(endpoint) {
  const res = await fetch(`${ALPACA_URL}/v2${endpoint}`, {
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
  });
  return res.json();
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch { return []; }
}

function findOpenDate(symbol) {
  try {
    const dir   = path.join(__dirname, 'trade_history');
    const files = fs.readdirSync(dir).filter(f => f.includes(`_${symbol}_buy_`) && f.endsWith('.json'));
    if (!files.length) return '—';
    files.sort();
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[0])));
    const d = new Date(data.created_at || data.submitted_at);
    return d.toISOString().slice(0, 10);
  } catch { return '—'; }
}

function findTradeJson(orderId) {
  try {
    const dir   = path.join(__dirname, 'trade_history');
    const files = fs.readdirSync(dir).filter(f => f.includes((orderId || '').slice(0, 8)));
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, files[0])));
  } catch { return null; }
}

const col  = v => parseFloat(v) >= 0 ? '#22c55e' : '#ef4444';
const sign = v => parseFloat(v) >= 0 ? '+' : '';
const fmt  = (n, d = 2) => parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

async function generateSummary() {
  const date = new Date().toISOString().slice(0, 10);
  const nowStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
  }).format(new Date());

  const [account, positions, ordersToday, ordersOpen] = await Promise.all([
    alpaca('/account'),
    alpaca('/positions'),
    alpaca(`/orders?status=closed&after=${date}T00:00:00Z&limit=200`),
    alpaca('/orders?status=open&limit=100'),
  ]);

  const equity     = parseFloat(account.equity || 0);
  const lastEquity = parseFloat(account.last_equity || equity);
  const buyPow     = parseFloat(account.buying_power || 0);
  const dayPnL     = equity - lastEquity;
  const dayPnLPct  = lastEquity > 0 ? (dayPnL / lastEquity) * 100 : 0;
  const totalPnL   = equity - INITIAL_EQUITY;
  const totalPnLPct = (totalPnL / INITIAL_EQUITY) * 100;

  const pos    = Array.isArray(positions) ? positions : [];
  const filled = Array.isArray(ordersToday) ? ordersToday.filter(o => o.status === 'filled') : [];
  const opens  = Array.isArray(ordersOpen) ? ordersOpen : [];
  const buys   = filled.filter(o => o.side === 'buy');
  const sells  = filled.filter(o => o.side === 'sell');

  const invested  = pos.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
  const exposure  = equity > 0 ? (invested / equity * 100) : 0;
  const unrealPnL = pos.reduce((s, p) => s + parseFloat(p.unrealized_pl || 0), 0);
  const unrealPct = (invested - unrealPnL) > 0 ? (unrealPnL / (invested - unrealPnL) * 100) : 0;

  // Cycle log
  const cycleLog    = readJsonl(path.join(__dirname, 'trade_history/cycle_log.jsonl'));
  const todayCycles = cycleLog.filter(c => c.timestamp && c.timestamp.startsWith(date));
  const cycleCount  = todayCycles.length;
  const equities    = todayCycles.map(c => c.equity).filter(Boolean);
  const eqMin       = equities.length ? Math.min(...equities) : equity;
  const eqMax       = equities.length ? Math.max(...equities) : equity;
  const totalRej    = todayCycles.reduce((s, c) => s + (c.rejected || 0), 0);
  const totalExec   = todayCycles.reduce((s, c) => s + (c.executed || 0), 0);
  const rejByType   = {};
  for (const c of todayCycles) {
    for (const [k, v] of Object.entries(c.rejections || {})) {
      rejByType[k] = (rejByType[k] || 0) + v;
    }
  }

  // Signal transitions
  const transitions = readJsonl(path.join(__dirname, 'trade_history/signal_transitions.jsonl'));
  const todaySigs   = transitions.filter(t => t.at && new Date(t.at).toISOString().startsWith(date));
  const sigByState  = {};
  const sigBySource = {};
  const tickersSet  = new Set();
  for (const t of todaySigs) {
    if (t.to)     sigByState[t.to]       = (sigByState[t.to] || 0) + 1;
    if (t.source) sigBySource[t.source]  = (sigBySource[t.source] || 0) + 1;
    if (t.ticker) tickersSet.add(t.ticker);
  }

  // Position rows
  const posRows = pos.map(p => {
    const entry      = parseFloat(p.avg_entry_price || 0);
    const curr       = parseFloat(p.current_price || 0);
    const qty        = parseFloat(p.qty || 0);
    const pnlAmt     = parseFloat(p.unrealized_pl || 0);
    const pnlPct     = parseFloat(p.unrealized_plpc || 0) * 100;
    const stopOrd    = opens.find(o => o.symbol === p.symbol && o.side === 'sell' && o.type === 'trailing_stop');
    const stopPx     = stopOrd ? parseFloat(stopOrd.stop_price) : null;
    const initStop   = entry * (1 - HARD_STOP_PCT / 100);
    const isTrailing = stopPx !== null && stopPx > initStop * 1.005;
    const stopState  = stopPx === null ? 'NONE' : isTrailing ? 'TRAILING' : 'INITIAL';
    const rMult      = (pnlPct / HARD_STOP_PCT).toFixed(2);
    const openDate   = findOpenDate(p.symbol);
    return { symbol: p.symbol, qty, entry, curr, pnlAmt, pnlPct, stopPx, stopState, rMult, openDate };
  }).sort((a, b) => b.pnlAmt - a.pnlAmt);

  // Record snapshot
  recordDailySnapshot(equity, pos.length, buys.length, sells.length);

  const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Digest — ${date}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:24px; max-width:1000px; margin:0 auto; }
  h1  { font-size:1.5rem; margin-bottom:4px; color:#f8fafc; }
  h2  { font-size:0.85rem; color:#94a3b8; margin-bottom:14px; border-bottom:1px solid #1e293b; padding-bottom:8px; text-transform:uppercase; letter-spacing:.08em; font-weight:600; }
  .subtitle { color:#64748b; font-size:0.83rem; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:#1e293b; border-radius:10px; padding:16px; }
  .card-label { color:#64748b; font-size:0.7rem; text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
  .card-value { font-size:1.4rem; font-weight:700; color:#f8fafc; line-height:1.2; }
  .card-sub   { color:#94a3b8; font-size:0.75rem; margin-top:4px; }
  .section { margin-bottom:28px; }
  table { width:100%; border-collapse:collapse; font-size:0.82rem; }
  th { text-align:left; color:#64748b; font-size:0.68rem; text-transform:uppercase; letter-spacing:.06em; padding:8px 10px; border-bottom:2px solid #334155; white-space:nowrap; }
  td { padding:8px 10px; border-bottom:1px solid #1e293b; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:#1e293b66; }
  .badge { display:inline-block; padding:2px 9px; border-radius:10px; font-size:0.7rem; font-weight:700; letter-spacing:.03em; }
  .badge-trailing { background:#14532d33; color:#22c55e; border:1px solid #14532d88; }
  .badge-initial  { background:#78350f33; color:#f59e0b; border:1px solid #78350f88; }
  .badge-none     { background:#1e293b;   color:#64748b; border:1px solid #33415588; }
  .row-kv { display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid #1e293b; font-size:0.8rem; }
  .row-kv:last-child { border-bottom:none; }
  .alert { border-radius:8px; padding:12px 16px; margin-bottom:20px; font-size:0.83rem; }
  .alert-green  { background:#14532d22; border:1px solid #14532d88; color:#86efac; }
  .alert-yellow { background:#78350f22; border:1px solid #78350f88; color:#fcd34d; }
  .ticker-pill  { display:inline-block; background:#1e293b; border:1px solid #334155; border-radius:4px; padding:2px 7px; margin:2px; font-size:0.75rem; color:#93c5fd; }
  .footer { color:#475569; font-size:0.72rem; text-align:center; margin-top:32px; padding-top:16px; border-top:1px solid #1e293b; }
</style>
</head>
<body>

<h1>⬡ Algo Trader — Daily Digest</h1>
<div class="subtitle">Generated ${nowStr} &nbsp;|&nbsp; Paper Trading &nbsp;|&nbsp; 498 Tickers Universe</div>

${dayPnL >= 0
  ? `<div class="alert alert-green">✓ Positive day: ${sign(dayPnL)}$${fmt(Math.abs(dayPnL))} (${sign(dayPnLPct)}${fmt(dayPnLPct)}%) &nbsp;|&nbsp; Overall account ${sign(totalPnL)}$${fmt(Math.abs(totalPnL))} since inception.</div>`
  : `<div class="alert alert-yellow">⚠ Negative day: ${sign(dayPnL)}$${fmt(Math.abs(dayPnL))} (${sign(dayPnLPct)}${fmt(dayPnLPct)}%) &nbsp;|&nbsp; Monitor open positions closely.</div>`
}

<div class="section">
<h2>Portfolio Overview</h2>
<div class="grid">
  <div class="card">
    <div class="card-label">Equity</div>
    <div class="card-value">$${fmt(equity)}</div>
    <div class="card-sub">Started $${fmt(INITIAL_EQUITY, 0)}</div>
  </div>
  <div class="card">
    <div class="card-label">Day P&L</div>
    <div class="card-value" style="color:${col(dayPnL)}">${sign(dayPnL)}$${fmt(Math.abs(dayPnL))}</div>
    <div class="card-sub" style="color:${col(dayPnLPct)}">${sign(dayPnLPct)}${fmt(dayPnLPct)}% vs yesterday</div>
  </div>
  <div class="card">
    <div class="card-label">Total P&L</div>
    <div class="card-value" style="color:${col(totalPnL)}">${sign(totalPnL)}$${fmt(Math.abs(totalPnL))}</div>
    <div class="card-sub" style="color:${col(totalPnLPct)}">${sign(totalPnLPct)}${fmt(totalPnLPct)}% overall</div>
  </div>
  <div class="card">
    <div class="card-label">Unrealized P&L</div>
    <div class="card-value" style="color:${col(unrealPnL)}">${sign(unrealPnL)}$${fmt(Math.abs(unrealPnL))}</div>
    <div class="card-sub">${sign(unrealPct)}${fmt(unrealPct)}% on open cost</div>
  </div>
  <div class="card">
    <div class="card-label">Deployment</div>
    <div class="card-value">${fmt(exposure, 1)}%</div>
    <div class="card-sub">Target: 96% &nbsp;|&nbsp; $${fmt(invested, 0)} in</div>
  </div>
  <div class="card">
    <div class="card-label">Positions</div>
    <div class="card-value">${pos.length} / 20</div>
    <div class="card-sub">Buys: ${buys.length} &nbsp;|&nbsp; Sells: ${sells.length} today</div>
  </div>
</div>
</div>

<div class="section">
<h2>Open Positions (${posRows.length})</h2>
<div class="card" style="overflow-x:auto">
<table>
<thead><tr>
  <th>Ticker</th><th>Qty</th><th>Entry</th><th>Current</th><th>Stop</th><th>Stop State</th><th>P&L</th><th>R-Mult</th><th>Opened</th>
</tr></thead>
<tbody>
${posRows.length === 0
  ? '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:20px">No open positions</td></tr>'
  : posRows.map(p => `  <tr>
    <td style="font-weight:700;color:#f8fafc">${p.symbol}</td>
    <td style="color:#94a3b8">${p.qty}</td>
    <td>$${fmt(p.entry)}</td>
    <td style="color:${p.curr >= p.entry ? '#22c55e' : '#ef4444'}">$${fmt(p.curr)}</td>
    <td style="color:#64748b">${p.stopPx !== null ? '$' + fmt(p.stopPx) : '—'}</td>
    <td><span class="badge badge-${p.stopState.toLowerCase()}">${p.stopState}</span></td>
    <td style="font-weight:600;color:${col(p.pnlPct)}">${sign(p.pnlAmt)}$${fmt(Math.abs(p.pnlAmt))} (${sign(p.pnlPct)}${fmt(p.pnlPct)}%)</td>
    <td style="color:${col(p.rMult)};font-weight:600">${sign(p.rMult)}${p.rMult}R</td>
    <td style="color:#64748b">${p.openDate}</td>
  </tr>`).join('\n')
}
</tbody>
</table>
</div>
</div>

${buys.length > 0 ? `<div class="section">
<h2>Buys Today (${buys.length})</h2>
<div class="card" style="overflow-x:auto">
<table>
<thead><tr><th>Ticker</th><th>Qty</th><th>Fill Price</th><th>Total Value</th><th>Signal Reason</th></tr></thead>
<tbody>
${buys.map(o => {
  const qty = parseFloat(o.filled_qty || o.qty || 0);
  const px  = parseFloat(o.filled_avg_price || 0);
  const jf  = findTradeJson(o.id);
  return `  <tr>
    <td style="font-weight:700;color:#22c55e">${o.symbol}</td>
    <td>${qty}</td>
    <td>$${fmt(px)}</td>
    <td>$${fmt(qty * px)}</td>
    <td style="color:#94a3b8;font-size:0.78rem">${(jf?.engine_reason || '—').slice(0, 90)}</td>
  </tr>`;
}).join('\n')}
</tbody>
</table>
</div>
</div>` : ''}

${sells.length > 0 ? `<div class="section">
<h2>Sells Today (${sells.length})</h2>
<div class="card" style="overflow-x:auto">
<table>
<thead><tr><th>Ticker</th><th>Qty</th><th>Fill Price</th><th>Total Value</th><th>Exit Type</th></tr></thead>
<tbody>
${sells.map(o => {
  const qty  = parseFloat(o.filled_qty || o.qty || 0);
  const px   = parseFloat(o.filled_avg_price || 0);
  const type = o.type === 'trailing_stop' ? 'Trailing Stop' : o.type === 'stop' ? 'Hard Stop' : 'Market Sell';
  const tCol = o.type === 'trailing_stop' ? '#22c55e' : o.type === 'stop' ? '#ef4444' : '#94a3b8';
  return `  <tr>
    <td style="font-weight:700;color:#ef4444">${o.symbol}</td>
    <td>${qty}</td>
    <td>$${fmt(px)}</td>
    <td>$${fmt(qty * px)}</td>
    <td style="color:${tCol}">${type}</td>
  </tr>`;
}).join('\n')}
</tbody>
</table>
</div>
</div>` : ''}

<div class="section">
<h2>Cycle Summary</h2>
<div class="grid">
  <div class="card">
    <div class="card-label">Cycles Run</div>
    <div class="card-value">${cycleCount}</div>
    <div class="card-sub">~5 min intervals</div>
  </div>
  <div class="card">
    <div class="card-label">Equity Range</div>
    <div class="card-value" style="font-size:0.95rem">$${fmt(eqMin)} – $${fmt(eqMax)}</div>
    <div class="card-sub">Swing: $${fmt(eqMax - eqMin)}</div>
  </div>
  <div class="card">
    <div class="card-label">Trades Executed</div>
    <div class="card-value" style="color:#22c55e">${totalExec}</div>
    <div class="card-sub">${totalRej} signals rejected</div>
  </div>
  <div class="card">
    <div class="card-label">Rejections by Type</div>
    <div style="margin-top:6px">
      ${Object.entries(rejByType).filter(([, v]) => v > 0).length === 0
        ? '<div style="color:#64748b;font-size:0.8rem">None</div>'
        : Object.entries(rejByType).filter(([, v]) => v > 0).map(([k, v]) =>
            `<div class="row-kv"><span style="color:#94a3b8;font-size:0.78rem">${k}</span><span style="font-weight:600">${v}</span></div>`
          ).join('')
      }
    </div>
  </div>
</div>
</div>

<div class="section">
<h2>Signal Activity</h2>
<div class="grid">
  <div class="card">
    <div class="card-label">Total Signals Today</div>
    <div class="card-value">${todaySigs.length}</div>
    <div class="card-sub">${tickersSet.size} unique tickers</div>
  </div>
  <div class="card">
    <div class="card-label">Signal Outcomes</div>
    <div style="margin-top:6px">
      ${Object.entries(sigByState).sort(([, a], [, b]) => b - a).map(([k, v]) => {
        const c2 = k === 'EXECUTED' ? '#22c55e' : k.includes('RISK') ? '#f59e0b' : k.includes('GOVERNOR') ? '#94a3b8' : '#64748b';
        return `<div class="row-kv"><span style="color:${c2};font-size:0.78rem">${k}</span><span style="font-weight:600">${v}</span></div>`;
      }).join('') || '<div style="color:#64748b;font-size:0.8rem">No data yet</div>'}
    </div>
  </div>
  <div class="card">
    <div class="card-label">By Strategy</div>
    <div style="margin-top:6px">
      ${Object.entries(sigBySource).sort(([, a], [, b]) => b - a).map(([k, v]) =>
        `<div class="row-kv"><span style="font-size:0.78rem">${k}</span><span style="font-weight:600">${v}</span></div>`
      ).join('') || '<div style="color:#64748b;font-size:0.8rem">No data yet</div>'}
    </div>
  </div>
</div>
${tickersSet.size > 0 ? `<div style="background:#1e3a5f33;border:1px solid #1e3a5f88;border-radius:8px;padding:10px 14px;margin-top:0">
  <div style="color:#64748b;font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Tickers Signaled</div>
  <div>${[...tickersSet].sort().map(t => `<span class="ticker-pill">${t}</span>`).join('')}</div>
</div>` : ''}
</div>

<div class="section">
<h2>Data Sources</h2>
<div class="card">
  <div class="row-kv"><span>Alpaca (Account + Positions)</span><span style="color:#22c55e;font-size:0.78rem">✓ Live</span><span style="color:#64748b;font-size:0.75rem">${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</span></div>
  <div class="row-kv"><span>QuiverQuant Congress</span><span style="color:#94a3b8;font-size:0.78rem">Slow — daily pre-market</span></div>
  <div class="row-kv"><span>QuiverQuant Gov Contracts</span><span style="color:#94a3b8;font-size:0.78rem">Slow — daily pre-market</span></div>
  <div class="row-kv"><span>QuiverQuant Lobbying</span><span style="color:#94a3b8;font-size:0.78rem">Slow — daily pre-market</span></div>
  <div class="row-kv"><span>QuiverQuant Insider Buying</span><span style="color:#94a3b8;font-size:0.78rem">Slow — daily pre-market</span></div>
  <div class="row-kv"><span>QuiverQuant Trending</span><span style="color:#94a3b8;font-size:0.78rem">Fast — 30 min refresh</span></div>
  <div class="row-kv"><span>Alpha Vantage IT Sector</span><span style="color:#94a3b8;font-size:0.78rem">Slow — daily pre-market</span></div>
  <div class="row-kv"><span>Alpaca Bars (Bollinger / MA)</span><span style="color:#94a3b8;font-size:0.78rem">Fast — 30 min refresh</span></div>
  <div class="row-kv"><span>Stock Universe</span><span style="color:#94a3b8;font-size:0.78rem">498 tickers (S&P 500 + Mid + Small Cap)</span></div>
</div>
</div>

<div class="footer">Auto-generated by Algo Trader &nbsp;|&nbsp; ${date} &nbsp;|&nbsp; Paper Trading Account &nbsp;|&nbsp; All data from Alpaca paper endpoint</div>
</body>
</html>`;

  console.log(`\n[Summary] Generating HTML digest for ${date}...`);
  if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
  const file = path.join(SUMMARIES_DIR, `summary_${date}.html`);
  fs.writeFileSync(file, HTML);
  console.log(`[Summary] Saved → ${file}`);

  if (!fs.existsSync(SUMMARIES_DIR_LOCAL)) fs.mkdirSync(SUMMARIES_DIR_LOCAL, { recursive: true });
  const fileLocal = path.join(SUMMARIES_DIR_LOCAL, `summary_${date}.html`);
  fs.writeFileSync(fileLocal, HTML);
  console.log(`[Summary] Saved → ${fileLocal}`);

  return HTML;
}

module.exports = { generateSummary };
if (require.main === module) generateSummary().catch(console.error);
