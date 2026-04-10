const congress      = require('./monitors/congress');
const govcontracts  = require('./monitors/govcontracts');
const lobbying      = require('./monitors/lobbying');
const flights       = require('./monitors/flights');
const trending      = require('./monitors/trending');
const techsector    = require('./monitors/techsector');
const bollinger     = require('./strategies/bollinger');
const ma_crossover  = require('./strategies/ma_crossover');
const relative_value = require('./strategies/pairs_trading');
const insider_buying= require('./strategies/insider_buying');
const downtrend     = require('./strategies/downtrend');
const offexchange   = require('./monitors/offexchange');
const news_sentiment = require('./monitors/news_sentiment');
const short_entry   = require('./strategies/short_entry');
const { aggregateByTicker } = require('./signals');
const { criticalAlert } = require('./alerts');

// ─── Aggressive Sources (graceful fallback if files don't exist yet) ────────
let gap_and_go, breakout_52wk, short_squeeze, pead, volume_anomaly, wsb_velocity, sec_8k, google_trends;
const aggFallback = { getSignals: async () => [] };
try { gap_and_go     = require('./strategies/gap_and_go'); }     catch { gap_and_go     = aggFallback; }
try { breakout_52wk  = require('./strategies/breakout_52wk'); }  catch { breakout_52wk  = aggFallback; }
try { short_squeeze  = require('./strategies/short_squeeze'); }  catch { short_squeeze  = aggFallback; }
try { pead           = require('./strategies/pead'); }           catch { pead           = aggFallback; }
try { volume_anomaly = require('./strategies/volume_anomaly'); } catch { volume_anomaly = aggFallback; }
try { wsb_velocity   = require('./monitors/wsb_velocity'); }     catch { wsb_velocity   = aggFallback; }
try { sec_8k         = require('./monitors/sec_8k'); }           catch { sec_8k         = aggFallback; }
try { google_trends  = require('./monitors/google_trends'); }    catch { google_trends  = aggFallback; }

const AGGRESSIVE_SOURCES = { gap_and_go, breakout_52wk, short_squeeze, pead, volume_anomaly, wsb_velocity, sec_8k, google_trends };

const SLOW_SOURCES  = { congress, govcontracts, lobbying, insider_buying, downtrend, techsector };
const FAST_SOURCES  = { bollinger, ma_crossover, relative_value, trending, flights };
const NEWS_SOURCES  = { news_sentiment };  // Separate schedule: 8 AM + 12 PM
const SHORT_SOURCES = { short_entry };     // Refreshed with FAST sources every 30 min

// Signal staleness limits (milliseconds)
const SLOW_MAX_AGE  = 24 * 60 * 60 * 1000;  // 24 hours for alt-data
const FAST_MAX_AGE  = 2  * 60 * 60 * 1000;  // 2 hours for technical signals
const SHORT_MAX_AGE = 2  * 60 * 60 * 1000;  // 2 hours for short signals
const API_FAILURE_THRESHOLD = 0.15;           // 15% failure rate → system kill

let slowCache  = { signals:[], updatedAt:null };
let fastCache  = { signals:[], updatedAt:null };
let newsCache  = { signals:[], updatedAt:null };
let shortCache = { signals:[], updatedAt:null };
let healthStatus = { slowFails: 0, slowTotal: 0, fastFails: 0, fastTotal: 0, degraded: false };

