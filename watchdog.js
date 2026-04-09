/**
 * Watchdog — keeps scheduler.js and dashboard.js alive.
 * If a process crashes, restarts it with exponential backoff.
 * Circuit breaker trips after too many restarts in a sliding window.
 */
const { spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');

const { criticalAlert, warningAlert } = require('./alerts');
const SCHEDULER    = path.join(__dirname, 'scheduler.js');
const DASHBOARD    = path.join(__dirname, 'dashboard.js');
const WATCHDOG_LOG = path.join(__dirname, 'watchdog.log');

// ── Circuit breaker configuration ───────────────────────────────────────────
const BASE_DELAY_MS        = 5000;       // initial restart delay: 5s
const MAX_DELAY_MS         = 300000;     // cap backoff at 5 minutes
const BACKOFF_MULTIPLIER   = 2;          // double each time
const CIRCUIT_MAX_RESTARTS = 10;         // max restarts allowed in window
const CIRCUIT_WINDOW_MS    = 5 * 60000;  // sliding window: 5 minutes
const STABILITY_RESET_MS   = 30 * 60000; // 30 minutes uptime resets counters

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(WATCHDOG_LOG, line);
}

// ── Per-process circuit breaker state ───────────────────────────────────────
function createCircuitState(name) {
  return {
    name,
    restartTimestamps: [],   // timestamps of restarts within sliding window
    consecutiveRestarts: 0,  // for backoff calculation
    tripped: false,          // true = circuit breaker open, no more restarts
    stabilityTimer: null,    // timer that fires after STABILITY_RESET_MS
  };
}

/**
 * Record a restart event, prune old timestamps outside the sliding window,
 * and return whether the circuit breaker has tripped.
 */
function recordRestart(state) {
  const now = Date.now();

  // Prune timestamps older than the sliding window
  state.restartTimestamps = state.restartTimestamps.filter(
    ts => (now - ts) < CIRCUIT_WINDOW_MS
  );

  // Record this restart
  state.restartTimestamps.push(now);
  state.consecutiveRestarts++;

  // Check if circuit breaker should trip
  if (state.restartTimestamps.length >= CIRCUIT_MAX_RESTARTS) {
    state.tripped = true;
    const windowSec = (CIRCUIT_WINDOW_MS / 1000).toFixed(0);
    log(`CRITICAL: Circuit breaker TRIPPED for ${state.name} — ` +
        `${state.restartTimestamps.length} restarts in ${windowSec}s window. ` +
        `Halting automatic restarts. Manual intervention required.`);
    criticalAlert('Circuit Breaker Tripped', `${state.name} hit ${state.restartTimestamps.length} restarts in ${windowSec}s — automatic restarts halted`, { process: state.name, restarts: state.restartTimestamps.length, windowSeconds: windowSec });
    return true;
  }

  return false;
}

/**
 * Compute the current backoff delay based on consecutive restart count.
 */
function getBackoffDelay(state) {
  const delay = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, state.consecutiveRestarts - 1);
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Called when a process has been running stably for STABILITY_RESET_MS.
 * Resets restart counters and backoff so future restarts start fresh.
 */
function resetAfterStability(state) {
  log(`${state.name} has been stable for ${STABILITY_RESET_MS / 60000} minutes — resetting restart counters and backoff.`);
  state.restartTimestamps = [];
  state.consecutiveRestarts = 0;
  state.tripped = false;
}

/**
 * Start the stability timer. If the process runs for STABILITY_RESET_MS
 * without crashing, counters are reset.
 */
function startStabilityTimer(state) {
  if (state.stabilityTimer) clearTimeout(state.stabilityTimer);
  state.stabilityTimer = setTimeout(() => {
    resetAfterStability(state);
  }, STABILITY_RESET_MS);
}

/**
 * Cancel the stability timer (called when process exits/errors).
 */
function clearStabilityTimer(state) {
  if (state.stabilityTimer) {
    clearTimeout(state.stabilityTimer);
    state.stabilityTimer = null;
  }
}

