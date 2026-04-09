const congress      = require('./monitors/congress');
const offexchange   = require('./monitors/offexchange');
const govcontracts  = require('./monitors/govcontracts');
const lobbying      = require('./monitors/lobbying');
const flights       = require('./monitors/flights');
const trending      = require('./monitors/trending');
const bollinger     = require('./strategies/bollinger');
const ma_crossover  = require('./strategies/ma_crossover');
const relative_value = require('./strategies/pairs_trading');
const insider_buying= require('./strategies/insider_buying');
const downtrend     = require('./strategies/downtrend');

const BUY_THRESHOLD = 65;  // Aligned with engine.js

// Primary sources: can trigger a buy on their own
// Overlay sources: can only BOOST a ticker that already has a primary signal
const PRIMARY_SOURCES = new Set(['bollinger', 'ma_crossover', 'relative_value', 'downtrend', 'insider_buying', 'techsector']);
const OVERLAY_SOURCES = new Set(['congress', 'govcontracts', 'lobbying', 'flights', 'trending', 'offexchange', 'news_sentiment']);

// Overlay cap: alt-data can add at most this much to a ticker's score
const OVERLAY_CAP = 25;

const { getLiveWeights } = require('./strategy_calibrator');

// Weights are loaded from calibrator (adaptive) with fallback to baseline
function getWeights() {
  return getLiveWeights();
}

function aggregateByTicker(signals) {
  const tickers = {};
  for (const s of signals) {
    const t = s.ticker;
    if (!tickers[t]) tickers[t] = { ticker: t, primaryScore: 0, overlayScore: 0, bearishScore: 0, signals: [], hasPrimary: false };
    const WEIGHTS = getWeights();
    const w = (WEIGHTS[s.source] || 1.0) * s.score;

    if (s.direction === 'bearish') {
      tickers[t].bearishScore += w;
    } else if (PRIMARY_SOURCES.has(s.source)) {
      tickers[t].primaryScore += w;
      tickers[t].hasPrimary = true;
    } else {
      // Overlay source — accumulate but will be capped
      tickers[t].overlayScore += w;
    }
    tickers[t].signals.push(s);
  }

  return Object.values(tickers).map(t => {
    // If ticker has NO primary signal, overlay is severely penalized (10% only)
    // This prevents congress/lobbying from triggering buys alone
    let effectiveOverlay;
    if (t.hasPrimary) {
      effectiveOverlay = Math.min(OVERLAY_CAP, t.overlayScore);
    } else {
      effectiveOverlay = Math.min(OVERLAY_CAP * 0.1, t.overlayScore * 0.1);
    }

    const bullishTotal = t.primaryScore + effectiveOverlay;
    const netScore = Math.min(100, Math.max(0, Math.round(bullishTotal - t.bearishScore)));

    return {
      ...t,
      bullishScore: bullishTotal,
      netScore,
      signalCount: t.signals.length,
      sources: [...new Set(t.signals.map(s => s.source))],
      confirmedByTech: t.hasPrimary,
    };
  }).sort((a, b) => b.netScore - a.netScore);
}

async function collectAllSignals() {
  const all = [];
  const sources = { congress, govcontracts, lobbying, flights, trending, bollinger, ma_crossover, relative_value, insider_buying, downtrend };
  await Promise.allSettled(Object.entries(sources).map(async ([name, mod]) => {
    try { const s = await mod.getSignals(); for (const sig of s) all.push({ ...sig, source: name }); }
    catch (e) { console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  const top25 = aggregateByTicker(all).slice(0, 25).map(t => t.ticker);
  try { const oe = await offexchange.getSignals(top25); for (const s of oe) all.push({ ...s, source: 'offexchange' }); } catch {}
  return all;
}

async function getTopCandidates() {
  const signals = await collectAllSignals();
  const ranked  = aggregateByTicker(signals);
  const buyCandidates = ranked.filter(t => t.netScore >= BUY_THRESHOLD);
  return { buyCandidates, allRanked: ranked };
}

module.exports = { getTopCandidates, collectAllSignals, aggregateByTicker, BUY_THRESHOLD, PRIMARY_SOURCES, OVERLAY_SOURCES };
