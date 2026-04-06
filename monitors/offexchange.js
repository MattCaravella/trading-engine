const { quiver } = require('./quiver');

async function getTickerSignal(ticker) {
  const data = await quiver(`/beta/historical/offexchange/${ticker}`).catch(() => null);
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  const latest   = data[data.length - 1];
  const shortPct = parseFloat(latest.OffExchangeShortPercent || latest.ShortPercent || latest.ShortVolPercent || 0);
  if (isNaN(shortPct) || shortPct === 0) return null;
  if (shortPct <= 30) return { ticker, direction: 'bullish', score: Math.round((30 - shortPct) / 30 * 40), reason: `Dark pool: ${shortPct.toFixed(1)}% short volume — accumulation`, source: 'offexchange' };
  if (shortPct >= 60) return { ticker, direction: 'bearish', score: Math.round((shortPct - 60) / 40 * 40), reason: `Dark pool: ${shortPct.toFixed(1)}% short volume — distribution`, source: 'offexchange' };
  return null;
}

async function getSignals(tickers = []) {
  if (tickers.length === 0) return [];
  const results = await Promise.allSettled(tickers.map(t => getTickerSignal(t)));
  return results.filter(r => r.status === 'fulfilled' && r.value !== null).map(r => r.value);
}

module.exports = { getSignals, getTickerSignal };
