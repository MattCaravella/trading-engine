const { quiver } = require('./quiver');

const MIN_AMOUNT = 20_000;
const MAX_DAYS   = 30;
const seen       = new Set();

function isRecent(d) { return d && (Date.now() - new Date(d).getTime()) / 86400000 <= MAX_DAYS; }

async function getSignals() {
  const data    = await quiver('/beta/live/lobbying');
  const signals = [];
  const byTicker = {};

  for (const item of data) {
    const ticker = item.Ticker;
    const amount = parseFloat(item.Amount) || 0;
    const id     = `${ticker}-${amount}-${item.Date}-${item.Registrant}`;
    if (!ticker || amount < MIN_AMOUNT || seen.has(id) || !isRecent(item.Date)) continue;
    seen.add(id);
    if (!byTicker[ticker]) byTicker[ticker] = { total: 0, count: 0, issues: [], latest: item };
    byTicker[ticker].total += amount;
    byTicker[ticker].count++;
    byTicker[ticker].issues.push(...(item.Issue||'').split('\n').map(s=>s.trim()).filter(Boolean));
  }

  for (const [ticker, agg] of Object.entries(byTicker)) {
    const score     = Math.min(55, Math.round(Math.log10(Math.max(agg.total,100)) * 14));
    const topIssues = [...new Set(agg.issues)].slice(0,2).join(', ');
    signals.push({ ticker, direction: 'bullish', score, reason: `Lobbying: $${(agg.total/1000).toFixed(0)}K — ${topIssues||'various'}`, source: 'lobbying' });
  }
  return signals;
}

module.exports = { getSignals };
