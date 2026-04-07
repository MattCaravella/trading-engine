const congress      = require('./monitors/congress');
const offexchange   = require('./monitors/offexchange');
const govcontracts  = require('./monitors/govcontracts');
const lobbying      = require('./monitors/lobbying');
const flights       = require('./monitors/flights');
const trending      = require('./monitors/trending');
const bollinger     = require('./strategies/bollinger');
const ma_crossover  = require('./strategies/ma_crossover');
const pairs_trading = require('./strategies/pairs_trading');
const insider_buying= require('./strategies/insider_buying');
const downtrend     = require('./strategies/downtrend');

const BUY_THRESHOLD = 70;
const WEIGHTS = { congress:1.5, insider_buying:1.4, offexchange:1.3, ma_crossover:1.2, downtrend:1.1, bollinger:1.1, govcontracts:1.0, pairs_trading:1.0, lobbying:0.8, techsector:0.9, flights:0.7, trending:0.6 };

function aggregateByTicker(signals) {
  const tickers = {};
  for (const s of signals) {
    const t = s.ticker;
    if (!tickers[t]) tickers[t] = { ticker:t, bullishScore:0, bearishScore:0, signals:[] };
    const w = (WEIGHTS[s.source]||1.0) * s.score;
    if (s.direction==='bullish') tickers[t].bullishScore += w;
    else tickers[t].bearishScore += w;
    tickers[t].signals.push(s);
  }
  return Object.values(tickers).map(t => ({
    ...t,
    netScore: Math.min(100, Math.max(0, Math.round(t.bullishScore - t.bearishScore))),
    signalCount: t.signals.length,
    sources: [...new Set(t.signals.map(s=>s.source))],
  })).sort((a,b)=>b.netScore-a.netScore);
}

async function collectAllSignals() {
  const all = [];
  const sources = { congress, govcontracts, lobbying, flights, trending, bollinger, ma_crossover, pairs_trading, insider_buying, downtrend };
  await Promise.allSettled(Object.entries(sources).map(async ([name,mod]) => {
    try { const s=await mod.getSignals(); for(const sig of s) all.push({...sig,source:name}); }
    catch(e) { console.warn(`  [${name}] failed: ${e.message}`); }
  }));
  const top25 = aggregateByTicker(all).slice(0,25).map(t=>t.ticker);
  try { const oe=await offexchange.getSignals(top25); for(const s of oe) all.push({...s,source:'offexchange'}); } catch {}
  return all;
}

async function getTopCandidates() {
  const signals = await collectAllSignals();
  const ranked  = aggregateByTicker(signals);
  const buyCandidates = ranked.filter(t=>t.netScore>=BUY_THRESHOLD);
  return { buyCandidates, allRanked: ranked };
}

module.exports = { getTopCandidates, collectAllSignals, aggregateByTicker, BUY_THRESHOLD };
