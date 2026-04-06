const { quiver } = require('./quiver');

const MIN_VALUE  = 50_000;
const MAX_DAYS   = 7;
const seen       = new Set();

function isRecent(d) { return d && (Date.now() - new Date(d).getTime()) / 86400000 <= MAX_DAYS; }

async function getSignals() {
  const data    = await quiver('/beta/live/govcontractsall');
  const signals = [];
  for (const item of data) {
    const ticker = item.Ticker;
    const value  = typeof item.Amount === 'number' ? item.Amount : parseFloat(item.Amount) || 0;
    const id     = `${ticker}-${value}-${item.Date}`;
    if (!ticker || value < MIN_VALUE || seen.has(id) || !isRecent(item.Date)) continue;
    seen.add(id);
    const score = Math.min(65, Math.round(Math.log10(value / 1_000) * 18));
    signals.push({ ticker, direction: 'bullish', score, reason: `Gov contract: $${(value/1000).toFixed(0)}K from ${item.Agency||'agency'} on ${item.Date}`, source: 'govcontracts' });
  }
  return signals;
}

module.exports = { getSignals };
