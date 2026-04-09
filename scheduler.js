const fs   = require('fs');
const path = require('path');
const { isPreMarket, isMarketHours, isAfterHours, isWeekend, timeLabel, etTimeString, getETComponents } = require('./market_hours');
const { refreshSlow, refreshFast, refreshNews, refreshShort, getCandidates, getShortCandidates, cacheStatus } = require('./signal_cache');
const { runTradeCycle, placeOvernightTrailingStops, runShortCycle } = require('./engine');
const { generateSummary }                                      = require('./daily_summary');
const { generateForecast }                                     = require('./daily_forecast');
const { runCalibration }                                       = require('./strategy_calibrator');
const { infoAlert, warningAlert }                              = require('./alerts');

const FAST_REFRESH_MS  = 30 * 60 * 1000;
const TRADE_EXEC_MS    = 5  * 60 * 1000;
const HEARTBEAT_FILE   = path.join(__dirname, 'trade_history/heartbeat.json');
const TASK_LOG_FILE    = path.join(__dirname, 'trade_history/task_log.jsonl');
const HALT_FLAG        = path.join(__dirname, 'trade_history/halt.flag');

function writeHeartbeat(lastTask) {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ pid: process.pid, ts: Date.now(), lastTask, et: etTimeString() }));
  } catch {}
}

