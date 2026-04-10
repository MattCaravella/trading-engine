/**
 * Postmortem Analyzer — Trade Performance Tracking
 *
 * Runs every cycle to detect newly closed positions.
 * For each closed trade, records:
 *   - Entry/exit price, P&L %, P&L $
 *   - Holding duration (hours)
 *   - Exit reason (trailing stop, hard stop, profit target, manual)
 *   - Strategy sources that triggered the buy
 *   - Win/loss classification
 *
 * Maintains a persistent performance ledger in trade_history/performance_ledger.json
 * and a rolling summary in trade_history/performance_summary.json
 */

const fs   = require('fs');
const path = require('path');

const LEDGER_FILE  = path.join(__dirname, 'trade_history/performance_ledger.json');
const SUMMARY_FILE = path.join(__dirname, 'trade_history/performance_summary.json');

// ─── Alpaca API for fetching filled order prices ──────────────────────────────
const envRaw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const envVars = {};
envRaw.split('\n').forEach(l => { const [k,...v] = l.split('='); if (k && v.length) envVars[k.trim()] = v.join('=').trim(); });
const ALPACA_URL = envVars.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const ALPACA_KEY = envVars.ALPACA_API_KEY;
const ALPACA_SECRET = envVars.ALPACA_SECRET_KEY;

async function fetchFilledPrice(orderId) {
  try {
    const res = await fetch(`${ALPACA_URL}/v2/orders/${orderId}`, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    });
    if (!res.ok) return null;
    const order = await res.json();
    return order.filled_avg_price ? parseFloat(order.filled_avg_price) : null;
  } catch { return null; }
}

// Lazy-load database to avoid circular deps
let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./database'); } catch { _db = false; }
  }
  return _db || null;
}

// ─── Ledger I/O ──────────────────────────────────────────────────────────────
function loadLedger() {
  // Try database first (primary source of truth)
  try {
    const db = getDb();
    if (db) {
      const dbTrades = db.getAllTrades();
      if (dbTrades && dbTrades.length > 0) {
        // Build knownClosedOrderIds from DB trades
        const knownIds = dbTrades.map(t => t.orderId || t.order_id).filter(Boolean);
        return { trades: dbTrades, knownClosedOrderIds: knownIds };
      }
    }
  } catch (err) {
    console.warn('[Postmortem] DB read failed, falling back to JSON:', err.message);
  }

  // Fallback to JSON
  if (fs.existsSync(LEDGER_FILE)) try { return JSON.parse(fs.readFileSync(LEDGER_FILE)); } catch {}
  return { trades: [], knownClosedOrderIds: [] };
}

