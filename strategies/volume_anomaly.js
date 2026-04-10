const { getBars, closes, volumes, sma } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

/**
 * Volume Anomaly: unusual volume detection (overlay signal).
 * Fires when today's volume exceeds 5x the 20-day average.
 */
async function getSignals() {
  const signals = [];
  const BATCH = 25;
  const tickers = [...UNIVERSE];

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async ticker => {
      try {
        const bars = await getBars(ticker, 25);
        if (!bars || bars.length < 21) return;

        const vols     = volumes(bars);
        const todayVol = vols[vols.length - 1];
        const avgVol20 = sma(vols, 20);
        if (!avgVol20 || avgVol20 === 0) return;

        const vol_ratio = todayVol / avgVol20;
        if (vol_ratio < 5) return;

        // Determine direction from price action
        const cls   = closes(bars);
        const price = cls[cls.length - 1];
        const prev  = cls[cls.length - 2];
        const direction = price >= prev ? 'bullish' : 'bearish';

        const score = Math.min(45, Math.round(20 + Math.min(25, (vol_ratio - 5) * 5)));

        signals.push({
          ticker,
          direction,
          score,
          reason: `Volume anomaly: ${vol_ratio.toFixed(1)}x avg volume (${(todayVol/1e6).toFixed(1)}M vs ${(avgVol20/1e6).toFixed(1)}M avg)`,
          source: 'volume_anomaly',
        });
      } catch {}
    }));
  }

  console.log(`  [volume_anomaly] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
