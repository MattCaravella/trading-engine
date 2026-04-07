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

// ─── Ledger I/O ──────────────────────────────────────────────────────────────
function loadLedger() {
  if (fs.existsSync(LEDGER_FILE)) try { return JSON.parse(fs.readFileSync(LEDGER_FILE)); } catch {}
  return { trades: [], knownClosedOrderIds: [] };
}

function saveLedger(ledger) {
  const dir = path.dirname(LEDGER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

// ─── Find the buy order that opened a position ──────────────────────────────
function findBuyDetails(symbol, tradeHistoryDir) {
  try {
    const files = fs.readdirSync(tradeHistoryDir).filter(f => f.includes(`_${symbol}_buy_`) && f.endsWith('.json'));
    if (files.length === 0) return null;
    // Get the most recent buy
    files.sort().reverse();
    const data = JSON.parse(fs.readFileSync(path.join(tradeHistoryDir, files[0])));
    return {
      entryPrice: parseFloat(data.filled_avg_price || data.limit_price || 0),
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
    if (order.side !== 'sell' || order.status !== 'filled') continue;
    if (knownIds.has(order.id)) continue;

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
      // Check if it was a profit take or hard stop from engine
      const tradeFiles = fs.readdirSync(tradeHistoryDir).filter(f => f.includes(`_${symbol}_sell_`) && f.endsWith('.json'));
      for (const f of tradeFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(tradeHistoryDir, f)));
          if (data.id === order.id && data.engine_reason) {
            if (data.engine_reason.includes('Profit target')) exitReason = 'profit_target';
            else if (data.engine_reason.includes('Hard stop')) exitReason = 'hard_stop';
            break;
          }
        } catch {}
      }
    }

    // Find matching buy
    const buy = findBuyDetails(symbol, tradeHistoryDir);
    const entryPrice = buy?.entryPrice || 0;
    const entryTime  = buy?.entryTime || null;

    const pnlPct   = entryPrice ? ((exitPrice - entryPrice) / entryPrice * 100) : 0;
    const pnlDollar = (exitPrice - entryPrice) * exitQty;
    const isWin     = pnlPct > 0;

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
      sources: buy?.sources || [],
      buyReason: buy?.reason || 'unknown',
      entryTime,
      exitTime,
      orderId: order.id,
    };

    ledger.trades.push(record);
    ledger.knownClosedOrderIds.push(order.id);
    knownIds.add(order.id);
    newRecords++;

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
