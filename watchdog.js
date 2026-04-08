/**
 * Watchdog — keeps scheduler.js alive forever.
 * If it crashes or exits for any reason, restarts it after 5 seconds.
 */
const { spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');

const SCHEDULER   = path.join(__dirname, 'scheduler.js');
const WATCHDOG_LOG = path.join(__dirname, 'watchdog.log');
const RESTART_DELAY_MS = 5000;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(WATCHDOG_LOG, line);
}

let restarts = 0;

function start() {
  log(`Starting scheduler.js (restart #${restarts})`);

  const child = spawn(process.execPath, [SCHEDULER], {
    cwd: __dirname,
    stdio: 'inherit',   // share stdout/stderr with watchdog (so logs still go to redirected files)
  });

  child.on('exit', (code, signal) => {
    restarts++;
    log(`scheduler.js exited — code=${code} signal=${signal}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(start, RESTART_DELAY_MS);
  });

  child.on('error', (err) => {
    restarts++;
    log(`scheduler.js error — ${err.message}. Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(start, RESTART_DELAY_MS);
  });
}

log('Watchdog online');
start();
