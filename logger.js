const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, 'trade_history');
const CSV_FILE = path.join(HISTORY_DIR, 'trade_history.csv');
const CSV_HEADER = 'date,time,id,symbol,side,qty,type,time_in_force,status,submitted_at\n';

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, CSV_HEADER);
}

function logTrade(order) {
  ensureDir();
  const submitted = new Date(order.submitted_at || Date.now());
  const date = submitted.toISOString().slice(0, 10);
  const time = submitted.toISOString().slice(11, 19);

  const row = [
    date, time, order.id, order.symbol, order.side, order.qty,
    order.type, order.time_in_force, order.status,
    order.submitted_at || submitted.toISOString(),
  ].join(',') + '\n';

  fs.appendFileSync(CSV_FILE, row);

  const jsonFile = path.join(HISTORY_DIR, `${date}_${order.symbol}_${order.side}_${(order.id||'').slice(0,8)}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(order, null, 2));
  console.log(`  Logged to trade_history/`);
}

module.exports = { logTrade };
