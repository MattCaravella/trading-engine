/**
 * Earnings Guard — Alpha Vantage
 *
 * Downloads the earnings calendar once per day (1 API call).
 * Returns a Set of tickers reporting earnings within BLOCK_DAYS days.
 * Engine uses this to skip buying before earnings (too risky for small positions).
 */

const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [k,...v]=line.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim();
});

const AV_KEY    = process.env.ALPHA_VANTAGE_KEY;
const AV_BASE   = 'https://www.alphavantage.co/query';
const BLOCK_DAYS = 5; // skip if earnings within 5 days

let _cache = { tickers: null, date: null };

async function fetchEarningsCalendar() {
  const today = new Date().toISOString().slice(0, 10);
  if (_cache.date === today && _cache.tickers) return _cache.tickers;

  const url = `${AV_BASE}?function=EARNINGS_CALENDAR&horizon=3month&apikey=${AV_KEY}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();

  if (!text || text.startsWith('{')) {
    // Got JSON back (rate limit message) instead of CSV
    console.warn('[earnings_guard] Alpha Vantage rate limit or error — skipping earnings check');
    return _cache.tickers || new Set();
  }

  const lines  = text.trim().split('\n').slice(1); // skip header
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + BLOCK_DAYS);

  const blocked = new Set();
  for (const line of lines) {
    const cols = line.split(',');
    const symbol     = cols[0]?.trim();
    const reportDate = cols[2]?.trim();
    if (!symbol || !reportDate) continue;
    const d = new Date(reportDate);
    if (d >= new Date() && d <= cutoff) blocked.add(symbol);
  }

  _cache = { tickers: blocked, date: today };
  console.log(`  [earnings_guard] ${blocked.size} tickers reporting within ${BLOCK_DAYS} days — will be skipped`);
  return blocked;
}

// Returns true if the ticker should be BLOCKED from buying
async function isEarningsBlock(ticker) {
  const blocked = await fetchEarningsCalendar().catch(() => new Set());
  return blocked.has(ticker);
}

// Returns full set of blocked tickers (for logging)
async function getBlockedTickers() {
  return fetchEarningsCalendar().catch(() => new Set());
}

module.exports = { isEarningsBlock, getBlockedTickers };
