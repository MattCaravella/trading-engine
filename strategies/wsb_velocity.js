const fs   = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const TOKEN = process.env.QUIVER_API_TOKEN;
const { UNIVERSE } = require('../data/universe');

/**
 * WSB Velocity: Reddit WallStreetBets mention acceleration (overlay signal).
 * Signals when a ticker's mention count is >100/day AND 5x+ vs 7-day average.
 */
async function getSignals() {
  const signals = [];

  try {
    const res = await fetch('https://api.quiverquant.com/beta/live/wallstreetbets', {
      headers: { 'Authorization': `Token ${TOKEN}`, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.log(`  [wsb_velocity] QuiverQuant API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) { console.log('  [wsb_velocity] unexpected API response'); return []; }

    const universeSet = new Set(UNIVERSE);

    // Group mentions by ticker across dates to compute velocity
    const byTicker = new Map();
    for (const row of data) {
      const ticker = (row.Ticker || row.ticker || '').toUpperCase();
      if (!universeSet.has(ticker)) continue;
      const count = parseFloat(row.Count || row.count || row.Mentions || row.mentions || 0);
      const date  = row.Date || row.date || '';
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push({ date, count });
    }

    for (const [ticker, entries] of byTicker) {
      // Sort by date descending
      entries.sort((a, b) => b.date.localeCompare(a.date));

      // Latest day mentions
      const latest = entries[0];
      if (!latest || latest.count < 100) continue;

      // 7-day average (excluding latest)
      const priorEntries = entries.slice(1, 8);
      if (priorEntries.length === 0) continue;
      const avgMentions = priorEntries.reduce((s, e) => s + e.count, 0) / priorEntries.length;
      if (avgMentions === 0) continue;

      const velocity_factor = latest.count / avgMentions;
      if (velocity_factor < 5) continue;

      const score = Math.min(50, Math.round(20 + Math.min(30, velocity_factor * 5)));

      signals.push({
        ticker,
        direction: 'bullish',
        score,
        reason: `WSB velocity: ${latest.count} mentions (${velocity_factor.toFixed(1)}x vs 7d avg of ${avgMentions.toFixed(0)})`,
        source: 'wsb_velocity',
      });
    }
  } catch (err) {
    console.log(`  [wsb_velocity] error: ${err.message}`);
    return [];
  }

  console.log(`  [wsb_velocity] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
