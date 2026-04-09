const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key,...rest]=line.split('='); if(key&&rest.length) process.env[key.trim()]=rest.join('=').trim();
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;
const SUMMARIES_DIR       = 'C:\\Users\\Matth\\OneDrive\\TradingSummaries';
const SUMMARIES_DIR_LOCAL = path.join(__dirname, 'trade_history', 'summaries');

const { getBars, closes, volumes, sma, rsi, bollingerBands, getVIX } = require('./data/prices');
const { generateLessonsReport } = require('./strategy_calibrator');
const { getPerformanceReport } = require('./performance_tracker');

// ─── Alpaca helpers ──────────────────────────────────────────────────────────
async function alpaca(endpoint) {
  const res = await fetch(`${ALPACA_URL}/v2${endpoint}`, {
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
  });
  return res.json();
}

// ─── Yahoo Finance helpers ───────────────────────────────────────────────────
async function getEarningsDate(symbol) {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
    if (!dates || dates.length === 0) return null;
    // dates are { raw: epoch, fmt: 'YYYY-MM-DD' }
    const next = dates.map(d => new Date(d.raw * 1000)).filter(d => d > new Date()).sort((a,b)=>a-b)[0];
    return next || null;
  } catch { return null; }
}

async function getQuote(symbol) {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    return {
      price:  meta?.regularMarketPrice  || null,
      change: meta?.regularMarketChangePercent || null,
    };
  } catch { return { price: null, change: null }; }
}

