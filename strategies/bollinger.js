const { getBars, closes, bollingerBands, rsi, getVIX, adx } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

const ADX_MAX = 40; // Allow mean reversion up to moderate trend strength (raised from 25 — selloffs push ADX high on oversold quality stocks)

async function getSignals() {
  const vix = await getVIX();
  if (!vix || vix < 20) { console.log(`  [bollinger] VIX=${vix?.toFixed(1)||'?'} < 20 — skipping`); return []; }
  const signals = [];
  await Promise.allSettled(UNIVERSE.map(async ticker => {
    try {
      const bars  = await getBars(ticker, 60);
      const cls   = closes(bars);
      if (cls.length < 25) return;

      // ADX regime filter — skip strong trends where mean reversion fails
      const adxVal = adx(bars, 14);
      if (adxVal !== null && adxVal > ADX_MAX) return;

      const price  = cls[cls.length-1];
      const bb     = bollingerBands(cls, 20, 2);
      const rsiVal = rsi(cls, 14);
      if (!bb || rsiVal === null) return;
      if ((bb.upper-bb.lower)/bb.mid < 0.05) return;
      if (price < bb.lower && rsiVal < 35) {
        const dist  = (bb.lower-price)/bb.lower*100;
        // ADX bonus: lower ADX = stronger mean-reversion regime = higher score (capped at 25pt bonus)
        const adxBonus = adxVal !== null ? Math.min(12, Math.round((ADX_MAX - adxVal) * 0.5)) : 0;
        const score = Math.min(90, Math.round(dist*8 + Math.min(20,(vix-20)*0.8) + adxBonus));
        signals.push({ ticker, direction:'bullish', score, reason:`Bollinger: $${price.toFixed(2)} below lower $${bb.lower.toFixed(2)} (${dist.toFixed(1)}% outside), RSI=${rsiVal.toFixed(0)}, VIX=${vix.toFixed(1)}, ADX=${adxVal?.toFixed(0)||'?'}`, source:'bollinger' });
      }
    } catch {}
  }));
  return signals;
}

module.exports = { getSignals };
