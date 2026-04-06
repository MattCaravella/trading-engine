const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key,...rest]=line.split('='); if(key&&rest.length) process.env[key.trim()]=rest.join('=').trim();
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;
const SUMMARIES_DIR = 'C:\\Users\\Matth\\OneDrive\\TradingSummaries';

async function alpaca(endpoint) {
  const res = await fetch(`${ALPACA_URL}/v2${endpoint}`, {
    headers:{'APCA-API-KEY-ID':ALPACA_KEY,'APCA-API-SECRET-KEY':ALPACA_SECRET}
  });
  return res.json();
}

function pad(s,n) { return String(s).padEnd(n).slice(0,n); }

async function generateSummary() {
  const date = new Date().toISOString().slice(0,10);
  const [account, positions, orders] = await Promise.all([
    alpaca('/account'),
    alpaca('/positions'),
    alpaca(`/orders?status=closed&after=${date}T00:00:00Z&limit=100`),
  ]);

  const equity     = parseFloat(account.equity||0);
  const lastEquity = parseFloat(account.last_equity||0);
  const dayPnL     = equity - lastEquity;
  const dayPnLPct  = lastEquity > 0 ? (dayPnL/lastEquity)*100 : 0;
  const buyPow     = parseFloat(account.buying_power||0);

  const filled = Array.isArray(orders) ? orders.filter(o=>o.status==='filled') : [];
  const buys   = filled.filter(o=>o.side==='buy');
  const sells  = filled.filter(o=>o.side==='sell');
  const open   = Array.isArray(positions) ? positions : [];

  const D='═'.repeat(62), d='─'.repeat(62);
  const lines=[];

  lines.push(D);
  lines.push(`  DAILY TRADING SUMMARY — ${date}`);
  lines.push(D);
  lines.push('');
  lines.push('ACCOUNT');
  lines.push(d);
  lines.push(`  Equity:        $${equity.toLocaleString('en-US',{minimumFractionDigits:2})}`);
  lines.push(`  Buying Power:  $${buyPow.toLocaleString('en-US',{minimumFractionDigits:2})}`);
  const sign = dayPnL>=0?'+':'';
  lines.push(`  Day P&L:       ${sign}$${Math.abs(dayPnL).toFixed(2)} (${sign}${dayPnLPct.toFixed(2)}%)`);
  lines.push('');

  lines.push(`BUYS TODAY (${buys.length})`);
  lines.push(d);
  if (buys.length===0) { lines.push('  No buys today.'); }
  else {
    lines.push(`  ${'Symbol'.padEnd(8)} ${'Qty'.padStart(6)} ${'Fill Price'.padStart(12)} ${'Total'.padStart(10)}`);
    lines.push(`  ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(10)}`);
    for (const o of buys) {
      const qty=parseFloat(o.filled_qty||o.qty||0), price=parseFloat(o.filled_avg_price||0);
      lines.push(`  ${pad(o.symbol,8)} ${String(qty).padStart(6)} ${('$'+price.toFixed(2)).padStart(12)} ${('$'+(qty*price).toFixed(2)).padStart(10)}`);
      const jf = findTradeJson(o.id);
      if (jf?.engine_reason) lines.push(`    └ ${jf.engine_reason.slice(0,80)}`);
    }
  }
  lines.push('');

  lines.push(`SELLS TODAY (${sells.length})`);
  lines.push(d);
  if (sells.length===0) { lines.push('  No sells today.'); }
  else {
    lines.push(`  ${'Symbol'.padEnd(8)} ${'Qty'.padStart(6)} ${'Fill Price'.padStart(12)} ${'Type'.padStart(16)}`);
    lines.push(`  ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(16)}`);
    for (const o of sells) {
      const qty=parseFloat(o.filled_qty||o.qty||0), price=parseFloat(o.filled_avg_price||0);
      const type=o.type==='trailing_stop'?'Trailing Stop':o.type==='stop'?'Hard Stop':'Market Sell';
      lines.push(`  ${pad(o.symbol,8)} ${String(qty).padStart(6)} ${('$'+price.toFixed(2)).padStart(12)} ${type.padStart(16)}`);
    }
  }
  lines.push('');

  lines.push(`OPEN POSITIONS (${open.length})`);
  lines.push(d);
  if (open.length===0) { lines.push('  No open positions.'); }
  else {
    lines.push(`  ${'Symbol'.padEnd(8)} ${'Qty'.padStart(5)} ${'Entry'.padStart(10)} ${'Current'.padStart(10)} ${'P&L $'.padStart(10)} ${'P&L %'.padStart(8)}`);
    lines.push(`  ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)}`);
    let totalPnL=0;
    for (const p of open) {
      const qty=parseFloat(p.qty), entry=parseFloat(p.avg_entry_price), curr=parseFloat(p.current_price);
      const pnlAmt=parseFloat(p.unrealized_pl), pnlPct=parseFloat(p.unrealized_plpc)*100;
      totalPnL+=pnlAmt;
      const pa=(pnlAmt>=0?'+$':'-$')+Math.abs(pnlAmt).toFixed(2);
      const pp=(pnlPct>=0?'+':'')+pnlPct.toFixed(2)+'%';
      lines.push(`  ${pad(p.symbol,8)} ${String(qty).padStart(5)} ${('$'+entry.toFixed(2)).padStart(10)} ${('$'+curr.toFixed(2)).padStart(10)} ${pa.padStart(10)} ${pp.padStart(8)}`);
    }
    lines.push(d);
    const tp=(totalPnL>=0?'+$':'-$')+Math.abs(totalPnL).toFixed(2);
    lines.push(`  ${'Unrealized Total'.padEnd(36)} ${tp.padStart(10)}`);
  }
  lines.push('');
  lines.push('ACTIVITY SUMMARY');
  lines.push(d);
  lines.push(`  Total orders filled: ${filled.length}`);
  lines.push(`  Buys: ${buys.length}  |  Sells: ${sells.length}  |  Open positions: ${open.length}`);
  lines.push('');
  lines.push(D);
  lines.push('');

  const report = lines.join('\n');
  console.log('\n'+report);
  if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR,{recursive:true});
  const file = path.join(SUMMARIES_DIR, `summary_${date}.txt`);
  fs.writeFileSync(file, report);
  console.log(`[Summary] Saved → ${file}`);
  return report;
}

function findTradeJson(orderId) {
  try {
    const dir   = path.join(__dirname,'trade_history');
    const files = fs.readdirSync(dir).filter(f=>f.includes((orderId||'').slice(0,8)));
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(dir,files[0])));
  } catch { return null; }
}

module.exports = { generateSummary };
if (require.main===module) generateSummary().catch(console.error);
