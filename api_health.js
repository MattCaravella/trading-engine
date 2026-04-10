/**
 * API Health Monitor — Singleton tracker for all external API call success/failure
 *
 * Tracks: Alpaca, QuiverQuant, Alpha Vantage, Finnhub, Yahoo Finance,
 *         SEC EDGAR, Google Trends, RSS feeds
 *
 * Usage:
 *   const { recordSuccess, recordError } = require('./api_health');
 *   recordSuccess('alpaca_data', bars.length);
 *   recordError('alpaca_data', e.message);
 */
const fs   = require('fs');
const path = require('path');

const PERSIST_FILE = path.join(__dirname, 'trade_history/api_health.json');
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ONE_HOUR_MS = 60 * 60 * 1000;

// All known API names
const API_NAMES = [
  'alpaca_trading', 'alpaca_data',
  'quiver_congress', 'quiver_govcontracts', 'quiver_lobbying',
  'quiver_offexchange', 'quiver_shortvol', 'quiver_wsb',
  'alphavantage_sector', 'alphavantage_news', 'alphavantage_earnings',
  'finnhub_news', 'finnhub_earnings',
  'yahoo_vix',
  'sec_edgar',
  'google_trends',
  'rss_yahoo', 'rss_marketwatch', 'rss_cnbc', 'rss_seekingalpha',
];

function makeEntry() {
  return {
    lastSuccess: null,
    lastError: null,
    lastErrorMsg: '',
    successCount: 0,
    errorCount: 0,
    lastDataCount: 0,
    status: 'ok',
  };
}

// Initialize health object with all known APIs
const health = {};
for (const name of API_NAMES) {
  health[name] = makeEntry();
}

// Load persisted data on startup
function loadPersisted() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      for (const [apiName, entry] of Object.entries(data)) {
        if (health[apiName]) {
          Object.assign(health[apiName], entry);
        } else {
          // Unknown API from persisted data — still track it
          health[apiName] = { ...makeEntry(), ...entry };
        }
      }
      console.log('[API Health] Loaded persisted health data for', Object.keys(data).length, 'APIs');
    }
  } catch (e) {
    console.warn('[API Health] Failed to load persisted data:', e.message);
  }
}

function computeStatus(entry) {
  const now = Date.now();
  // If never called, leave as 'ok'
  if (!entry.lastSuccess && !entry.lastError) return 'ok';
  // If last call succeeded
  if (entry.lastSuccess && (!entry.lastError || new Date(entry.lastSuccess) >= new Date(entry.lastError))) {
    return 'ok';
  }
  // Last call failed — check if we had a success within the last hour
  if (entry.lastSuccess && (now - new Date(entry.lastSuccess).getTime()) < ONE_HOUR_MS) {
    return 'degraded';
  }
  // No success in the last hour (or never succeeded)
  return 'down';
}

function ensureEntry(apiName) {
  if (!health[apiName]) {
    health[apiName] = makeEntry();
  }
}

function recordSuccess(apiName, dataCount) {
  ensureEntry(apiName);
  const entry = health[apiName];
  entry.lastSuccess = new Date().toISOString();
  entry.successCount++;
  if (typeof dataCount === 'number') entry.lastDataCount = dataCount;
  entry.status = computeStatus(entry);
}

function recordError(apiName, errorMsg) {
  ensureEntry(apiName);
  const entry = health[apiName];
  entry.lastError = new Date().toISOString();
  entry.lastErrorMsg = (errorMsg || '').slice(0, 500);
  entry.errorCount++;
  entry.status = computeStatus(entry);
}

function getHealth() {
  // Recompute status for all entries before returning
  for (const entry of Object.values(health)) {
    entry.status = computeStatus(entry);
  }
  return { ...health };
}

function getOverallStatus() {
  let hasDown = false;
  let hasDegraded = false;
  for (const entry of Object.values(health)) {
    const status = computeStatus(entry);
    if (status === 'down') hasDown = true;
    if (status === 'degraded') hasDegraded = true;
  }
  if (hasDown) return 'critical';
  if (hasDegraded) return 'degraded';
  return 'healthy';
}

function persist() {
  try {
    const dir = path.dirname(PERSIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(health, null, 2));
  } catch (e) {
    console.warn('[API Health] Failed to persist:', e.message);
  }
}

// Load on startup
loadPersisted();

// Persist every 5 minutes
setInterval(persist, PERSIST_INTERVAL_MS);

// Also persist on process exit
process.on('exit', persist);

module.exports = { recordSuccess, recordError, getHealth, getOverallStatus };