function saveLedger(ledger) {
  // Save to JSON (backup / transition)
  const dir = path.dirname(LEDGER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

// ─── Find the buy order that opened a position ──────────────────────────────
async function findBuyDetails(symbol, tradeHistoryDir) {
  try {
    const files = fs.readdirSync(tradeHistoryDir).filter(f => f.includes(`_${symbol}_buy_`) && f.endsWith('.json'));
    if (files.length === 0) return null;
    // Get the most recent buy
    files.sort().reverse();
    const filePath = path.join(tradeHistoryDir, files[0]);
    const data = JSON.parse(fs.readFileSync(filePath));

    let entryPrice = parseFloat(data.filled_avg_price || data.limit_price || 0);

    // If entry price is 0/null (logged at submission before fill), fetch from Alpaca API
    if (!entryPrice && data.id) {
      console.log(`  [Postmortem] ${symbol}: entry price missing in log, fetching fill from Alpaca...`);
      const filledPrice = await fetchFilledPrice(data.id);
      if (filledPrice) {
        entryPrice = filledPrice;
        // Update the logged file so we don't need to fetch again
        data.filled_avg_price = String(filledPrice);
        try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch {}
        console.log(`  [Postmortem] ${symbol}: resolved entry price = $${filledPrice}`);
      } else {
        console.warn(`  [Postmortem] ${symbol}: could not resolve entry price — skipping trade`);
      }
    }

    return {
      entryPrice,
      entryTime:  data.filled_at || data.submitted_at || data.created_at,
      qty:        parseInt(data.filled_qty || data.qty || 1),
      reason:     data.engine_reason || 'unknown',
      sources:    extractSources(data.engine_reason),
    };
  } catch { return null; }
}

function extractSources(reason) {
  if (!reason) return [];
  const match = reason.match(/\[([^\]]+)\]/);
  return match ? match[1].split('+') : [];
}

// ─── Detect closed positions and build postmortem records ───────────────────
async function processClosedTrades(closedOrders) {
  const ledger = loadLedger();
  const tradeHistoryDir = path.join(__dirname, 'trade_history');
  const knownIds = new Set(ledger.knownClosedOrderIds);
  let newRecords = 0;

  for (const order of closedOrders) {
    if (order.status !== 'filled') continue;
    if (knownIds.has(order.id)) continue;

    // Detect trade type: long exit (sell) or short cover (buy with COVER in reason)
    const isLongExit = order.side === 'sell';
    const isShortCover = order.side === 'buy' && order.engine_reason?.includes('COVER:');
    // Also check logged JSON files for COVER prefix (engine_reason may not be on the Alpaca order)
    let isShortFromFile = false;
    if (!isLongExit && !isShortCover && order.side === 'buy') {
      const coverFiles = fs.readdirSync(tradeHistoryDir).filter(f => f.includes(`_${order.symbol}_buy_`) && f.endsWith('.json'));
      for (const f of coverFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(tradeHistoryDir, f)));
          if (data.id === order.id && data.engine_reason?.includes('COVER:')) { isShortFromFile = true; break; }
        } catch {}
      }
    }
    if (!isLongExit && !isShortCover && !isShortFromFile) continue;

    const isShort   = isShortCover || isShortFromFile;
    const symbol    = order.symbol;
    const exitPrice = parseFloat(order.filled_avg_price || 0);
    const exitTime  = order.filled_at || order.updated_at;
    const exitQty   = parseInt(order.filled_qty || 0);

    if (!exitPrice || !exitQty) continue;

    // Determine exit reason
    let exitReason = 'unknown';
    if (order.type === 'trailing_stop') exitReason = 'trailing_stop';
    else if (order.type === 'stop') exitReason = 'hard_stop';
    else if (order.type === 'market') {
      // Check logged JSON files for engine_reason
      const side = isShort ? 'buy' : 'sell';
      const tradeFiles = fs.readdirSync(tradeHistoryDir).filter(f => f.includes(`_${symbol}_${side}_`) && f.endsWith('.json'));
      for (const f of tradeFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(tradeHistoryDir, f)));
          if (data.id === order.id && data.engine_reason) {
            const reason = data.engine_reason;
            if (reason.includes('Profit target') || reason.includes('profit')) exitReason = 'profit_target';
            else if (reason.includes('Hard stop') || reason.includes('Stop') || reason.includes('stop')) exitReason = 'hard_stop';
            else if (reason.includes('RSI cover') || reason.includes('oversold')) exitReason = 'rsi_cover';
            break;
          }
        } catch {}
      }
    }

    // Find matching entry — buy for longs, sell-to-open for shorts
    let entryPrice = 0, entryTime = null, entrySources = [], entryReason = 'unknown';
    if (isShort) {
      // Short entry is a sell order — look for sell files with SHORT prefix
      const shortFiles = fs.readdirSync(tradeHistoryDir).filter(f => f.includes(`_${symbol}_sell_`) && f.endsWith('.json'));
      shortFiles.sort().reverse();
      for (const f of shortFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(tradeHistoryDir, f)));
          if (data.engine_reason?.includes('SHORT:')) {
            entryPrice = parseFloat(data.filled_avg_price || 0);
            if (!entryPrice && data.id) {
              const filled = await fetchFilledPrice(data.id);
              if (filled) entryPrice = filled;
            }
            entryTime = data.filled_at || data.submitted_at;
            entryReason = data.engine_reason;
            entrySources = ['short_entry'];
            break;
          }
        } catch {}
      }
    } else {
      const buy = await findBuyDetails(symbol, tradeHistoryDir);
      entryPrice = buy?.entryPrice || 0;
      entryTime = buy?.entryTime || null;
      entryReason = buy?.reason || 'unknown';
      entrySources = buy?.sources || [];
    }

    // Guard: skip trades with unresolved entry price
    if (!entryPrice) {
      console.warn(`  [Postmortem] SKIPPING ${symbol} — entry price is 0, would corrupt calibration data`);
      continue;
    }

    // P&L calculation — reversed for shorts (profit when price drops)
    let pnlPct, pnlDollar;
    if (isShort) {
      pnlPct = ((entryPrice - exitPrice) / entryPrice * 100);  // Short: sold high, bought low = profit
      pnlDollar = (entryPrice - exitPrice) * exitQty;
    } else {
      pnlPct = ((exitPrice - entryPrice) / entryPrice * 100);
      pnlDollar = (exitPrice - entryPrice) * exitQty;
    }
    const isWin = pnlPct > 0;

    // Holding duration in hours
    let holdingHours = null;
    if (entryTime && exitTime) {
      holdingHours = Math.round((new Date(exitTime) - new Date(entryTime)) / 3600000 * 10) / 10;
    }

    const record = {
      symbol,
      entryPrice,
      exitPrice,
      qty: exitQty,
      pnlPct: Math.round(pnlPct * 100) / 100,
      pnlDollar: Math.round(pnlDollar * 100) / 100,
      isWin,
      exitReason,
      holdingHours,
      sources: entrySources,
      buyReason: entryReason,
      entryTime,
      exitTime,
      orderId: order.id,
      isShort: isShort || false,
    };

    ledger.trades.push(record);
    ledger.knownClosedOrderIds.push(order.id);
    knownIds.add(order.id);
    newRecords++;

    // Also persist to SQLite database
    try {
      const db = getDb();
      if (db && !db.isOrderProcessed(order.id)) {
        db.insertTrade(record);
      }
    } catch (err) {
      console.warn(`  [Postmortem] SQLite write failed (JSON still saved): ${err.message}`);
    }

    const winLoss = isWin ? '✓ WIN' : '✗ LOSS';
    console.log(`  [Postmortem] ${symbol}: ${winLoss} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlDollar.toFixed(2)}) | Exit: ${exitReason} | Held: ${holdingHours || '?'}h | Sources: ${record.sources.join('+') || '?'}`);
  }

  if (newRecords > 0) {
    saveLedger(ledger);
    updateSummary(ledger);
    console.log(`  [Postmortem] ${newRecords} new trade(s) analyzed`);
  }

  return newRecords;
}

