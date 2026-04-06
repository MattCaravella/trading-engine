const { quiver } = require('../monitors/quiver');

function isWithinDays(d, days) { return d && (Date.now()-new Date(d).getTime())/86400000 <= days; }

async function getSignals() {
  let trades = [];
  try {
    const ins = await quiver('/beta/live/insiders');
    if (Array.isArray(ins) && ins.length > 0)
      trades = ins.filter(t => (t.Transaction||'').toLowerCase().includes('buy') || (t.Transaction||'').toLowerCase().includes('purchase'));
  } catch {}
  if (trades.length === 0) {
    try {
      const cong = await quiver('/beta/live/congresstrading');
      if (Array.isArray(cong)) trades = cong.filter(t => t.Transaction === 'Purchase');
    } catch {}
  }
  if (trades.length === 0) return [];

  const byTicker = {};
  for (const t of trades) {
    const ticker = t.Ticker, date = t.TransactionDate||t.ReportDate, amount = parseFloat(t.Amount)||0;
    if (!ticker || !isWithinDays(date,90) || amount < 5_000) continue;
    const buyer = (t.Representative||t.InsiderName||t.Name||'unknown').toLowerCase();
    if (!byTicker[ticker]) byTicker[ticker] = { buyers:new Set(), trades:[], recent:0 };
    byTicker[ticker].buyers.add(buyer);
    byTicker[ticker].trades.push({ buyer, date, amount });
    if (isWithinDays(date,30)) byTicker[ticker].recent++;
  }

  return Object.entries(byTicker)
    .filter(([,d]) => d.buyers.size >= 2)
    .map(([ticker,d]) => {
      let score = Math.min(80, 35 + d.buyers.size*15);
      if (d.recent >= 2) score = Math.min(90, score+15);
      const total = d.trades.reduce((s,t)=>s+t.amount,0);
      return { ticker, direction:'bullish', score, reason:`Insider buying: ${d.buyers.size} unique buyers in 90d (${d.recent} in 30d), total $${(total/1000).toFixed(0)}K`, source:'insider_buying' };
    });
}

module.exports = { getSignals };
