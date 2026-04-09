/**
 * Short Entry Strategy — identifies stocks in confirmed downtrends suitable for shorting.
 *
 * Entry criteria:
 *   - ADX > 28 (confirmed trend strength — not just random noise)
 *   - Price below 50MA (macro downtrend established)
 *   - RSI 38–68 (NOT oversold — oversold stocks bounce violently; we want room to fall)
 *   - Minimum score threshold filters out weak setups
 *
 * Scores by: trend strength (ADX), RSI position, depth below 50MA, VIX, 20MA confirmation
 */
const { getBars, closes, sma, rsi, adx, getVIX } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

const ADX_MIN    = 28;   // Require confirmed downtrend
const RSI_MIN    = 38;   // Not oversold (bounce risk)
const RSI_MAX    = 68;   // Not so overbought it squeezes
const MIN_SCORE  = 30;   // Minimum signal quality

async function getSignals() {
  const vix = await getVIX();
  if (!vix || vix < 18) {
    console.log(`  [short_entry] VIX=${vix?.toFixed(1)||'?'} < 18 — skipping shorts (low vol = risky to short)`);
    return [];
  }

  const signals = [];
  await Promise.allSettled(UNIVERSE.map(async ticker => {
    try {
      const bars   = await getBars(ticker, 80);
      const cls    = closes(bars);
      if (cls.length < 30) return;

      const price  = cls[cls.length - 1];
      const ma20   = sma(cls, 20);
      const ma50   = sma(cls, 50);
      const rsiVal = rsi(cls, 14);
      const adxVal = adx(bars, 14);

      if (ma50 === null || rsiVal === null) return;
      if (adxVal === null || adxVal < ADX_MIN) return; // Needs confirmed trend
      if (rsiVal < RSI_MIN || rsiVal > RSI_MAX) return; // Oversold = bounce risk; skip
      if (price >= ma50) return;                         // Must be below 50MA to be in downtrend

      const below20MA    = ma20 !== null && price < ma20;
      const distBelow50  = (ma50 - price) / ma50 * 100;

      // Scoring components
      const adxScore   = Math.min(25, (adxVal - ADX_MIN) * 1.2);          // 0–25: trend confirmation
      const rsiScore   = Math.min(15, Math.max(0, (rsiVal - 38) * 0.5));  // 0–15: room to fall
      const depthScore = Math.min(20, distBelow50 * 2);                    // 0–20: below MA depth
      const vixScore   = Math.min(10, (vix - 18) * 0.5);                   // 0–10: volatile env
      const confBonus  = below20MA ? 10 : 0;                                // +10 below 20MA too

      const score = Math.round(adxScore + rsiScore + depthScore + vixScore + confBonus);
      if (score < MIN_SCORE) return;

      signals.push({
        ticker,
        direction: 'bearish',
        score,
        reason: `Short: $${price.toFixed(2)} below MA50=$${ma50.toFixed(2)} (${distBelow50.toFixed(1)}% down), RSI=${rsiVal.toFixed(0)}, ADX=${adxVal.toFixed(0)}, VIX=${vix.toFixed(1)}${below20MA ? ', below 20MA' : ''}`,
        source: 'short_entry'
      });
    } catch {}
  }));

  console.log(`  [short_entry] ${signals.length} short candidate(s)`);
  return signals;
}

module.exports = { getSignals };
