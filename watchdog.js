/**
 * Watchdog — keeps scheduler.js alive forever.
 * If it crashes or exits for any reason, restarts it after 5 seconds.
 */
const { spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');

const SCHEDULER    = path.join(__dirname, 'scheduler.js');
const DASHBOARD    = path.join(__dirname, 'dashboard.js');
const WATCHDOG_LOG = path.join(__dirname, 'watchdog.log');
const RESTART_DELAY_MS = 5000;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(WATCHDOG_LOG, line);
}

// ── Dashboard — start once, restart on crash ────────────────────────────────
let dashboardRestarts = 0;
function startDashboard() {
  log(`Starting dashboard.js (restart #${dashboardRestarts})`);
  const child = spawn(process.execPath, [DASHBOARD], { cwd: __dirname, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    dashboardRestarts++;
    log(`dashboard.js exited — code=${code} signal=${signal}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startDashboard, RESTART_DELAY_MS);
  });
  child.on('error', (err) => {
    dashboardRestarts++;
    log(`dashboard.js error — ${err.message}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startDashboard, RESTART_DELAY_MS);
  });
}

// ── Scheduler — start once, restart on crash ────────────────────────────────
let schedulerRestarts = 0;
function startScheduler() {
  log(`Starting scheduler.js (restart #${schedulerRestarts})`);
  const child = spawn(process.execPath, [SCHEDULER], { cwd: __dirname, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    schedulerRestarts++;
    log(`scheduler.js exited — code=${code} signal=${signal}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startScheduler, RESTART_DELAY_MS);
  });
  child.on('error', (err) => {
    schedulerRestarts++;
    log(`scheduler.js error — ${err.message}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startScheduler, RESTART_DELAY_MS);
  });
}

// Single-instance guard
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

log('Watchdog online');
startDashboard();
startScheduler();
