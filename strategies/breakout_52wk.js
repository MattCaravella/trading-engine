const { getBars, closes, volumes, sma } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

/**
 * 52-week high breakout on volume.
 * Finds stocks making new 252-day highs with elevated volume.
 */
async function getSignals() {
  const signals = [];
  const BATCH = 20;
  const tickers = [...UNIVERSE];

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async ticker => {
      try {
        const bars = await getBars(ticker, 260);
        if (!bars || bars.length < 252) return;

        const cls     = closes(bars);
        const vols    = volumes(bars);
        const current = cls[cls.length - 1];

        // 52-week high = max of prior 251 closes (excluding today)
        const priorCloses = cls.slice(-252, -1);
        const high52      = Math.max(...priorCloses);

        if (current <= high52) return;

        // Volume confirmation: today's volume > 2x 20-day average
        const avgVol20 = sma(vols, 20);
        const todayVol = vols[vols.length - 1];
        if (!avgVol20 || avgVol20 === 0) return;
        const vol_ratio = todayVol / avgVol20;
        if (vol_ratio < 2) return;

        const pct_above = (current - high52) / high52 * 100;
        const volume_bonus = Math.min(15, Math.round((vol_ratio - 2) * 5));
        const score = Math.min(75, Math.round(40 + pct_above * 10 + volume_bonus));

        signals.push({
          ticker,
          direction: 'bullish',
          score,
          reason: `52wk breakout: $${current.toFixed(2)} is ${pct_above.toFixed(1)}% above prior high $${high52.toFixed(2)}, vol ${vol_ratio.toFixed(1)}x`,
          source: 'breakout_52wk',
        });
      } catch {}
    }));
  }

  console.log(`  [breakout_52wk] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
