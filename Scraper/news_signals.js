/**
 * News Signals — Converts AI-analyzed articles into trading signals
 *
 * Compatible with the trading app's signal format.
 * Aggregates sentiment by ticker, weights by confidence and urgency,
 * and outputs scored signals.
 */

const fs   = require('fs');
const path = require('path');

// Load .env from parent directory
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
}

const { fetchAllNews } = require('./scraper');
const { batchSummarize } = require('./summarizer');
const { UNIVERSE } = require('../data/universe');

const UNIVERSE_SET = new Set(UNIVERSE);

// Confidence multipliers
const CONFIDENCE_MULT = { high: 1.5, medium: 1.0, low: 0.5 };
// Urgency multipliers
const URGENCY_MULT    = { high: 1.3, medium: 1.0, low: 0.8 };
// Signal age decay: exponential decay with 24h half-life
// Breaking news (0h) = 1.0x, 12h = 0.71x, 24h = 0.5x, 48h = 0.25x
const DECAY_HALF_LIFE_HOURS = 24;
function ageDecay(publishedAt) {
  const hoursOld = (Date.now() - new Date(publishedAt).getTime()) / 3600000;
  return Math.exp(-0.693 * hoursOld / DECAY_HALF_LIFE_HOURS); // 0.693 = ln(2)
}

/**
 * Convert enriched articles into trading signals
 * @returns {Array} — signals in trading app format
 */
async function getSignals() {
  try {
    // 1. Fetch all news
    const articles = await fetchAllNews();

    // 2. Filter to articles mentioning tickers in UNIVERSE
    const relevant = articles.filter(a =>
      a.tickers && a.tickers.some(t => UNIVERSE_SET.has(t))
    );

    console.log(`[news_signals] ${relevant.length} articles mention UNIVERSE tickers`);

    if (relevant.length === 0) return [];

    // 3. Run AI analysis on relevant articles
    const enriched = await batchSummarize(relevant);

    // 4. Aggregate by ticker
    const tickerData = {};

    for (const article of enriched) {
      if (!article.analysis) continue;

      const { sentiment, confidence, urgency, summary } = article.analysis;
      if (!sentiment || sentiment === 'neutral') continue;

      // Get tickers from both article extraction and AI analysis
      const allTickers = new Set([
        ...(article.tickers || []),
        ...(article.analysis.tickers || []),
      ]);

      for (const ticker of allTickers) {
        if (!UNIVERSE_SET.has(ticker)) continue;

        if (!tickerData[ticker]) {
          tickerData[ticker] = {
            bullish: [],
            bearish: [],
            sources: new Set(),
            topSummary: '',
          };
        }

        const decay = ageDecay(article.publishedAt);
        const entry = {
          confidence: confidence || 'medium',
          urgency: urgency || 'medium',
          source: article.source,
          summary: summary || article.title,
          decay,  // 1.0 = fresh, 0.5 = 24h old, 0.25 = 48h old
        };

        if (sentiment === 'bullish') {
          tickerData[ticker].bullish.push(entry);
        } else if (sentiment === 'bearish') {
          tickerData[ticker].bearish.push(entry);
        }

        tickerData[ticker].sources.add(article.source);
        if (!tickerData[ticker].topSummary) {
          tickerData[ticker].topSummary = summary || article.title;
        }
      }
    }

    // 5. Score and generate signals
    const signals = [];

    for (const [ticker, data] of Object.entries(tickerData)) {
      const totalArticles = data.bullish.length + data.bearish.length;

      // Require 2+ articles to avoid noise from single mentions
      if (totalArticles < 2) continue;

      // Calculate base score weighted by age decay
      // Fresh articles contribute full weight, old articles contribute less
      const allEntries = [...data.bullish, ...data.bearish];
      const bullWeight = data.bullish.reduce((s, e) => s + (e.decay || 1), 0);
      const bearWeight = data.bearish.reduce((s, e) => s + (e.decay || 1), 0);
      const base = bullWeight * 15 - bearWeight * 10;

      // Decay-weighted average confidence multiplier
      const totalDecay = allEntries.reduce((s, e) => s + (e.decay || 1), 0) || 1;
      const avgConfidence = allEntries.reduce((sum, e) =>
        sum + (CONFIDENCE_MULT[e.confidence] || 1.0) * (e.decay || 1), 0
      ) / totalDecay;

      // Decay-weighted average urgency multiplier
      const avgUrgency = allEntries.reduce((sum, e) =>
        sum + (URGENCY_MULT[e.urgency] || 1.0) * (e.decay || 1), 0
      ) / totalDecay;

      // Final score
      const rawScore = base * avgConfidence * avgUrgency;
      const score = Math.min(80, Math.max(0, Math.round(rawScore)));

      // Determine direction
      const direction = data.bullish.length >= data.bearish.length ? 'bullish' : 'bearish';

      // Build reason string
      const sourceList = [...data.sources].join(', ');
      const reason = `News sentiment: ${data.bullish.length} bullish, ${data.bearish.length} bearish (${sourceList}) — "${data.topSummary?.slice(0, 80)}"`;

      signals.push({
        ticker,
        direction,
        score,
        reason,
        source: 'news_sentiment',
      });
    }

    // Sort by score descending
    signals.sort((a, b) => b.score - a.score);

    console.log(`[news_signals] Generated ${signals.length} signals`);
    return signals;

  } catch (err) {
    console.error(`[news_signals] Error: ${err.message}`);
    return [];
  }
}

module.exports = { getSignals };
