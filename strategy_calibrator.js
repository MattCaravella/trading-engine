/**
 * Strategy Calibrator — Adaptive Feedback Loop
 *
 * Reads the postmortem performance ledger and adjusts system behavior:
 *
 *   1. WEIGHT ADJUSTMENT — Strategies with higher win rates get boosted,
 *      losing strategies get demoted. Weights are recalculated daily.
 *
 *   2. SIGNAL KILL — If a strategy has 5+ consecutive losses AND its
 *      rolling win rate is below 30%, that strategy is disabled until
 *      it recovers in shadow mode.
 *
 *   3. EXIT ANALYSIS — Tracks which exit types (trailing stop, hard stop,
 *      profit target) are most common and adjusts stop/target parameters.
 *
 *   4. DAILY LESSONS — Generates a human-readable "what went wrong / right"
 *      report for the daily forecast.
 *
 * Persists calibration state in trade_history/calibration.json
 */

const fs   = require('fs');
const path = require('path');

const CALIBRATION_FILE = path.join(__dirname, 'trade_history/calibration.json');
const LEDGER_FILE      = path.join(__dirname, 'trade_history/performance_ledger.json');
const SUMMARY_FILE     = path.join(__dirname, 'trade_history/performance_summary.json');

// Lazy-load database to avoid circular deps
let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./database'); } catch { _db = false; }
  }
  return _db || null;
}

// ─── Default weights (baseline) ─────────────────────────────────────────────
const BASE_WEIGHTS = {
  insider_buying: 1.4, ma_crossover: 1.2, downtrend: 1.1, bollinger: 1.1,
  relative_value: 1.0, techsector: 0.9,
  congress: 1.5, offexchange: 1.3, govcontracts: 1.0, lobbying: 0.8,
  flights: 0.7, trending: 0.6, news_sentiment: 1.2,
};

// Kill thresholds
const CONSECUTIVE_LOSS_KILL = 5;
const MIN_WIN_RATE_KILL     = 0.30;  // 30% rolling win rate to stay alive
const MIN_TRADES_FOR_ADJUST = 5;     // Need 5+ trades before adjusting weights

// ─── Load/Save ──────────────────────────────────────────────────────────────
function loadCalibration() {
  if (fs.existsSync(CALIBRATION_FILE)) try { return JSON.parse(fs.readFileSync(CALIBRATION_FILE)); } catch {}
  return {
    adjustedWeights: { ...BASE_WEIGHTS },
    killedStrategies: [],
    lastCalibrated: null,
    history: [],
  };
}

function saveCalibration(cal) {
  // Save to JSON (backup / transition)
  const dir = path.dirname(CALIBRATION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(cal, null, 2));

  // Also persist to SQLite database
  try {
    const db = getDb();
    if (db) {
      db.insertCalibration({
        adjustedWeights: cal.adjustedWeights,
        killedStrategies: cal.killedStrategies,
        sourceStats: cal.sourceStats || null,
      });
    }
  } catch (err) {
    // JSON already saved as backup
  }
}

function loadLedger() {
  if (fs.existsSync(LEDGER_FILE)) try { return JSON.parse(fs.readFileSync(LEDGER_FILE)); } catch {}
  return { trades: [] };
}

function loadSummary() {
  if (fs.existsSync(SUMMARY_FILE)) try { return JSON.parse(fs.readFileSync(SUMMARY_FILE)); } catch {}
  return null;
}

// ─── 1. Recalculate adaptive weights using utility-based (Sharpe) weighting ──
function recalculateWeights(trades) {
  const sourceStats = {};

  for (const t of trades) {
    for (const src of (t.sources || [])) {
      if (!sourceStats[src]) sourceStats[src] = { wins: 0, losses: 0, totalPnlPct: 0, trades: 0, pnls: [] };
      sourceStats[src].trades++;
      if (t.isWin) sourceStats[src].wins++;
      else sourceStats[src].losses++;
      sourceStats[src].totalPnlPct += t.pnlPct;
      sourceStats[src].pnls.push(t.pnlPct);
    }
  }

  const adjusted = { ...BASE_WEIGHTS };

  for (const [src, stats] of Object.entries(sourceStats)) {
    if (stats.trades < MIN_TRADES_FOR_ADJUST) continue;
    if (!BASE_WEIGHTS[src]) continue;

    const winRate = stats.wins / stats.trades;
    const avgPnl  = stats.totalPnlPct / stats.trades;

    // Compute per-source Sharpe ratio (trade-level, annualized)
    // Sharpe = mean(returns) / stddev(returns) * sqrt(trades_per_year)
    const pnls = stats.pnls;
    const mean = avgPnl;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
    const std = Math.sqrt(variance) || 0.01; // prevent div by 0
    const tradeSharpe = mean / std; // per-trade Sharpe (not annualized — we want relative ranking)

    // Utility-based multiplier: combine Sharpe + win rate + profit factor
    // Sharpe-based: positive Sharpe = boost, negative = penalty
    // Range: Sharpe of -2 to +2 maps to multiplier 0.3 to 2.0
    const sharpeMultiplier = Math.max(0.3, Math.min(2.0, 1.0 + tradeSharpe * 0.5));

    // Profit factor bonus: gross wins / gross losses
    const grossWins = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
    const grossLosses = Math.abs(pnls.filter(p => p < 0).reduce((s, p) => s + p, 0)) || 0.01;
    const profitFactor = grossWins / grossLosses;
    const pfBonus = profitFactor > 1.5 ? 0.2 : profitFactor > 1.0 ? 0.1 : 0;

    const multiplier = Math.max(0.3, Math.min(2.0, sharpeMultiplier + pfBonus));
    adjusted[src] = Math.round(BASE_WEIGHTS[src] * multiplier * 100) / 100;

    // Store enhanced stats for reporting
    stats.sharpe = Math.round(tradeSharpe * 100) / 100;
    stats.profitFactor = Math.round(profitFactor * 100) / 100;
    stats.winRate = Math.round(winRate * 100);
  }

  return { adjusted, sourceStats };
}

