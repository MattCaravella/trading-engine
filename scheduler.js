const { isPreMarket, isMarketHours, isAfterHours, isWeekend, timeLabel, etTimeString, getETComponents } = require('./market_hours');
const { refreshSlow, refreshFast, getCandidates, cacheStatus } = require('./signal_cache');
const { runTradeCycle, placeOvernightTrailingStops }           = require('./engine');
const { generateSummary }                                      = require('./daily_summary');
const { generateForecast }                                     = require('./daily_forecast');
const { runCalibration }                                       = require('./strategy_calibrator');

const FAST_REFRESH_MS  = 30 * 60 * 1000;
const TRADE_EXEC_MS    = 5  * 60 * 1000;

const state = {
  preMarketDone: false, marketOpenDone: false, afterHoursDone: false,
  lastFastRefresh: 0, lastTradeExecution: 0, lastDay: -1,
};

async function doPreMarket() {
  if (state.preMarketDone) return;
  console.log('\n'+'═'.repeat(60));
  console.log(`[Scheduler] PRE-MARKET — ${etTimeString()} ET`);
  console.log('═'.repeat(60));
  await refreshSlow();
  state.preMarketDone = true;
}

async function doMarketOpen() {
  if (state.marketOpenDone) return;
  console.log('\n'+'═'.repeat(60));
  console.log(`[Scheduler] MARKET OPEN — ${etTimeString()} ET`);
  console.log('═'.repeat(60));
  await refreshFast();
  state.marketOpenDone = true;
  state.lastFastRefresh = Date.now();
}

async function doFastRefresh() {
  if (Date.now()-state.lastFastRefresh < FAST_REFRESH_MS) return;
  console.log(`\n[Scheduler] FAST refresh — ${etTimeString()} ET`);
  await refreshFast();
  state.lastFastRefresh = Date.now();
}

async function doTradeExecution() {
  if (Date.now()-state.lastTradeExecution < TRADE_EXEC_MS) return;
  const status = cacheStatus();
  if (status.slow.count===0 && status.fast.count===0) { console.log('[Scheduler] No cached signals yet'); return; }
  await runTradeCycle(getCandidates);
  state.lastTradeExecution = Date.now();
}

async function doAfterHours() {
  if (state.afterHoursDone) return;
  console.log('\n'+'═'.repeat(60));
  console.log(`[Scheduler] AFTER-HOURS — ${etTimeString()} ET`);
  console.log('═'.repeat(60));
  await refreshSlow();
  await placeOvernightTrailingStops();
  runCalibration(); // Recalibrate strategy weights from trade history
  await generateSummary();
  await generateForecast();
  state.afterHoursDone = true;
}

function resetDailyFlags() {
  const { day } = getETComponents();
  if (day !== state.lastDay) {
    state.preMarketDone=false; state.marketOpenDone=false; state.afterHoursDone=false;
    state.lastDay=day;
    console.log(`[Scheduler] New trading day — flags reset`);
  }
}

async function tick() {
  resetDailyFlags();
  if (isWeekend()) return;
  if (isPreMarket())   { await doPreMarket(); return; }
  if (isMarketHours()) { await doMarketOpen(); await doFastRefresh(); await doTradeExecution(); return; }
  if (isAfterHours())  { await doAfterHours(); return; }
}

async function init() {
  if (isMarketHours() || isAfterHours()) {
    if (cacheStatus().slow.count === 0) {
      console.log('[Scheduler] Market already open — seeding slow cache...');
      await refreshSlow();
      state.preMarketDone = true;
    }
  }
  tick().catch(console.error);
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║             Trading Scheduler — Starting Up              ║');
console.log('║                                                          ║');
console.log('║  8:00 AM ET   → Slow sources (congress/contracts/lobby) ║');
console.log('║  9:30 AM ET   → Market open fast refresh                 ║');
console.log('║  Every 5 min  → Trade execution (market hours only)      ║');
console.log('║  Every 30 min → Fast refresh (bollinger/MA/pairs)        ║');
console.log('║  4:00 PM ET   → After-hours: summary + forecast + stops  ║');
console.log('║  Overnight    → Idle                                     ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`\nCurrent time: ${etTimeString()} ET — ${timeLabel()}\n`);

// Auto-backup to GitHub on startup
const { execSync } = require('child_process');
function gitBackup() {
  try {
    execSync('git add -A', { cwd: __dirname, stdio: 'pipe' });
    execSync(`git commit -m "Auto-backup ${new Date().toISOString().slice(0,10)}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push origin master', { cwd: __dirname, stdio: 'pipe' });
    console.log('[Backup] Code pushed to GitHub ✓');
  } catch(e) {
    const msg = e.stderr?.toString() || e.message;
    if (msg.includes('nothing to commit')) console.log('[Backup] No changes to backup');
    else console.warn('[Backup] Git error:', msg.slice(0, 100));
  }
}
gitBackup();

init().catch(console.error);
setInterval(() => tick().catch(console.error), 60 * 1000);
