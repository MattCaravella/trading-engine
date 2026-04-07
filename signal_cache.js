const congress      = require('./monitors/congress');
const govcontracts  = require('./monitors/govcontracts');
const lobbying      = require('./monitors/lobbying');
const flights       = require('./monitors/flights');
const trending      = require('./monitors/trending');
const techsector    = require('./monitors/techsector');
const bollinger     = require('./strategies/bollinger');
const ma_crossover  = require('./strategies/ma_crossover');
const pairs_trading = require('./strategies/pairs_trading');
const insider_buying= require('./strategies/insider_buying');
const downtrend     = require('./strategies/downtrend');
const offexchange   = require('./monitors/offexchange');
const { aggregateByTicker } = require('./signals');

const SLOW_SOURCES = { congress, govcontracts, lobbying, insider_buying, downtrend, techsector };
const FAST_SOURCES = { bollinger, ma_crossover, pairs_trading, trending, flights };

// Signal staleness limits (milliseconds)
const SLOW_MAX_AGE = 24 * 60 * 60 * 1000;  // 24 hours for alt-data
const FAST_MAX_AGE = 2  * 60 * 60 * 1000;  // 2 hours for technical signals

let slowCache = { signals:[], updatedAt:null };
let fastCache = { signals:[], updatedAt:null };

async function refreshSlow() {
  console.log('\n[Cache] Refreshing SLOW sources...');
  const signals = [];
  const ts = Date.now();
  await Promise.allSettled(Object.entries(SLOW_SOURCES).map(async ([name,mod]) => {
    try {
      const s = await mod.getSignals();
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
      console.log(`  [${name}] ${s.length} signal(s)`);
    }
    catch(e) { console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  slowCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] SLOW updated — ${signals.length} signals`);
}

async function refreshFast() {
  console.log('\n[Cache] Refreshing FAST sources...');
  const signals = [];
  const ts = Date.now();
  await Promise.allSettled(Object.entries(FAST_SOURCES).map(async ([name,mod]) => {
    try {
      const s = await mod.getSignals();
      for (const sig of s) signals.push({ ...sig, source: name, _generatedAt: ts });
      console.log(`  [${name}] ${s.length} signal(s)`);
    }
    catch(e) { console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  fastCache = { signals, updatedAt: new Date() };
  console.log(`[Cache] FAST updated — ${signals.length} signals`);
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

  const all = [...freshSlow, ...freshFast];
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

module.exports = { refreshSlow, refreshFast, getCandidates, cacheStatus };
