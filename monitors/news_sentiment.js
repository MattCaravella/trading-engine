/**
 * News Sentiment Monitor — Integration bridge for the trading app
 *
 * Wraps Scraper/news_signals.js and exports { getSignals } matching
 * the existing monitor pattern used by signal_cache.js.
 *
 * This is an OVERLAY source — news sentiment boosts tickers that
 * already have primary technical signals, but doesn't trigger buys alone.
 */

const { getSignals: _getSignals } = require('../Scraper/news_signals');

async function getSignals() {
  try {
    return await _getSignals();
  } catch (err) {
    console.warn(`[news_sentiment] Error: ${err.message}`);
    return [];
  }
}

module.exports = { getSignals };
