/**
 * Performance Tracker — Daily Equity Curve + Rolling Metrics
 *
 * Records end-of-day equity snapshots.
 * Computes cumulative returns, Sharpe ratio, max drawdown, win rate over time.
 * Used by daily_summary.js and daily_forecast.js for performance reporting.
 */

const fs   = require('fs');
const path = require('path');

const EQUITY_FILE = path.join(__dirname, 'trade_history/equity_curve.json');

// Lazy-load database to avoid circular deps
let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./database'); } catch { _db = false; }
  }
  return _db || null;
}

function loadEquityCurve() {
  // Try database first (primary source of truth)
  try {
    const db = getDb();
    if (db) {
      const dbSnapshots = db.getEquityCurve();
      if (dbSnapshots && dbSnapshots.length > 0) {
        return { snapshots: dbSnapshots };
      }
    }
  } catch (err) {
    // Fall through to JSON
  }

  // Fallback to JSON
  if (fs.existsSync(EQUITY_FILE)) try { return JSON.parse(fs.readFileSync(EQUITY_FILE)); } catch {}
  return { snapshots: [] };
}

function saveEquityCurve(data) {
  const dir = path.dirname(EQUITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(EQUITY_FILE, JSON.stringify(data, null, 2));
}

// Record end-of-day snapshot (called from daily_summary or after-hours)
function recordDailySnapshot(equity, positionCount, dayBuys, daySells) {
  const data  = loadEquityCurve();
  const today = new Date().toISOString().slice(0, 10);

  // Don't double-record same day
  if (data.snapshots.length > 0 && data.snapshots[data.snapshots.length - 1].date === today) {
    data.snapshots[data.snapshots.length - 1] = { date: today, equity, positions: positionCount, buys: dayBuys, sells: daySells };
  } else {
    data.snapshots.push({ date: today, equity, positions: positionCount, buys: dayBuys, sells: daySells });
  }

  saveEquityCurve(data);

  // Also persist to SQLite database
  try {
    const db = getDb();
    if (db) db.upsertEquitySnapshot({ date: today, equity, positions: positionCount, buys: dayBuys, sells: daySells });
  } catch (err) {
    // JSON already saved as backup
  }

  return data;
}

// Compute rolling performance metrics
function getPerformanceMetrics() {
  const data = loadEquityCurve();
  const snaps = data.snapshots;
  if (snaps.length < 2) return { totalReturn: 0, maxDrawdown: 0, sharpe: null, daysTraded: snaps.length, message: 'Insufficient data (need 2+ days)' };

  const startEquity = snaps[0].equity;
  const endEquity   = snaps[snaps.length - 1].equity;
  const totalReturn = ((endEquity - startEquity) / startEquity * 100);

  // Daily returns
  const dailyReturns = [];
  for (let i = 1; i < snaps.length; i++) {
    dailyReturns.push((snaps[i].equity - snaps[i - 1].equity) / snaps[i - 1].equity);
  }

  // Max drawdown
  let peak = 0, maxDD = 0;
  for (const s of snaps) {
    if (s.equity > peak) peak = s.equity;
    const dd = (peak - s.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe ratio (annualized, assuming 252 trading days)
  let sharpe = null;
  if (dailyReturns.length >= 5) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const std  = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length);
    if (std > 0) sharpe = (mean / std) * Math.sqrt(252);
  }

  // Best / worst day
  const bestDay  = dailyReturns.length > 0 ? Math.max(...dailyReturns) * 100 : 0;
  const worstDay = dailyReturns.length > 0 ? Math.min(...dailyReturns) * 100 : 0;

  // Win days vs loss days
  const winDays  = dailyReturns.filter(r => r > 0).length;
  const lossDays = dailyReturns.filter(r => r < 0).length;
  const flatDays = dailyReturns.filter(r => r === 0).length;

  return {
    startDate: snaps[0].date,
    endDate: snaps[snaps.length - 1].date,
    daysTraded: snaps.length,
    startEquity: startEquity.toFixed(2),
    endEquity: endEquity.toFixed(2),
    totalReturn: totalReturn.toFixed(2) + '%',
    totalReturnDollar: (endEquity - startEquity).toFixed(2),
    maxDrawdown: (maxDD * 100).toFixed(2) + '%',
    sharpeRatio: sharpe !== null ? sharpe.toFixed(2) : 'N/A',
    bestDay: '+' + bestDay.toFixed(2) + '%',
    worstDay: worstDay.toFixed(2) + '%',
    winDays,
    lossDays,
    flatDays,
    winDayRate: dailyReturns.length > 0 ? (winDays / dailyReturns.length * 100).toFixed(1) + '%' : 'N/A',
  };
}

// Format for inclusion in daily reports
function getPerformanceReport() {
  const metrics = getPerformanceMetrics();
  const pm      = loadPostmortemSummary();

  const lines = [];
  lines.push('PERFORMANCE TRACKER');
  lines.push('─'.repeat(62));
  lines.push(`  Days Traded:    ${metrics.daysTraded}`);
  lines.push(`  Total Return:   ${metrics.totalReturn} ($${metrics.totalReturnDollar})`);
  lines.push(`  Max Drawdown:   ${metrics.maxDrawdown}`);
  lines.push(`  Sharpe Ratio:   ${metrics.sharpeRatio}`);
  lines.push(`  Best Day:       ${metrics.bestDay}`);
  lines.push(`  Worst Day:      ${metrics.worstDay}`);
  lines.push(`  Win Days:       ${metrics.winDays}  |  Loss Days: ${metrics.lossDays}`);

  if (pm) {
    lines.push('');
    lines.push('TRADE PERFORMANCE');
    lines.push('─'.repeat(62));
    lines.push(`  Closed Trades:  ${pm.totalTrades}`);
    lines.push(`  Win Rate:       ${pm.winRate}`);
    lines.push(`  Profit Factor:  ${pm.profitFactor === Infinity ? '∞' : pm.profitFactor}`);
    lines.push(`  Avg P&L:        ${pm.avgPnlPct >= 0 ? '+' : ''}${pm.avgPnlPct}%`);
    lines.push(`  Total P&L:      $${pm.totalPnlDollar}`);
    lines.push(`  Avg Hold Time:  ${pm.avgHoldingHours}h`);
    lines.push(`  Max Losing Streak: ${pm.maxConsecutiveLosses}`);

    if (pm.sourcePerformance && Object.keys(pm.sourcePerformance).length > 0) {
      lines.push('');
      lines.push('  Strategy Source Performance:');
      for (const [src, stats] of Object.entries(pm.sourcePerformance)) {
        const total = stats.wins + stats.losses;
        const wr = (stats.wins / total * 100).toFixed(0);
        lines.push(`    ${src.padEnd(16)} ${wr}% WR (${stats.wins}W/${stats.losses}L)  P&L: $${stats.totalPnl.toFixed(2)}`);
      }
    }
  }

  return lines.join('\n');
}

function loadPostmortemSummary() {
  const sumFile = path.join(__dirname, 'trade_history/performance_summary.json');
  if (fs.existsSync(sumFile)) try { return JSON.parse(fs.readFileSync(sumFile)); } catch {}
  return null;
}

module.exports = { recordDailySnapshot, getPerformanceMetrics, getPerformanceReport };
