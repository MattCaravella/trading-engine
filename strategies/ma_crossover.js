const { getBars, closes, volumes, sma } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

async function getSignals() {
  const signals = [];
  await Promise.allSettled(UNIVERSE.map(async ticker => {
    try {
      const bars  = await getBars(ticker, 220);
      const cls   = closes(bars);
      const vols  = volumes(bars);
      if (cls.length < 205) return;
      const shortNow = sma(cls,50), longNow = sma(cls,200);
      const avgVol   = sma(vols,20), todayVol = vols[vols.length-1];
      if (!shortNow||!longNow||!avgVol) return;
      let crossed = false, daysAgo = 0;
      for (let i=1;i<=5;i++) {
        const ps = sma(cls.slice(0,-i),50), pl = sma(cls.slice(0,-i),200);
        if (ps&&pl&&ps<pl&&shortNow>longNow) { crossed=true; daysAgo=i; break; }
      }
      if (!crossed || cls[cls.length-1] <= longNow) return;
      const volRatio = todayVol/avgVol;
      if (volRatio < 1.5) return;
      const score = Math.min(80, 40 + (6-daysAgo)*5 + Math.min(20,Math.round((volRatio-1)*15)));
      signals.push({ ticker, direction:'bullish', score, reason:`Golden cross: 50MA $${shortNow.toFixed(2)} > 200MA $${longNow.toFixed(2)} (${daysAgo}d ago), vol ${volRatio.toFixed(1)}×`, source:'ma_crossover' });
    } catch {}
  }));
  return signals;
}

module.exports = { getSignals };
