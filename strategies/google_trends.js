const googleTrends = require('google-trends-api');
const { UNIVERSE } = require('../data/universe');

/**
 * Google Trends spike detection (overlay signal).
 * Checks top 50 most-liquid tickers for 7-day interest spikes (300%+).
 * Rate-limited: max 10 tickers per refresh, rotates through universe.
 */

// Persistent rotation state: track which batch to check next
let rotationIndex = 0;
const TICKERS_PER_RUN = 10;
const TOP_LIQUID_COUNT = 50;

// Top-50 most liquid tickers (first 50 from universe, which are large-cap tech/fin)
function getTopLiquid() {
  return UNIVERSE.slice(0, TOP_LIQUID_COUNT);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSignals() {
  const signals  = [];
  const liquid   = getTopLiquid();

  // Rotate through the liquid tickers in batches of TICKERS_PER_RUN
  const start = rotationIndex % liquid.length;
  const batch = [];
  for (let i = 0; i < TICKERS_PER_RUN; i++) {
    batch.push(liquid[(start + i) % liquid.length]);
  }
  rotationIndex = (start + TICKERS_PER_RUN) % liquid.length;

  for (const ticker of batch) {
    try {
      const result = await googleTrends.interestOverTime({
        keyword: ticker,
        startTime: new Date(Date.now() - 30 * 86400000), // 30 days
        endTime:   new Date(),
        geo: 'US',
      });

      const parsed = JSON.parse(result);
      const timeline = parsed?.default?.timelineData || [];
      if (timeline.length < 8) continue;

      // Compare last 7 days vs prior 23 days
      const recent = timeline.slice(-7);
      const prior  = timeline.slice(0, -7);

      const recentAvg = recent.reduce((s, d) => s + (d.value?.[0] || 0), 0) / recent.length;
      const priorAvg  = prior.reduce((s, d) => s + (d.value?.[0] || 0), 0) / (prior.length || 1);

      if (priorAvg === 0) continue;
      const spike_pct = ((recentAvg - priorAvg) / priorAvg) * 100;
      if (spike_pct < 300) continue;

      const score = Math.min(50, Math.round(20 + Math.min(30, spike_pct / 100)));

      signals.push({
        ticker,
        direction: 'bullish',
        score,
        reason: `Google Trends: ${spike_pct.toFixed(0)}% spike in 7-day interest (${recentAvg.toFixed(0)} vs ${priorAvg.toFixed(0)} prior avg)`,
        source: 'google_trends',
      });
    } catch {
      // Google may rate-limit; silently skip
    }

    // Rate limit: wait 2s between queries to avoid Google blocking
    await sleep(2000);
  }

  console.log(`  [google_trends] ${signals.length} signal(s) (checked ${batch.join(',')})`);
  return signals;
}

module.exports = { getSignals };
