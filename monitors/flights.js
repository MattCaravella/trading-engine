const { quiver } = require('./quiver');

const DEAL_CITIES = ['new york','manhattan','san francisco','london','chicago','boston','washington'];
const seen = new Set();

async function getSignals() {
  const data    = await quiver('/beta/live/flights');
  const signals = [];
  const byTicker = {};

  for (const item of data) {
    if (!item.Ticker) continue;
    if (!byTicker[item.Ticker]) byTicker[item.Ticker] = [];
    byTicker[item.Ticker].push(item);
  }

  for (const [ticker, flights] of Object.entries(byTicker)) {
    let score = 0; const reasons = [];
    for (const f of flights.slice(0,10)) {
      const id   = `${ticker}-${f.Date}-${f.Origin}-${f.Destination}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const dest = (f.Destination||'').toLowerCase();
      if (DEAL_CITIES.some(c => dest.includes(c))) { score += 15; reasons.push(`flight to ${f.Destination}`); }
      else score += 5;
    }
    if (score > 0 && reasons.length > 0)
      signals.push({ ticker, direction: 'bullish', score: Math.min(score,60), reason: `Exec flights: ${reasons.slice(0,2).join(', ')}`, source: 'flights' });
  }
  return signals;
}

module.exports = { getSignals };
