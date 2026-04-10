const { getBars, closes } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

const fs   = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

/**
 * PEAD: Post-Earnings Announcement Drift.
 * Finds stocks that beat earnings in the last 3 days and expects 2-10 day drift.
 */
async function getSignals() {
  const signals = [];

  try {
    // Date range: last 3 days
    const now   = new Date();
    const from  = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
    const to    = now.toISOString().slice(0, 10);

    // Try Finnhub earnings calendar
    let earnings = [];
    try {
      const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_KEY}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        earnings = (json.earningsCalendar || []);
      }
    } catch {}

    // Fallback: try Alpha Vantage if Finnhub returned nothing
    if (!earnings.length) {
      try {
        const avKey = process.env.ALPHA_VANTAGE_KEY;
        const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${avKey}`;
        const res = await fetch(url);
        if (res.ok) {
          const text = await res.text();
          // Alpha Vantage returns CSV: symbol,name,reportDate,fiscalDateEnding,estimate,currency
          const lines = text.split('\n').slice(1).filter(l => l.trim());
          const fromDate = new Date(from);
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length < 5) continue;
            const reportDate = new Date(parts[2]);
            if (reportDate >= fromDate && reportDate <= now) {
              earnings.push({
                symbol: parts[0],
                date: parts[2],
                epsEstimate: parseFloat(parts[4]) || null,
                epsActual: null, // AV calendar doesn't include actuals
              });
            }
          }
        }
      } catch {}
    }

    if (!earnings.length) {
      console.log('  [pead] no recent earnings data available');
      return [];
    }

    // Filter for universe and earnings beats
    const universeSet = new Set(UNIVERSE);
    const beats = [];

    for (const e of earnings) {
      const ticker   = (e.symbol || '').toUpperCase();
      if (!universeSet.has(ticker)) continue;
      const actual   = parseFloat(e.epsActual) || null;
      const estimate = parseFloat(e.epsEstimate) || null;
      if (actual === null || estimate === null) continue;
      if (actual <= estimate) continue; // No beat
      const beat_magnitude = estimate !== 0
        ? (actual - estimate) / Math.abs(estimate)
        : actual > 0 ? 1 : 0;
      beats.push({ ticker, actual, estimate, beat_magnitude, date: e.date });
    }

    // Validate with price data: check that post-earnings price action is positive
    const BATCH = 15;
    for (let i = 0; i < beats.length; i += BATCH) {
      const batch = beats.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async ({ ticker, actual, estimate, beat_magnitude, date }) => {
        try {
          const bars = await getBars(ticker, 10);
          const cls  = closes(bars);
          if (cls.length < 2) return;

          // Basic check: is the stock up from the pre-earnings close?
          const current  = cls[cls.length - 1];
          const preEarn  = cls[cls.length - 2];
          if (current <= preEarn) return; // Not drifting up

          const score = Math.min(85, Math.round(50 + beat_magnitude * 10));

          signals.push({
            ticker,
            direction: 'bullish',
            score,
            reason: `PEAD: EPS beat $${actual.toFixed(2)} vs est $${estimate.toFixed(2)} (${(beat_magnitude*100).toFixed(0)}% beat) on ${date}`,
            source: 'pead',
          });
        } catch {}
      }));
    }
  } catch (err) {
    console.log(`  [pead] error: ${err.message}`);
    return [];
  }

  console.log(`  [pead] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