// ─── 2. Check for strategy kills ────────────────────────────────────────────
function checkStrategyKills(trades) {
  const killed = [];
  const sourceStreaks = {};

  // Build consecutive loss streaks per source
  for (const t of trades) {
    for (const src of (t.sources || [])) {
      if (!sourceStreaks[src]) sourceStreaks[src] = { current: 0, max: 0, total: 0, wins: 0 };
      sourceStreaks[src].total++;
      if (t.isWin) {
        sourceStreaks[src].current = 0;
        sourceStreaks[src].wins++;
      } else {
        sourceStreaks[src].current++;
        sourceStreaks[src].max = Math.max(sourceStreaks[src].max, sourceStreaks[src].current);
      }
    }
  }

  for (const [src, streak] of Object.entries(sourceStreaks)) {
    if (streak.total < MIN_TRADES_FOR_ADJUST) continue;
    const winRate = streak.wins / streak.total;
    if (streak.current >= CONSECUTIVE_LOSS_KILL && winRate < MIN_WIN_RATE_KILL) {
      killed.push({
        strategy: src,
        consecutiveLosses: streak.current,
        winRate: (winRate * 100).toFixed(1) + '%',
        reason: `${streak.current} consecutive losses + ${(winRate*100).toFixed(0)}% win rate (below ${MIN_WIN_RATE_KILL*100}%)`,
      });
    }
  }

  return killed;
}

// ─── 3. Exit analysis ───────────────────────────────────────────────────────
function analyzeExits(trades) {
  if (trades.length === 0) return null;

  const byExit = {};
  for (const t of trades) {
    const ex = t.exitReason || 'unknown';
    if (!byExit[ex]) byExit[ex] = { count: 0, avgPnl: 0, wins: 0, totalPnl: 0 };
    byExit[ex].count++;
    byExit[ex].totalPnl += t.pnlPct;
    if (t.isWin) byExit[ex].wins++;
  }

  const insights = [];
  for (const [ex, stats] of Object.entries(byExit)) {
    stats.avgPnl = stats.totalPnl / stats.count;
    const wr = (stats.wins / stats.count * 100).toFixed(0);

    if (ex === 'hard_stop' && stats.count > 3 && stats.avgPnl < -4) {
      insights.push(`Hard stops hitting too often (${stats.count}x, avg ${stats.avgPnl.toFixed(1)}%) — consider widening stop or tighter entry criteria`);
    }
    if (ex === 'trailing_stop' && stats.avgPnl > 0) {
      insights.push(`Trailing stops averaging +${stats.avgPnl.toFixed(1)}% — trail is capturing gains well`);
    }
    if (ex === 'trailing_stop' && stats.avgPnl < -1) {
      insights.push(`Trailing stops averaging ${stats.avgPnl.toFixed(1)}% — trail may be too tight, consider widening from 4%`);
    }
    if (ex === 'profit_target' && stats.count > 2) {
      insights.push(`Profit target hit ${stats.count}x at avg +${stats.avgPnl.toFixed(1)}% — target is working`);
    }
  }

  return { byExit, insights };
}

