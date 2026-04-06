const { quiver } = require('./quiver');

async function getSignals() {
  const [trending, popular] = await Promise.all([
    quiver('/beta/mobile/trendingtickers').catch(() => []),
    quiver('/beta/mobile/currentmostpopulartickers').catch(() => []),
  ]);
  const scores = {};

  for (const item of (Array.isArray(trending)?trending:[])) {
    const ticker = item.Ticker; const val = item.Value||0;
    if (!ticker || val < 5) continue;
    if (!scores[ticker]) scores[ticker] = { score:0, sources:[] };
    scores[ticker].score += Math.min(30, val*3);
    scores[ticker].sources.push(`trending(${val})`);
  }
  for (const item of (Array.isArray(popular)?popular:[])) {
    const ticker = item.Ticker; const val = item.Value||0;
    if (!ticker || val < 5) continue;
    if (!scores[ticker]) scores[ticker] = { score:0, sources:[] };
    scores[ticker].score += Math.min(25, val*2);
    scores[ticker].sources.push(`popular(${val})`);
  }

  return Object.entries(scores)
    .filter(([,v]) => v.score >= 15)
    .map(([ticker,v]) => ({ ticker, direction:'bullish', score:Math.min(v.score,50), reason:`Momentum: ${v.sources.join(', ')}`, source:'trending' }));
}

module.exports = { getSignals };
