const { getBars, closes, sma, rsi } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

const fs   = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const TOKEN = process.env.QUIVER_API_TOKEN;

/**
 * Short Squeeze: high short interest + upward price momentum.
 * Uses QuiverQuant short volume data cross-referenced with technicals.
 */
async function getSignals() {
  const signals = [];

  try {
    // Fetch short volume data from QuiverQuant
    const res = await fetch('https://api.quiverquant.com/beta/live/shortvol', {
      headers: { 'Authorization': `Token ${TOKEN}`, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.log(`  [short_squeeze] QuiverQuant API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) { console.log('  [short_squeeze] unexpected API response'); return []; }

    // Build map of tickers with high short percentage
    const universeSet = new Set(UNIVERSE);
    const shortMap = new Map();
    for (const row of data) {
      const ticker = (row.Ticker || row.ticker || '').toUpperCase();
      if (!universeSet.has(ticker)) continue;
      const shortPct = parseFloat(row.ShortVolPercent || row.short_percent || row.ShortPercent || 0) * 100;
      if (shortPct > 20) {
        // Keep the highest short pct if duplicates
        if (!shortMap.has(ticker) || shortMap.get(ticker) < shortPct) {
          shortMap.set(ticker, shortPct);
        }
      }
    }

    // Cross-reference with price momentum
    const candidates = [...shortMap.entries()];
    const BATCH = 15;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async ([ticker, shortPct]) => {
        try {
          const bars = await getBars(ticker, 30);
          const cls  = closes(bars);
          if (cls.length < 21) return;

          const price    = cls[cls.length - 1];
          const sma20    = sma(cls, 20);
          const rsiVal   = rsi(cls, 14);
          if (!sma20 || rsiVal === null) return;

          // Require price above 20-SMA and RSI > 50
          if (price <= sma20 || rsiVal <= 50) return;

          const momentum_bonus = Math.min(15, Math.round((rsiVal - 50) * 0.5));
          const score = Math.min(80, Math.round(45 + (shortPct - 20) * 2 + momentum_bonus));

          signals.push({
            ticker,
            direction: 'bullish',
            score,
            reason: `Short squeeze: ${shortPct.toFixed(0)}% short, price above 20-SMA, RSI=${rsiVal.toFixed(0)}`,
            source: 'short_squeeze',
          });
        } catch {}
      }));
    }
  } catch (err) {
    console.log(`  [short_squeeze] error: ${err.message}`);
    return [];
  }

  console.log(`  [short_squeeze] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
