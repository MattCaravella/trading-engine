const { getBars, closes, volumes, sma } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

/**
 * Gap-and-Go: pre-market gap continuation.
 * Scans for stocks gapping up 3%+ with elevated volume.
 */
async function getSignals() {
  const signals = [];
  const BATCH = 25;
  const tickers = [...UNIVERSE];

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async ticker => {
      try {
        const bars = await getBars(ticker, 5);
        if (!bars || bars.length < 2) return;

        const today     = bars[bars.length - 1];
        const yesterday = bars[bars.length - 2];

        // Gap = (today open - yesterday close) / yesterday close
        const gap_pct = (today.o - yesterday.c) / yesterday.c * 100;
        if (gap_pct < 3) return;

        // Volume check: today's volume vs average of prior bars
        const priorVols = bars.slice(0, -1).map(b => b.v);
        const avgVol    = priorVols.reduce((a, b) => a + b, 0) / priorVols.length;
        const vol_ratio = avgVol > 0 ? today.v / avgVol : 0;
        if (vol_ratio < 2) return;

        const volume_bonus = Math.min(15, Math.round((vol_ratio - 2) * 5));
        const score = Math.min(80, Math.round(40 + gap_pct * 5 + volume_bonus));

        signals.push({
          ticker,
          direction: 'bullish',
          score,
          reason: `Gap-and-Go: ${gap_pct.toFixed(1)}% gap up, volume ${vol_ratio.toFixed(1)}x avg`,
          source: 'gap_and_go',
        });
      } catch {}
    }));
  }

  console.log(`  [gap_and_go] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