function logTask(task, status, extra = {}) {
  try {
    const entry = { task, status, at: new Date().toISOString(), et: etTimeString(), ...extra };
    fs.appendFileSync(TASK_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

const state = {
  preMarketDone: false, marketOpenDone: false, afterHoursDone: false, middayNewsDone: false,
  lastFastRefresh: 0, lastTradeExecution: 0, lastDay: -1,
};

async function doPreMarket() {
  if (state.preMarketDone) return;
  const start = Date.now();
  console.log('\n'+'═'.repeat(60));
  console.log(`[Scheduler] PRE-MARKET — ${etTimeString()} ET`);
  console.log('═'.repeat(60));
  try {
    await refreshSlow();
    await refreshNews();
    logTask('pre_market', 'completed', { durationMs: Date.now() - start });
  } catch (e) {
    logTask('pre_market', 'failed', { error: e.message, durationMs: Date.now() - start });
    warningAlert('Scheduled Task Failed', 'pre_market task failed', { task: 'pre_market', error: e.message });
  }
  state.preMarketDone = true;
}

async function doMarketOpen() {
  if (state.marketOpenDone) return;
  const start = Date.now();
  console.log('\n'+'═'.repeat(60));
  console.log(`[Scheduler] MARKET OPEN — ${etTimeString()} ET`);
  console.log('═'.repeat(60));
  try {
    await refreshFast();
    logTask('market_open', 'completed', { durationMs: Date.now() - start });
  } catch (e) {
    logTask('market_open', 'failed', { error: e.message, durationMs: Date.now() - start });
    warningAlert('Scheduled Task Failed', 'market_open task failed', { task: 'market_open', error: e.message });
  }
  state.marketOpenDone = true;
  state.lastFastRefresh = Date.now();
}

async function doFastRefresh() {
  if (Date.now()-state.lastFastRefresh < FAST_REFRESH_MS) return;
  console.log(`\n[Scheduler] FAST refresh — ${etTimeString()} ET`);
  await Promise.all([refreshFast(), refreshShort()]);
  state.lastFastRefresh = Date.now();
}

async function doMiddayNews() {
  if (state.middayNewsDone) return;
  const { mins } = getETComponents();
  if (mins < 720) return;  // 720 = 12:00 PM ET
  const start = Date.now();
  console.log(`\n[Scheduler] MIDDAY NEWS refresh — ${etTimeString()} ET`);
  try {
    await refreshNews();
    logTask('midday_news', 'completed', { durationMs: Date.now() - start });
  } catch (e) {
    logTask('midday_news', 'failed', { error: e.message, durationMs: Date.now() - start });
    warningAlert('Scheduled Task Failed', 'midday_news task failed', { task: 'midday_news', error: e.message });
  }
  state.middayNewsDone = true;
}

let executingTrade = false;
async function doTradeExecution() {
  if (executingTrade) { console.log('[Scheduler] Trade cycle still running, skipping'); return; }
  if (Date.now()-state.lastTradeExecution < TRADE_EXEC_MS) return;
  executingTrade = true;
  try {
    const status = cacheStatus();
    if (status.slow.count===0 && status.fast.count===0) { console.log('[Scheduler] No cached signals yet'); return; }
    await runTradeCycle(getCandidates);
    // Run short cycle in parallel context (doesn't block long cycle)
    runShortCycle(getShortCandidates).catch(e => console.error('[Scheduler] Short cycle error:', e.message));
    state.lastTradeExecution = Date.now();
  } finally {
    executingTrade = false;
  }
}

async function doAfterHours() {
  if (state.afterHoursDone) return;
  const start = Date.now();
  console.log('\n'+'═'.repeat(60));
  console.log(`[Scheduler] AFTER-HOURS — ${etTimeString()} ET`);
  console.log('═'.repeat(60));
  try {
    await refreshSlow();
    await placeOvernightTrailingStops();
    runCalibration();
    await generateSummary();
    await generateForecast();
    logTask('after_hours', 'completed', { durationMs: Date.now() - start });
  } catch (e) {
    logTask('after_hours', 'failed', { error: e.message, durationMs: Date.now() - start });
    warningAlert('Scheduled Task Failed', 'after_hours task failed', { task: 'after_hours', error: e.message });
  }
  state.afterHoursDone = true;
}

function resetDailyFlags() {
  const { day } = getETComponents();
  if (day !== state.lastDay) {
    state.preMarketDone=false; state.marketOpenDone=false; state.afterHoursDone=false; state.middayNewsDone=false;
    state.lastDay=day;
    console.log(`[Scheduler] New trading day — flags reset`);
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  // Halt flag check — dashboard Full Kill Switch writes this file
  if (fs.existsSync(HALT_FLAG)) {
    writeHeartbeat('halted');
    console.log(`[Scheduler] HALTED — halt.flag present. Use dashboard to resume, or delete trade_history/halt.flag manually.`);
    return;
  }
  ticking = true;
  try {
    resetDailyFlags();
    if (isWeekend()) { writeHeartbeat('idle-weekend'); return; }
    if (isPreMarket())   { await doPreMarket(); writeHeartbeat('pre_market'); return; }
    if (isMarketHours()) { await doMarketOpen(); await doMiddayNews(); await doFastRefresh(); await doTradeExecution(); writeHeartbeat('market'); return; }
    if (isAfterHours())  { await doAfterHours(); writeHeartbeat('after_hours'); return; }
    writeHeartbeat('idle');
  } finally {
    ticking = false;
  }
}

async function init() {
  if (isMarketHours() || isAfterHours()) {
    console.log('[Scheduler] Started mid-session — catching up on missed runs...');
    infoAlert('Startup Catch-Up', 'Scheduler started mid-session — running missed tasks', { phase: timeLabel(), time: etTimeString() });
    logTask('startup_catchup', 'started');

    // Catch up: slow sources (pre-market equivalent)
    if (cacheStatus().slow.count === 0) {
      console.log('[Scheduler] Catching up: slow sources...');
      await refreshSlow();
    }
    state.preMarketDone = true;

    // Catch up: fast refresh (market open equivalent)
    if (isMarketHours()) {
      console.log('[Scheduler] Catching up: fast refresh + short scan...');
      await Promise.all([refreshFast(), refreshShort()]);
      state.marketOpenDone = true;
      state.lastFastRefresh = Date.now();
    }

    // Catch up: news
    console.log('[Scheduler] Catching up: news scrape...');
    await refreshNews();

    // Mark midday news as done if we're past 12 PM (it just ran above)
    const { mins } = getETComponents();
    if (mins >= 720) state.middayNewsDone = true;

    logTask('startup_catchup', 'completed');
    console.log('[Scheduler] Catch-up complete — resuming normal schedule');
  }
  writeHeartbeat('init');
  tick().catch(console.error);
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║             Trading Scheduler — Starting Up              ║');
console.log('║                                                          ║');
console.log('║  8:00 AM ET   → Slow sources + news scrape               ║');
console.log('║  9:30 AM ET   → Market open fast refresh + short scan    ║');
console.log('║  12:00 PM ET  → Midday news scrape                       ║');
console.log('║  Every 5 min  → Long + short trade execution             ║');
console.log('║  Every 30 min → Fast refresh + short scan                ║');
console.log('║  4:00 PM ET   → After-hours: summary + forecast + stops  ║');
console.log('║  Overnight    → Idle                                     ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`\nCurrent time: ${etTimeString()} ET — ${timeLabel()}\n`);

// Git auto-backup removed from trading runtime.
// Version control should be handled separately from live trading.
// Use: git add -A && git commit -m "backup" && git push
// Or set up a separate scheduled task for backups.

init().catch(console.error);
setInterval(() => tick().catch(console.error), 60 * 1000);
