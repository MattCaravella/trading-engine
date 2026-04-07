const fs   = require('fs');
const path = require('path');
const { logTrade }           = require('./logger');
const { assessPositionRisk } = require('./strategies/montecarlo');
const { isEarningsBlock }    = require('./monitors/earnings_guard');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key,...rest]=line.split('='); if(key&&rest.length) process.env[key.trim()]=rest.join('=').trim();
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;

const MAX_POSITIONS  = 10;
const QTY_PER_TRADE  = 1;
const TRAIL_PERCENT  = 4;
const HARD_STOP_PCT  = 5;
const COOLDOWN_HOURS = 24;
const BUY_THRESHOLD  = 70;

const STATE_FILE = path.join(__dirname, 'trade_history/engine_state.json');

function loadState() {
  if (fs.existsSync(STATE_FILE)) try { return JSON.parse(fs.readFileSync(STATE_FILE)); } catch {}
  return { stoppedOut:{} };
}
function saveState(s) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2));
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

async function placeBuy(ticker, reason) {
  const order = await alpaca('POST','/orders',{ symbol:ticker, qty:String(QTY_PER_TRADE), side:'buy', type:'market', time_in_force:'day' });
  if (!order.id) { console.error(`  [BUY FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  logTrade({...order, engine_reason:reason});
  console.log(`  [BUY]  ${ticker} — ${reason}`);
  return order;
}

async function placeTrailingStop(ticker, qty, entryPrice) {
  const order = await alpaca('POST','/orders',{ symbol:ticker, qty:String(qty), side:'sell', type:'trailing_stop', trail_percent:String(TRAIL_PERCENT), time_in_force:'gtc' });
  if (!order.id) { console.error(`  [TRAIL STOP FAILED] ${ticker}:`, JSON.stringify(order)); return null; }
  logTrade({...order, engine_reason:`Trailing stop ${TRAIL_PERCENT}% from peak`});
  console.log(`  [TRAIL STOP] ${ticker} — ${TRAIL_PERCENT}% trail placed`);
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
  const [positions, openOrders] = await Promise.all([getOpenPositions(),getOpenOrders()]);
  let placed=0;
  for (const pos of positions) {
    if (await hasTrailingStop(pos.symbol,openOrders)) continue;
    await placeTrailingStop(pos.symbol, pos.qty, parseFloat(pos.avg_entry_price));
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
    const equity  = parseFloat(account.equity);
    const buyPow  = parseFloat(account.buying_power);
    console.log(`[Engine] Equity: $${equity.toLocaleString()} | Buying power: $${buyPow.toLocaleString()}`);

    await detectStopOuts(state);

    const [positions, openOrders] = await Promise.all([getOpenPositions(),getOpenOrders()]);
    console.log(`[Engine] Positions: ${positions.length} | Open orders: ${openOrders.length}`);

    for (const pos of positions) {
      const ticker   = pos.symbol;
      const entry    = parseFloat(pos.avg_entry_price);
      const pnlPct   = parseFloat(pos.unrealized_plpc)*100;
      console.log(`  ${ticker.padEnd(6)} entry=$${entry.toFixed(2)} P&L=${pnlPct.toFixed(2)}%`);

      if (pnlPct <= -HARD_STOP_PCT) {
        const sell = await alpaca('POST','/orders',{symbol:ticker,qty:pos.qty,side:'sell',type:'market',time_in_force:'day'});
        if (sell.id) { logTrade({...sell,engine_reason:`Hard stop: ${pnlPct.toFixed(2)}%`}); console.log(`  [HARD STOP] ${ticker}`); if(!state.stoppedOut)state.stoppedOut={}; state.stoppedOut[ticker]=now; }
        continue;
      }

      const openedToday = new Date(pos.created_at||0).toDateString()===new Date().toDateString();
      if (!(await hasTrailingStop(ticker,openOrders))) {
        if (openedToday) console.log(`  [SKIP TRAIL] ${ticker} — opened today, will place tonight`);
        else await placeTrailingStop(ticker, pos.qty, entry);
      }
    }

    const ranked    = await getCandidatesFn();
    const candidates = ranked.filter(t=>t.netScore>=BUY_THRESHOLD);
    const openTickers = new Set(positions.map(p=>p.symbol));
    const slots = MAX_POSITIONS - openTickers.size;
    if (slots <= 0) { console.log('[Engine] Max positions reached.'); saveState(state); return; }

    const pendingBuys = new Set(openOrders.filter(o=>o.side==='buy'&&o.status==='pending_new').map(o=>o.symbol));
    const toTrade = candidates.filter(c=>!openTickers.has(c.ticker)&&!pendingBuys.has(c.ticker)&&!isOnCooldown(c.ticker,state)).slice(0,slots);
    if (toTrade.length===0) console.log('[Engine] No new buy candidates this cycle.');

    const boughtThisCycle = new Set();
    for (const c of toTrade) {
      if (boughtThisCycle.has(c.ticker)) continue;
      const top    = c.signals.sort((a,b)=>b.score-a.score)[0];
      const earningsBlock = await isEarningsBlock(c.ticker).catch(()=>false);
      if (earningsBlock) { console.log(`  [SKIP] ${c.ticker} — earnings within 5 days`); continue; }
      const risk   = await assessPositionRisk(c.ticker, equity);
      console.log(`  [RISK] ${c.ticker}: ${risk.reason}`);
      if (!risk.safe) { console.log(`  [SKIP] ${c.ticker} — risk gate failed`); continue; }
      const reason = `Score ${c.netScore}/100 [${c.sources.join('+')}] | ${top.reason}`;
      await placeBuy(c.ticker, reason);
      boughtThisCycle.add(c.ticker);
      console.log(`  [PENDING TRAIL] ${c.ticker} — trailing stop placed next cycle`);
    }

    saveState(state);
    console.log(`[Engine] Cycle complete — new trades: ${toTrade.length}`);
  } catch(err) { console.error('[Engine] Cycle error:', err.message); saveState(state); }
}

module.exports = { runTradeCycle, placeOvernightTrailingStops };
