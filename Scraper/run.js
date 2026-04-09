#!/usr/bin/env node
/**
 * News Scraper CLI Runner
 *
 * Usage:
 *   node Scraper/run.js                    # Full pipeline: fetch + summarize + signals
 *   node Scraper/run.js --fetch-only       # Just fetch articles, no AI analysis
 *   node Scraper/run.js --ticker NVDA      # Filter to specific ticker
 *   node Scraper/run.js --ticker AAPL,NVDA # Filter to multiple tickers
 */

const fs   = require('fs');
const path = require('path');

// Load .env from parent directory (same pattern as the trading app)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
}

const { fetchAllNews }   = require('./scraper');
const { batchSummarize } = require('./summarizer');
const { getSignals }     = require('./news_signals');
const { cacheStats }     = require('./cache');

// ─── Parse CLI args ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    fetchOnly: false,
    tickers: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fetch-only') {
      opts.fetchOnly = true;
    } else if (args[i] === '--ticker' && args[i + 1]) {
      opts.tickers = args[i + 1].split(',').map(t => t.trim().toUpperCase());
      i++;
    }
  }

  return opts;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────────

function printDivider(label) {
  const line = '─'.repeat(70);
  console.log(`\n${line}`);
  if (label) console.log(`  ${label}`);
  console.log(line);
}