// ─── 4. Generate daily lessons report ───────────────────────────────────────
function generateLessonsReport(trades) {
  if (!trades || trades.length === 0) return 'No closed trades yet — insufficient data for analysis.';

  const lines = [];
  const recentTrades = trades.slice(-20); // last 20 trades

  // Weight adjustments
  const { adjusted, sourceStats } = recalculateWeights(trades);
  const weightChanges = [];
  for (const [src, newW] of Object.entries(adjusted)) {
    const baseW = BASE_WEIGHTS[src];
    if (!baseW) continue;
    const diff = ((newW - baseW) / baseW * 100).toFixed(0);
    if (Math.abs(newW - baseW) > 0.05) {
      weightChanges.push({ src, base: baseW, adjusted: newW, diff: diff + '%', direction: newW > baseW ? '↑' : '↓' });
    }
  }

  // Strategy kills
  const kills = checkStrategyKills(trades);

  // Exit analysis
  const exitAnalysis = analyzeExits(trades);

  // Winners vs losers breakdown
  const winners = recentTrades.filter(t => t.isWin);
  const losers  = recentTrades.filter(t => !t.isWin);

  lines.push('STRATEGY CALIBRATION & LESSONS');
  lines.push('─'.repeat(62));

  // Kill alerts
  if (kills.length > 0) {
    lines.push('  ⚠ STRATEGY KILLS:');
    for (const k of kills) {
      lines.push(`    ${k.strategy}: DISABLED — ${k.reason}`);
    }
    lines.push('');
  }

  // Weight adjustments
  if (weightChanges.length > 0) {
    lines.push('  WEIGHT ADJUSTMENTS (based on trade history):');
    for (const w of weightChanges) {
      lines.push(`    ${w.direction} ${w.src.padEnd(16)} ${w.base} → ${w.adjusted} (${w.diff})`);
    }
    lines.push('');
  } else if (trades.length < MIN_TRADES_FOR_ADJUST) {
    lines.push(`  Weights: Not enough data yet (${trades.length}/${MIN_TRADES_FOR_ADJUST} trades needed)`);
    lines.push('');
  }

  // Top winners
  if (winners.length > 0) {
    const best = winners.sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 3);
    lines.push('  TOP WINNERS (recent):');
    for (const t of best) {
      lines.push(`    ✓ ${t.symbol} +${t.pnlPct.toFixed(2)}% | Exit: ${t.exitReason} | Sources: ${t.sources.join('+')} | Held: ${t.holdingHours || '?'}h`);
    }
    lines.push('');
  }

  // Worst losers
  if (losers.length > 0) {
    const worst = losers.sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 3);
    lines.push('  WORST LOSERS (recent):');
    for (const t of worst) {
      lines.push(`    ✗ ${t.symbol} ${t.pnlPct.toFixed(2)}% | Exit: ${t.exitReason} | Sources: ${t.sources.join('+')} | Held: ${t.holdingHours || '?'}h`);
    }
    lines.push('');
  }

  // Exit insights
  if (exitAnalysis?.insights.length > 0) {
    lines.push('  EXIT ANALYSIS INSIGHTS:');
    for (const insight of exitAnalysis.insights) {
      lines.push(`    • ${insight}`);
    }
    lines.push('');
  }

  // Overall recommendation
  const totalWR = trades.length > 0 ? (trades.filter(t => t.isWin).length / trades.length * 100) : 0;
  if (totalWR >= 55) {
    lines.push(`  SYSTEM STATUS: ✓ Healthy — ${totalWR.toFixed(0)}% win rate`);
  } else if (totalWR >= 40) {
    lines.push(`  SYSTEM STATUS: ~ Acceptable — ${totalWR.toFixed(0)}% win rate, monitor closely`);
  } else if (trades.length >= MIN_TRADES_FOR_ADJUST) {
    lines.push(`  SYSTEM STATUS: ⚠ Underperforming — ${totalWR.toFixed(0)}% win rate, review strategy weights`);
  }

  return lines.join('\n');
}

// ─── Main calibration run (called daily in after-hours) ─────────────────────
function runCalibration() {
  const ledger = loadLedger();
  const trades = ledger.trades || [];

  if (trades.length < MIN_TRADES_FOR_ADJUST) {
    console.log(`[Calibrator] Only ${trades.length} trades — need ${MIN_TRADES_FOR_ADJUST} for calibration`);
    return { adjusted: BASE_WEIGHTS, kills: [], lessons: 'Insufficient data' };
  }

  const { adjusted, sourceStats } = recalculateWeights(trades);
  const kills   = checkStrategyKills(trades);
  const lessons = generateLessonsReport(trades);
  const exits   = analyzeExits(trades);

  // Persist
  const cal = loadCalibration();
  cal.adjustedWeights = adjusted;
  cal.killedStrategies = kills.map(k => k.strategy);
  cal.lastCalibrated = new Date().toISOString();
  cal.history.push({
    date: new Date().toISOString().slice(0, 10),
    trades: trades.length,
    winRate: (trades.filter(t => t.isWin).length / trades.length * 100).toFixed(1),
    weights: adjusted,
    kills: kills.length,
  });
  // Keep last 90 days of history
  if (cal.history.length > 90) cal.history = cal.history.slice(-90);
  saveCalibration(cal);

  console.log(`[Calibrator] Calibrated with ${trades.length} trades`);
  if (kills.length > 0) console.log(`[Calibrator] ⚠ ${kills.length} strateg${kills.length === 1 ? 'y' : 'ies'} killed`);

  return { adjusted, kills, lessons, exits, sourceStats };
}

// ─── Get live weights (calibrated if available, else baseline) ──────────────
function getLiveWeights() {
  const cal = loadCalibration();
  return cal.adjustedWeights || BASE_WEIGHTS;
}

// ─── Check if a strategy is killed ──────────────────────────────────────────
function isStrategyKilled(source) {
  const cal = loadCalibration();
  return (cal.killedStrategies || []).includes(source);
}

module.exports = {
  runCalibration,
  getLiveWeights,
  isStrategyKilled,
  generateLessonsReport,
  recalculateWeights,
  checkStrategyKills,
  analyzeExits,
  BASE_WEIGHTS,
};
