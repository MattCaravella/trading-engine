const fs = require('fs');
const path = require('path');
const { quiver } = require('./quiver');

const SEEN_FILE = path.join(__dirname, '../trade_history/congress_seen.json');
const MIN_AMOUNT = 1_000;
const MAX_DAYS_OLD = 30;

const HIGH_CONVICTION = ['nancy pelosi','paul pelosi','markwayne mullin','tommy tuberville','dan crenshaw','josh gottheimer','michael mccaul','gilbert cisneros'];

function loadSeen() {
  if (fs.existsSync(SEEN_FILE)) return new Set(JSON.parse(fs.readFileSync(SEEN_FILE)));
  return new Set();
}
function saveSeen(seen) {
  const dir = path.dirname(SEEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}
function isRecent(d) {
  if (!d) return false;
  return (Date.now() - new Date(d).getTime()) / 86400000 <= MAX_DAYS_OLD;
}

async function getSignals() {
  const [house, senate] = await Promise.all([
    quiver('/beta/live/housetrading').catch(() => []),
    quiver('/beta/live/senatetrading').catch(() => []),
  ]);
  const all = [...(Array.isArray(house)?house:[]), ...(Array.isArray(senate)?senate:[])];
  const seen = loadSeen();
  const signals = [];

  for (const t of all) {
    const id = `${t.Representative}-${t.Ticker}-${t.TransactionDate}-${t.Transaction}`;
    if (!t.Ticker || seen.has(id)) continue;
    seen.add(id);
    if (t.Transaction !== 'Purchase') continue;
    if (!isRecent(t.TransactionDate)) continue;
    const amount = parseFloat(t.Amount) || 0;
    if (amount < MIN_AMOUNT) continue;
    const rep = (t.Representative||'').toLowerCase();
    const hi  = HIGH_CONVICTION.some(m => rep.includes(m));
    let score = Math.min(40, Math.round(Math.log10(Math.max(amount,10)) * 8));
    if (hi) score = Math.min(80, score + 35);
    signals.push({ ticker: t.Ticker, direction: 'bullish', score, reason: `Congress: ${t.Representative} purchased $${amount.toLocaleString()} on ${t.TransactionDate}`, source: 'congress', raw: t });
  }
  saveSeen(seen);
  return signals;
}

module.exports = { getSignals };