function printArticleTable(articles) {
  // Group by source
  const bySource = {};
  for (const a of articles) {
    if (!bySource[a.source]) bySource[a.source] = [];
    bySource[a.source].push(a);
  }

  printDivider('ARTICLES BY SOURCE');
  for (const [source, items] of Object.entries(bySource).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${source.toUpperCase()} (${items.length} articles)`);
    for (const a of items.slice(0, 5)) {
      const tickers = a.tickers.length > 0 ? ` [${a.tickers.join(', ')}]` : '';
      const date = new Date(a.publishedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
      console.log(`    ${date} | ${a.title.slice(0, 60)}${tickers}`);
    }
    if (items.length > 5) {
      console.log(`    ... and ${items.length - 5} more`);
    }
  }

  // Summary
  console.log(`\n  TOTAL: ${articles.length} articles from ${Object.keys(bySource).length} sources`);
}

function printAnalysisTable(enriched) {
  const analyzed = enriched.filter(a => a.analysis);
  if (analyzed.length === 0) {
    console.log('\n  No articles were analyzed (missing ANTHROPIC_API_KEY or no articles)');
    return;
  }

  printDivider('AI ANALYSIS RESULTS');

  const sentimentCounts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const a of analyzed) {
    sentimentCounts[a.analysis.sentiment] = (sentimentCounts[a.analysis.sentiment] || 0) + 1;
  }

  console.log(`\n  Sentiment breakdown: ${sentimentCounts.bullish} bullish, ${sentimentCounts.bearish} bearish, ${sentimentCounts.neutral} neutral`);
  console.log(`  Analyzed: ${analyzed.length} / ${enriched.length} articles\n`);

  // Show top bullish and bearish
  const bullish = analyzed.filter(a => a.analysis.sentiment === 'bullish' && a.analysis.confidence !== 'low');
  const bearish = analyzed.filter(a => a.analysis.sentiment === 'bearish' && a.analysis.confidence !== 'low');

  if (bullish.length > 0) {
    console.log('  TOP BULLISH:');
    for (const a of bullish.slice(0, 5)) {
      const tickers = a.analysis.tickers?.join(', ') || a.tickers.join(', ') || 'N/A';
      console.log(`    + [${a.analysis.confidence}/${a.analysis.urgency}] ${a.analysis.summary?.slice(0, 60) || a.title.slice(0, 60)} | ${tickers}`);
    }
  }

  if (bearish.length > 0) {
    console.log('\n  TOP BEARISH:');
    for (const a of bearish.slice(0, 5)) {
      const tickers = a.analysis.tickers?.join(', ') || a.tickers.join(', ') || 'N/A';
      console.log(`    - [${a.analysis.confidence}/${a.analysis.urgency}] ${a.analysis.summary?.slice(0, 60) || a.title.slice(0, 60)} | ${tickers}`);
    }
  }
}

function printSignalsTable(signals) {
  printDivider('TRADING SIGNALS (sorted by score)');

  if (signals.length === 0) {
    console.log('\n  No signals generated (need 2+ articles per ticker)');
    return;
  }

  console.log(`\n  ${'Ticker'.padEnd(8)} ${'Dir'.padEnd(8)} ${'Score'.padEnd(6)} Reason`);
  console.log(`  ${'------'.padEnd(8)} ${'---'.padEnd(8)} ${'-----'.padEnd(6)} ------`);

  for (const s of signals.slice(0, 20)) {
    const dir = s.direction === 'bullish' ? '+BULL' : '-BEAR';
    console.log(`  ${s.ticker.padEnd(8)} ${dir.padEnd(8)} ${String(s.score).padEnd(6)} ${s.reason.slice(0, 70)}`);
  }

  if (signals.length > 20) {
    console.log(`\n  ... and ${signals.length - 20} more signals`);
  }

  console.log(`\n  TOTAL: ${signals.length} signals`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log('=== News Scraper + AI Summarizer ===');
  console.log(`Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  if (opts.tickers) console.log(`Filter: ${opts.tickers.join(', ')}`);
  if (opts.fetchOnly) console.log(`Mode: fetch-only (no AI analysis)`);

  // Check API keys
  const hasAnthropic = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_key_here';
  const hasFinnhub = process.env.FINNHUB_API_KEY && process.env.FINNHUB_API_KEY !== 'your_finnhub_key_here';
  const hasAlphaVantage = !!process.env.ALPHA_VANTAGE_KEY;

  console.log(`\nAPI Keys: Anthropic=${hasAnthropic ? 'OK' : 'MISSING'}, Finnhub=${hasFinnhub ? 'OK' : 'MISSING'}, AlphaVantage=${hasAlphaVantage ? 'OK' : 'MISSING'}`);

  if (opts.fetchOnly) {
    // Just fetch and display
    const articles = await fetchAllNews(opts.tickers);
    printArticleTable(articles);
  } else if (opts.tickers) {
    // Filtered pipeline
    const articles = await fetchAllNews(opts.tickers);
    printArticleTable(articles);

    if (!hasAnthropic) {
      console.log('\n  Note: No Claude API key — using keyword-based sentiment analysis');
      console.log('  Add ANTHROPIC_API_KEY to .env for AI-powered analysis (higher accuracy)');
    }
    const enriched = await batchSummarize(articles);
    printAnalysisTable(enriched);
  } else {
    // Full pipeline via getSignals()
    const articles = await fetchAllNews();
    printArticleTable(articles);

    if (!hasAnthropic) {
      console.log('\n  Note: No Claude API key — using keyword-based sentiment analysis');
      console.log('  Add ANTHROPIC_API_KEY to .env for AI-powered analysis (higher accuracy)');
    }
    {
      const enriched = await batchSummarize(articles);
      printAnalysisTable(enriched);

      // Generate signals from enriched data (re-run through getSignals for full pipeline)
      // But since we already have enriched data, build signals directly here for efficiency
      const { UNIVERSE } = require('../data/universe');
      const UNIVERSE_SET = new Set(UNIVERSE);

      const CONFIDENCE_MULT = { high: 1.5, medium: 1.0, low: 0.5 };
      const URGENCY_MULT    = { high: 1.3, medium: 1.0, low: 0.8 };

      const tickerData = {};
      for (const article of enriched) {
        if (!article.analysis || article.analysis.sentiment === 'neutral') continue;
        const { sentiment, confidence, urgency, summary } = article.analysis;
        const allTickers = new Set([...(article.tickers || []), ...(article.analysis.tickers || [])]);
        for (const ticker of allTickers) {
          if (!UNIVERSE_SET.has(ticker)) continue;
          if (!tickerData[ticker]) tickerData[ticker] = { bullish: [], bearish: [], sources: new Set(), topSummary: '' };
          const entry = { confidence: confidence || 'medium', urgency: urgency || 'medium', source: article.source, summary: summary || article.title };
          if (sentiment === 'bullish') tickerData[ticker].bullish.push(entry);
          else if (sentiment === 'bearish') tickerData[ticker].bearish.push(entry);
          tickerData[ticker].sources.add(article.source);
          if (!tickerData[ticker].topSummary) tickerData[ticker].topSummary = summary || article.title;
        }
      }

      const signals = [];
      for (const [ticker, data] of Object.entries(tickerData)) {
        const totalArticles = data.bullish.length + data.bearish.length;
        if (totalArticles < 2) continue;
        const base = data.bullish.length * 15 - data.bearish.length * 10;
        const allEntries = [...data.bullish, ...data.bearish];
        const avgConf = allEntries.reduce((s, e) => s + (CONFIDENCE_MULT[e.confidence] || 1.0), 0) / allEntries.length;
        const avgUrg = allEntries.reduce((s, e) => s + (URGENCY_MULT[e.urgency] || 1.0), 0) / allEntries.length;
        const score = Math.min(80, Math.max(0, Math.round(base * avgConf * avgUrg)));
        const direction = data.bullish.length >= data.bearish.length ? 'bullish' : 'bearish';
        const sourceList = [...data.sources].join(', ');
        signals.push({
          ticker, direction, score,
          reason: `News sentiment: ${data.bullish.length} bullish, ${data.bearish.length} bearish (${sourceList}) — "${data.topSummary?.slice(0, 80)}"`,
          source: 'news_sentiment',
        });
      }
      signals.sort((a, b) => b.score - a.score);
      printSignalsTable(signals);
    }
  }

  // Cache stats
  const stats = cacheStats();
  console.log(`\n  Cache: ${stats.total} entries (${stats.fresh} fresh, ${stats.stale} stale)`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Completed in ${elapsed}s`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