// ── Generic restart handler ─────────────────────────────────────────────────
function handleExit(state, reason, startFn) {
  clearStabilityTimer(state);

  if (recordRestart(state)) {
    // Circuit breaker tripped — do not restart
    return;
  }

  const delay = getBackoffDelay(state);
  log(`${state.name} ${reason}. Restart #${state.consecutiveRestarts} in ${(delay / 1000).toFixed(1)}s (backoff)...`);
  setTimeout(startFn, delay);
}

// ── Dashboard ───────────────────────────────────────────────────────────────
const dashboardState = createCircuitState('dashboard.js');

function startDashboard() {
  log(`Starting dashboard.js (restart #${dashboardState.consecutiveRestarts})`);
  const child = spawn(process.execPath, [DASHBOARD], { cwd: __dirname, stdio: 'inherit' });

  startStabilityTimer(dashboardState);

  child.on('exit', (code, signal) => {
    handleExit(dashboardState, `exited — code=${code} signal=${signal}`, startDashboard);
  });
  child.on('error', (err) => {
    handleExit(dashboardState, `error — ${err.message}`, startDashboard);
  });
}

// ── Scheduler ───────────────────────────────────────────────────────────────
const schedulerState = createCircuitState('scheduler.js');

function startScheduler() {
  log(`Starting scheduler.js (restart #${schedulerState.consecutiveRestarts})`);
  const child = spawn(process.execPath, [SCHEDULER], { cwd: __dirname, stdio: 'inherit' });
  schedulerChild = child;

  startStabilityTimer(schedulerState);

  child.on('exit', (code, signal) => {
    handleExit(schedulerState, `exited — code=${code} signal=${signal}`, startScheduler);
  });
  child.on('error', (err) => {
    handleExit(schedulerState, `error — ${err.message}`, startScheduler);
  });
}

// ── Single-instance guard ───────────────────────────────────────────────────
const PID_FILE = path.join(__dirname, 'watchdog.pid');
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (oldPid && !isNaN(oldPid)) {
      try { process.kill(oldPid, 0); process.kill(oldPid, 'SIGTERM'); } catch {}
    }
  }
} catch {}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });

// ── Heartbeat monitoring — detect frozen scheduler ─────────────────────────
const HEARTBEAT_FILE    = path.join(__dirname, 'trade_history/heartbeat.json');
const HEARTBEAT_STALE_MS = 180000;  // 3 minutes without heartbeat = frozen
const HEARTBEAT_CHECK_MS = 90000;   // check every 90 seconds
let schedulerChild = null;

function checkSchedulerHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) return;
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    const age = Date.now() - hb.ts;
    if (age > HEARTBEAT_STALE_MS && schedulerChild && !schedulerChild.killed) {
      const targetPid = schedulerChild.pid; // always use the actual child PID, not hb.pid (avoids killing wrong process after PID recycling)
      log(`WARN: Scheduler heartbeat stale (${(age/1000).toFixed(0)}s old, last=${hb.lastTask}). Process appears frozen — sending SIGTERM to PID ${targetPid}`);
      warningAlert('Heartbeat Stale', `Scheduler heartbeat ${(age/1000).toFixed(0)}s old — process appears frozen, sending SIGTERM`, { pid: targetPid, lastTask: hb.lastTask, staleSec: (age/1000).toFixed(0) });
      try { process.kill(targetPid, 'SIGTERM'); } catch {}
      // Grace period: if still alive after 10s, force kill
      setTimeout(() => {
        try {
          process.kill(targetPid, 0); // check if still alive
          log(`WARN: Scheduler PID ${targetPid} did not exit after SIGTERM — sending SIGKILL`);
          process.kill(targetPid, 'SIGKILL');
        } catch {} // already dead — good
      }, 10000);
    }
  } catch {}
}
setInterval(checkSchedulerHeartbeat, HEARTBEAT_CHECK_MS);

log('Watchdog online (circuit breaker enabled: ' +
    `max ${CIRCUIT_MAX_RESTARTS} restarts per ${CIRCUIT_WINDOW_MS / 60000}min, ` +
    `backoff ${BASE_DELAY_MS / 1000}s-${MAX_DELAY_MS / 1000}s, ` +
    `stability reset after ${STABILITY_RESET_MS / 60000}min, ` +
    `heartbeat timeout ${HEARTBEAT_STALE_MS / 1000}s)`);
startDashboard();
startScheduler();