// ─── Technical assessment for one position ──────────────────────────────────
async function assessPosition(pos) {
  const symbol = pos.symbol;
  const entry  = parseFloat(pos.avg_entry_price);
  const curr   = parseFloat(pos.current_price);
  const pnlPct = parseFloat(pos.unrealized_plpc) * 100;

  let techNote = '';
  let outlook  = 'NEUTRAL';
  let rsiVal   = null;
  let bbStatus = '';

  try {
    const bars = await getBars(symbol, 60);
    const cls  = closes(bars);
    const vols = volumes(bars);

    rsiVal = rsi(cls, 14);
    const bb = bollingerBands(cls, 20, 2);
    const ma20 = sma(cls, 20);
    const ma50 = sma(cls, 50);
    const avgVol = sma(vols, 20);
    const lastVol = vols[vols.length - 1];

    const rsiStr = rsiVal ? rsiVal.toFixed(0) : '?';

    // Bollinger position
    if (bb) {
      if (curr > bb.upper) bbStatus = 'Above upper BB (overbought zone)';
      else if (curr < bb.lower) bbStatus = 'Below lower BB (oversold zone)';
      else {
        const pct = ((curr - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(0);
        bbStatus = `${pct}% of BB range`;
      }
    }

    // Trend
    const aboveMa20 = ma20 && curr > ma20;
    const aboveMa50 = ma50 && curr > ma50;
    const volSurge  = avgVol && lastVol > avgVol * 1.3;

    if (rsiVal > 70 || curr > (bb?.upper || Infinity)) {
      outlook = 'CAUTION';
      techNote = `RSI ${rsiStr} — overbought`;
    } else if (rsiVal < 35 || curr < (bb?.lower || 0)) {
      outlook = 'WATCH';
      techNote = `RSI ${rsiStr} — oversold, possible bounce`;
    } else if (aboveMa20 && aboveMa50) {
      outlook = 'BULLISH';
      techNote = `RSI ${rsiStr} — above both MAs${volSurge ? ', volume surge' : ''}`;
    } else if (!aboveMa20 && !aboveMa50) {
      outlook = 'BEARISH';
      techNote = `RSI ${rsiStr} — below both MAs`;
    } else {
      outlook = 'MIXED';
      techNote = `RSI ${rsiStr} — ${aboveMa20 ? 'above' : 'below'} 20MA, ${aboveMa50 ? 'above' : 'below'} 50MA`;
    }
  } catch (e) {
    techNote = `(data unavailable: ${e.message.slice(0,40)})`;
  }

  return { symbol, entry, curr, pnlPct, outlook, techNote, bbStatus, rsiVal };
}

// ─── Next trading day helper ─────────────────────────────────────────────────
function nextTradingDay() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function daysUntil(date) {
  return Math.ceil((date - new Date()) / 86400000);
}

// ─── Main forecast ───────────────────────────────────────────────────────────
async function generateForecast() {
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = nextTradingDay();

  console.log('\n[Forecast] Building next-day forecast...');

  // Gather data in parallel
  const [positions, account, vix] = await Promise.all([
    alpaca('/positions').then(r => Array.isArray(r) ? r : []),
    alpaca('/account'),
    getVIX(),
  ]);

  const equity = parseFloat(account.equity || 0);

  // Assess each position technically + get earnings dates
  const assessments = await Promise.all(positions.map(assessPosition));
  const earningsMap = {};
  await Promise.allSettled(positions.map(async p => {
    earningsMap[p.symbol] = await getEarningsDate(p.symbol);
  }));

  // Pull top candidates from signal cache (already warmed by slow/fast refresh)
  let topCandidates = [];
  try {
    const { getCandidates } = require('./signal_cache');
    const all = await getCandidates();
    topCandidates = all.filter(c => c.netScore >= 70).slice(0, 5);
  } catch { /* cache may be empty if run standalone */ }

  // ─── Format report ────────────────────────────────────────────────────────
  const D = '═'.repeat(62);
  const d = '─'.repeat(62);
  const lines = [];

  lines.push(D);
  lines.push(`  NEXT-DAY FORECAST — ${tomorrow}`);
  lines.push(`  Generated: ${today} after market close`);
  lines.push(D);
  lines.push('');

  // Market conditions
  lines.push('MARKET CONDITIONS');
  lines.push(d);
  const vixStr   = vix ? vix.toFixed(2) : 'N/A';
  const vixLabel = !vix ? '' : vix >= 30 ? '⚠  HIGH FEAR — expect volatility' : vix >= 20 ? '↑  Elevated — use caution' : '✓  Low — calm market';
  lines.push(`  VIX:     ${vixStr}   ${vixLabel}`);
  lines.push(`  Equity:  $${equity.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  lines.push('');

  // Position outlooks
  lines.push(`POSITION OUTLOOKS (${assessments.length})`);
  lines.push(d);
  if (assessments.length === 0) {
    lines.push('  No open positions.');
  } else {
    // Sort: CAUTION/BEARISH first so they're most visible
    const order = { CAUTION:0, BEARISH:1, WATCH:2, MIXED:3, NEUTRAL:4, BULLISH:5 };
    assessments.sort((a,b) => (order[a.outlook]??9) - (order[b.outlook]??9));

    for (const a of assessments) {
      const sign   = a.pnlPct >= 0 ? '+' : '';
      const pnlStr = `${sign}${a.pnlPct.toFixed(2)}%`;
      const icon   = { BULLISH:'▲', CAUTION:'⚠', BEARISH:'▼', WATCH:'◎', MIXED:'~', NEUTRAL:'–' }[a.outlook] || '–';
      lines.push(`  ${icon} ${a.symbol.padEnd(6)} [${a.outlook.padEnd(7)}]  P&L: ${pnlStr.padStart(7)}  ${a.techNote}`);
      if (a.bbStatus) lines.push(`    └ Bollinger: ${a.bbStatus}`);

      const eDate = earningsMap[a.symbol];
      if (eDate) {
        const daysAway = daysUntil(eDate);
        const eDateStr = eDate.toISOString().slice(0,10);
        if (daysAway <= 14) {
          lines.push(`    └ 📅 Earnings in ${daysAway} day${daysAway===1?'':'s'} (${eDateStr}) — elevated vol expected`);
        }
      }
    }
  }
  lines.push('');

  // Risk flags
  const riskFlags = assessments.filter(a => a.outlook === 'CAUTION' || a.outlook === 'BEARISH');
  const watchFlags = assessments.filter(a => a.outlook === 'WATCH');
  if (riskFlags.length > 0 || watchFlags.length > 0) {
    lines.push('ACTION FLAGS');
    lines.push(d);
    for (const a of riskFlags) {
      lines.push(`  ⚠  ${a.symbol}: ${a.outlook} — consider tightening stop or reducing size`);
    }
    for (const a of watchFlags) {
      lines.push(`  ◎  ${a.symbol}: Oversold — watch for reversal signal`);
    }
    lines.push('');
  }

  // Earnings upcoming (all within 14 days)
  const earningsUpcoming = positions
    .map(p => ({ symbol: p.symbol, date: earningsMap[p.symbol] }))
    .filter(e => e.date && daysUntil(e.date) <= 14)
    .sort((a,b) => a.date - b.date);

  if (earningsUpcoming.length > 0) {
    lines.push('EARNINGS WATCH (next 14 days)');
    lines.push(d);
    for (const e of earningsUpcoming) {
      const days = daysUntil(e.date);
      lines.push(`  ${e.symbol.padEnd(6)}  ${e.date.toISOString().slice(0,10)}  (${days} day${days===1?'':'s'})`);
    }
    lines.push('');
  }

  // Top buy candidates for tomorrow
  if (topCandidates.length > 0) {
    lines.push('TOP BUY CANDIDATES FOR TOMORROW');
    lines.push(d);
    for (const c of topCandidates) {
      const top = c.signals.sort((a,b)=>b.score-a.score)[0];
      lines.push(`  ${c.ticker.padEnd(6)}  Score: ${String(c.netScore).padStart(3)}/100  Sources: ${c.sources.join('+')}`);
      if (top?.reason) lines.push(`    └ ${top.reason.slice(0,80)}`);
    }
    lines.push('');
  } else {
    lines.push('TOP BUY CANDIDATES FOR TOMORROW');
    lines.push(d);
    lines.push('  No candidates above threshold at time of forecast.');
    lines.push('');
  }

  // Lessons from trade history (calibrator feedback)
  try {
    const ledgerPath = path.join(__dirname, 'trade_history/performance_ledger.json');
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath));
      if (ledger.trades && ledger.trades.length > 0) {
        const lessons = generateLessonsReport(ledger.trades);
        lines.push(lessons);
        lines.push('');
      }
    }
  } catch {}

  // Performance tracker
  try {
    const perfReport = getPerformanceReport();
    if (perfReport) {
      lines.push(perfReport);
      lines.push('');
    }
  } catch {}

  lines.push('STRATEGY NOTES');
  lines.push(d);
  lines.push(`  • Trailing stops (4%) active on all overnight positions`);
  lines.push(`  • Hard stop at -6% per position during market hours`);
  lines.push(`  • Max 12 concurrent positions (8% equity each)`);
  lines.push(`  • VIX ${vix ? (vix >= 20 ? `${vixStr} — Bollinger strategy ACTIVE` : `${vixStr} — Bollinger strategy IDLE (needs >20)`) : 'N/A'}`);
  lines.push(`  • Next slow refresh: tomorrow 8:00 AM ET`);
  lines.push(`  • Next trade cycle: tomorrow 9:30 AM ET`);
  lines.push('');
  lines.push(D);
  lines.push('');

  const report = lines.join('\n');
  console.log('\n' + report);

  // Save to OneDrive alongside summary
  if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
  const file = path.join(SUMMARIES_DIR, `forecast_${tomorrow}.txt`);
  fs.writeFileSync(file, report);
  console.log(`[Forecast] Saved → ${file}`);
  // Also save locally
  if (!fs.existsSync(SUMMARIES_DIR_LOCAL)) fs.mkdirSync(SUMMARIES_DIR_LOCAL, { recursive: true });
  const fileLocal = path.join(SUMMARIES_DIR_LOCAL, `forecast_${tomorrow}.txt`);
  fs.writeFileSync(fileLocal, report);
  console.log(`[Forecast] Saved → ${fileLocal}`);

  return report;
}

module.exports = { generateForecast };
if (require.main === module) generateForecast().catch(console.error);