async function refreshSlow() {
  console.log('\n[Cache] Refreshing SLOW sources...');
  const signals = [];
  const ts = Date.now();
  let fails = 0;
  const total = Object.keys(SLOW_SOURCES).length;
  await Promise.allSettled(Object.entries(SLOW_SOURCES).map(async ([name,mod]) => {
    try {
      const s = await mod.getSignals();
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
      console.log(`  [${name}] ${s.length} signal(s)`);
    }
    catch(e) { fails++; console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  healthStatus.slowFails = fails;
  healthStatus.slowTotal = total;
  updateHealthStatus();
  slowCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] SLOW updated — ${signals.length} signals${fails > 0 ? ` (${fails}/${total} sources failed)` : ''}`);
}

async function refreshFast() {
  console.log('\n[Cache] Refreshing FAST sources...');
  const signals = [];
  const ts = Date.now();
  let fails = 0;
  const total = Object.keys(FAST_SOURCES).length;
  await Promise.allSettled(Object.entries(FAST_SOURCES).map(async ([name,mod]) => {
    try {
      const s = await mod.getSignals();
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
      console.log(`  [${name}] ${s.length} signal(s)`);
    }
    catch(e) { fails++; console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  healthStatus.fastFails = fails;
  healthStatus.fastTotal = total;
  updateHealthStatus();
  fastCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] FAST updated — ${signals.length} signals${fails > 0 ? ` (${fails}/${total} sources failed)` : ''}`);
}

async function refreshNews() {
  console.log('\n[Cache] Refreshing NEWS sources...');
  const signals = [];
  const ts = Date.now();
  let fails = 0;
  const total = Object.keys(NEWS_SOURCES).length;
  await Promise.allSettled(Object.entries(NEWS_SOURCES).map(async ([name,mod]) => {
    try {
      const s = await mod.getSignals();
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
      console.log(`  [${name}] ${s.length} signal(s)`);
    }
    catch(e) { fails++; console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  newsCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] NEWS updated — ${signals.length} signals${fails > 0 ? ` (${fails}/${total} sources failed)` : ''}`);
}

async function refreshShort() {
  console.log('\n[Cache] Refreshing SHORT sources...');
  const signals = [];
  const ts = Date.now();
  let fails = 0;
  const total = Object.keys(SHORT_SOURCES).length;
  await Promise.allSettled(Object.entries(SHORT_SOURCES).map(async ([name, mod]) => {
    try {
      const s = await mod.getSignals();
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
    }
    catch (e) { fails++; console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  shortCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] SHORT updated — ${signals.length} candidates${fails > 0 ? ` (${fails}/${total} sources failed)` : ''}`);
}

function getShortCandidates() {
  const now   = Date.now();
  const fresh = shortCache.signals.filter(s => !s._generatedAt || (now - s._generatedAt) < SHORT_MAX_AGE);
  // Sort by score descending, return top 20
  return fresh.sort((a, b) => b.score - a.score).slice(0, 20);
}

async function getCandidates() {
  const now = Date.now();

  // Filter out stale signals
  const freshSlow = slowCache.signals.filter(s => !s._generatedAt || (now - s._generatedAt) < SLOW_MAX_AGE);
  const freshFast = fastCache.signals.filter(s => !s._generatedAt || (now - s._generatedAt) < FAST_MAX_AGE);

  const staleSlowCount = slowCache.signals.length - freshSlow.length;
  const staleFastCount = fastCache.signals.length - freshFast.length;
  if (staleSlowCount > 0 || staleFastCount > 0) {
    console.log(`  [Cache] Dropped ${staleSlowCount} stale slow + ${staleFastCount} stale fast signals`);
  }

  const freshNews = newsCache.signals.filter(s => !s._generatedAt || (now - s._generatedAt) < SLOW_MAX_AGE);
  const all = [...freshSlow, ...freshFast, ...freshNews];
  if (all.length === 0) return [];
  const top25 = aggregateByTicker(all).slice(0, 25).map(t => t.ticker);
  try { const oe = await offexchange.getSignals(top25); for (const s of oe) all.push({ ...s, source: 'offexchange', _generatedAt: now }); } catch {}
  return aggregateByTicker(all);
}

function cacheStatus() {
  const fmt = d => d ? d.toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) : 'never';
  const slowAge = slowCache.updatedAt ? Math.round((Date.now() - slowCache.updatedAt.getTime()) / 60000) : null;
  const fastAge = fastCache.updatedAt ? Math.round((Date.now() - fastCache.updatedAt.getTime()) / 60000) : null;
  return {
    slow: { count: slowCache.signals.length, updatedAt: fmt(slowCache.updatedAt), ageMinutes: slowAge },
    fast: { count: fastCache.signals.length, updatedAt: fmt(fastCache.updatedAt), ageMinutes: fastAge },
  };
}

function updateHealthStatus() {
  const totalSources = healthStatus.slowTotal + healthStatus.fastTotal;
  const totalFails   = healthStatus.slowFails + healthStatus.fastFails;
  const failRate     = totalSources > 0 ? totalFails / totalSources : 0;
  healthStatus.degraded = failRate >= API_FAILURE_THRESHOLD;
  if (healthStatus.degraded) {
    console.warn(`  [HEALTH] ⚠ SYSTEM DEGRADED: ${totalFails}/${totalSources} sources failed (${(failRate*100).toFixed(0)}% > ${API_FAILURE_THRESHOLD*100}% threshold)`);
    console.warn(`  [HEALTH] ⚠ No new trades will be placed until data sources recover`);
    criticalAlert('System Health Degraded', `${totalFails}/${totalSources} data sources failed (${(failRate*100).toFixed(0)}% failure rate)`, { totalFails, totalSources, failRate: (failRate*100).toFixed(1) + '%', threshold: (API_FAILURE_THRESHOLD*100) + '%' });
  }
}

function isSystemHealthy() {
  return !healthStatus.degraded;
}

function getHealthStatus() {
  const totalSources = healthStatus.slowTotal + healthStatus.fastTotal;
  const totalFails   = healthStatus.slowFails + healthStatus.fastFails;
  return {
    healthy: !healthStatus.degraded,
    failRate: totalSources > 0 ? (totalFails / totalSources * 100).toFixed(1) + '%' : '0%',
    slowFails: healthStatus.slowFails,
    fastFails: healthStatus.fastFails,
    totalSources,
    totalFails,
  };
}

// ─── Aggressive Signal Cache ────────────────────────────────────────────────
const AGGRESSIVE_MAX_AGE = 30 * 60 * 1000;  // 30 minutes for aggressive signals

let aggressiveCache = { signals: [], updatedAt: null };

async function refreshAggressive() {
  console.log('\n[Cache] Refreshing AGGRESSIVE sources...');
  const signals = [];
  const ts = Date.now();
  let fails = 0;
  let loaded = 0;
  const total = Object.keys(AGGRESSIVE_SOURCES).length;
  await Promise.allSettled(Object.entries(AGGRESSIVE_SOURCES).map(async ([name, mod]) => {
    try {
      const s = await mod.getSignals();
      if (s.length > 0) loaded++;
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
      console.log(`  [${name}] ${s.length} signal(s)`);
    } catch (e) {
      fails++;
      console.warn(`  [${name}] failed: ${e.message}`);
    }
  }));
  aggressiveCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] AGGRESSIVE updated — ${signals.length} signals from ${loaded}/${total} sources${fails > 0 ? ` (${fails} failed)` : ''}`);

  // Write candidates to file for dashboard (separate process can't share memory)
  try {
    const candidates = getAggressiveCandidates();
    const PIPELINE_FILE = path.join(__dirname, 'trade_history/aggressive_pipeline.json');
    fs.writeFileSync(PIPELINE_FILE, JSON.stringify({ candidates, updatedAt: new Date().toISOString() }));
  } catch {}
}

function getAggressiveCandidates() {
  const now = Date.now();
  const fresh = aggressiveCache.signals.filter(s => !s._generatedAt || (now - s._generatedAt) < AGGRESSIVE_MAX_AGE);
  const staleCount = aggressiveCache.signals.length - fresh.length;
  if (staleCount > 0) console.log(`  [Cache] Dropped ${staleCount} stale aggressive signals`);
  if (fresh.length === 0) return [];

  // Aggressive aggregation: simple — all sources are primary, no overlay penalty
  // Group by ticker, sum scores, pick highest-scoring source as top signal
  const byTicker = {};
  for (const sig of fresh) {
    if (!byTicker[sig.ticker]) byTicker[sig.ticker] = { ticker: sig.ticker, signals: [], totalScore: 0, sources: [] };
    byTicker[sig.ticker].signals.push(sig);
    byTicker[sig.ticker].totalScore += sig.score;
    if (!byTicker[sig.ticker].sources.includes(sig.source)) byTicker[sig.ticker].sources.push(sig.source);
  }

  return Object.values(byTicker)
    .map(t => {
      const top = t.signals.sort((a, b) => b.score - a.score)[0];
      return {
        ticker: t.ticker,
        netScore: Math.min(100, t.totalScore),
        signals: t.signals,
        sources: t.sources,
        direction: top.direction,
        topReason: top.reason,
        topSource: top.source,
        confirmedByTech: true, // aggressive engine treats all signals as confirmed
      };
    })
    .filter(c => c.netScore >= 50) // aggressive threshold
    .sort((a, b) => b.netScore - a.netScore)
    .slice(0, 20);
}

module.exports = { refreshSlow, refreshFast, refreshNews, refreshShort, refreshAggressive, getCandidates, getShortCandidates, getAggressiveCandidates, cacheStatus, isSystemHealthy, getHealthStatus };