// ─── Rolling performance summary ────────────────────────────────────────────
function updateSummary(ledger) {
  const trades = ledger.trades;
  if (trades.length === 0) return;

  const wins   = trades.filter(t => t.isWin);
  const losses = trades.filter(t => !t.isWin);
  const totalPnl = trades.reduce((s, t) => s + t.pnlDollar, 0);
  const avgPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const avgHold = trades.filter(t => t.holdingHours).reduce((s, t) => s + t.holdingHours, 0) / (trades.filter(t => t.holdingHours).length || 1);

  // Win rate by source
  const sourceStats = {};
  for (const t of trades) {
    for (const src of t.sources) {
      if (!sourceStats[src]) sourceStats[src] = { wins: 0, losses: 0, totalPnl: 0 };
      if (t.isWin) sourceStats[src].wins++; else sourceStats[src].losses++;
      sourceStats[src].totalPnl += t.pnlDollar;
    }
  }

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // Recent streak
  const last10 = trades.slice(-10);
  const recentWinRate = last10.filter(t => t.isWin).length / last10.length * 100;

  // Consecutive losses (for signal kill detection)
  let maxConsecLosses = 0, currentStreak = 0;
  for (const t of trades) {
    if (!t.isWin) { currentStreak++; maxConsecLosses = Math.max(maxConsecLosses, currentStreak); }
    else currentStreak = 0;
  }

  const summary = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length * 100).toFixed(1) + '%',
    totalPnlDollar: Math.round(totalPnl * 100) / 100,
    avgPnlPct: Math.round(avgPnlPct * 100) / 100,
    avgHoldingHours: Math.round(avgHold * 10) / 10,
    profitFactor: losses.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnlDollar, 0) / Math.abs(losses.reduce((s, t) => s + t.pnlDollar, 0)) * 100) / 100 : Infinity,
    maxConsecutiveLosses: maxConsecLosses,
    currentLossStreak: currentStreak,
    recentWinRate: recentWinRate.toFixed(1) + '%',
    exitReasons,
    sourcePerformance: sourceStats,
    lastUpdated: new Date().toISOString(),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  return summary;
}

// ─── Get summary for reports ─────────────────────────────────────────────────
function getSummary() {
  if (fs.existsSync(SUMMARY_FILE)) try { return JSON.parse(fs.readFileSync(SUMMARY_FILE)); } catch {}
  return null;
}

function getLedger() {
  return loadLedger();
}

module.exports = { processClosedTrades, getSummary, getLedger };
