const { getBars, closes, bollingerBands, rsi, getVIX } = require('../data/prices');

const UNIVERSE = ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','JPM','BAC','GS','MS','WMT','TGT','COST','HD','LOW','XOM','CVX','COP','SLB','PFE','JNJ','MRK','ABBV','UNH','LLY','BA','CAT','GE','MMM','AMD','INTC','QCOM','MU','AVGO','CRM','ORCL','IBM','CSCO','ADBE','SPY','QQQ','IWM','XLF','XLE','XLK','XLV','XLI','XLU','XLP'];

async function getSignals() {
  const vix = await getVIX();
  if (!vix || vix < 20) { console.log(`  [bollinger] VIX=${vix?.toFixed(1)||'?'} < 20 — skipping`); return []; }
  const signals = [];
  await Promise.allSettled(UNIVERSE.map(async ticker => {
    try {
      const bars  = await getBars(ticker, 60);
      const cls   = closes(bars);
      if (cls.length < 25) return;
      const price  = cls[cls.length-1];
      const bb     = bollingerBands(cls, 20, 2);
      const rsiVal = rsi(cls, 14);
      if (!bb || rsiVal === null) return;
      if ((bb.upper-bb.lower)/bb.mid < 0.05) return;
      if (price < bb.lower && rsiVal < 35) {
        const dist  = (bb.lower-price)/bb.lower*100;
        const score = Math.min(85, Math.round(dist*8 + Math.min(20,(vix-20)*0.8)));
        signals.push({ ticker, direction:'bullish', score, reason:`Bollinger: $${price.toFixed(2)} below lower $${bb.lower.toFixed(2)} (${dist.toFixed(1)}% outside), RSI=${rsiVal.toFixed(0)}, VIX=${vix.toFixed(1)}`, source:'bollinger' });
      }
    } catch {}
  }));
  return signals;
}

module.exports = { getSignals };
