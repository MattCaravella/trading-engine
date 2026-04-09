/**
 * News Scraper — Multi-source financial news data collection
 *
 * Sources:
 *   A. RSS Feeds (Yahoo Finance, MarketWatch, CNBC, Reuters, Seeking Alpha)
 *   B. Finnhub API (general + company news)
 *   C. Alpha Vantage News Sentiment
 *
 * All articles are normalized to a common format and deduped by URL.
 * Ticker symbols are extracted by matching against the UNIVERSE list.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

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

const { UNIVERSE } = require('../data/universe');

// Build a Set for fast ticker lookup
const TICKER_SET = new Set(UNIVERSE);

// Ticker extraction regex — match $AAPL or standalone uppercase 2-5 letter words
// that exist in our universe
const TICKER_REGEX = /\$([A-Z]{1,5})\b|(?<![a-zA-Z])([A-Z]{2,5})(?![a-zA-Z])/g;

function extractTickers(text) {
  if (!text) return [];
  const found = new Set();
  let match;
  // Reset regex
  TICKER_REGEX.lastIndex = 0;
  while ((match = TICKER_REGEX.exec(text)) !== null) {
    const ticker = match[1] || match[2];
    if (TICKER_SET.has(ticker)) {
      // Filter out common English words that are also tickers
      const COMMON_WORDS = new Set([
        'A', 'AN', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN', 'IS', 'IT',
        'ME', 'MY', 'NO', 'OF', 'OK', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE',
        'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAS',
        'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'DAY', 'HAD', 'HIS', 'HOW', 'ITS',
        'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'BOY', 'DID', 'GET', 'HIM',
        'LET', 'SAY', 'SHE', 'TOO', 'USE', 'CEO', 'IPO', 'GDP', 'FED', 'SEC',
        'ETF', 'EPS', 'NYSE', 'CEO', 'CFO', 'COO', 'CTO',
        'HIGH', 'LOW', 'OPEN', 'CLOSE', 'THAT', 'THIS', 'WITH', 'FROM',
        'HAVE', 'BEEN', 'WILL', 'JUST', 'WHAT', 'WHEN', 'MAKE', 'LIKE',
        'OVER', 'SUCH', 'TAKE', 'THAN', 'THEM', 'VERY', 'WELL', 'ALSO',
        'INTO', 'BACK', 'MUCH', 'MOST', 'ONLY', 'COME', 'MADE', 'AFTER',
        'YEAR', 'SOME', 'TIME', 'MORE', 'BEST', 'EVER', 'NEXT', 'LAST',
        'LONG', 'GOOD', 'LATE', 'REAL', 'FAST', 'PLAY', 'RIDE', 'RACE',
        'ROAD', 'CASH', 'DEAL', 'DEEP', 'GAIN', 'FUND', 'BANK', 'BOND',
        'CALL', 'SAVE', 'RISK',
      ]);
      if (!COMMON_WORDS.has(ticker)) {
        found.add(ticker);
      }
    }
  }
  return [...found];
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      // Follow redirects (up to 3)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ─── Simple XML parser (no dependencies) ───────────────────────────────────────

function parseXmlItems(xml) {
  const items = [];

  // Try RSS <item> format
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: extractXmlTag(block, 'title'),
      description: extractXmlTag(block, 'description'),
      link: extractXmlTag(block, 'link') || extractXmlAttr(block, 'link', 'href'),
      pubDate: extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'dc:date'),
    });
  }

  // Try Atom <entry> format if no RSS items found
  if (items.length === 0) {
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      items.push({
        title: extractXmlTag(block, 'title'),
        description: extractXmlTag(block, 'summary') || extractXmlTag(block, 'content'),
        link: extractXmlAttr(block, 'link', 'href') || extractXmlTag(block, 'link'),
        pubDate: extractXmlTag(block, 'published') || extractXmlTag(block, 'updated'),
      });
    }
  }

  return items;
}

function extractXmlTag(xml, tag) {
  // Match both <tag>content</tag> and <tag><![CDATA[content]]></tag>
  const regex = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  return match[1].replace(/<[^>]+>/g, '').trim();
}

function extractXmlAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function normalizeDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ─── Source A: RSS Feeds ────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: 'yahoo',       url: 'https://finance.yahoo.com/news/rssurl' },
  { name: 'marketwatch',  url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
  { name: 'cnbc',         url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'reuters',      url: 'https://www.rss-bridge.org/bridge01/?action=display&bridge=ReutersBridge&feed=business&format=Atom' },
  { name: 'seekingalpha', url: 'https://seekingalpha.com/market_currents.xml' },
];

async function fetchRSS(feed) {
  try {
    const xml = await httpGet(feed.url);
    const items = parseXmlItems(xml);
    return items.map(item => {
      const text = `${item.title} ${item.description}`;
      return {
        title: item.title || 'Untitled',
        summary: (item.description || '').slice(0, 500),
        url: item.link || '',
        source: feed.name,
        publishedAt: normalizeDate(item.pubDate),
        tickers: extractTickers(text),
        rawSentiment: null,
      };
    }).filter(a => a.url);  // skip articles without URLs
  } catch (err) {
    console.warn(`  [scraper] RSS ${feed.name} failed: ${err.message}`);
    return [];
  }
}

async function fetchAllRSS() {
  const results = await Promise.allSettled(RSS_FEEDS.map(feed => fetchRSS(feed)));
  const articles = [];
  for (const r of results) {
    if (r.status === 'fulfilled') articles.push(...r.value);
  }
  return articles;
}

// ─── Source B: Finnhub API ──────────────────────────────────────────────────────

async function fetchFinnhubGeneral() {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || key === 'your_finnhub_key_here') {
    console.warn('  [scraper] FINNHUB_API_KEY not set — skipping Finnhub');
    return [];
  }

  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${key}`;
    const data = JSON.parse(await httpGet(url));
    if (!Array.isArray(data)) return [];

    return data.map(item => {
      const text = `${item.headline || ''} ${item.summary || ''}`;
      return {
        title: item.headline || 'Untitled',
        summary: (item.summary || '').slice(0, 500),
        url: item.url || '',
        source: 'finnhub',
        publishedAt: item.datetime ? new Date(item.datetime * 1000).toISOString() : new Date().toISOString(),
        tickers: extractTickers(text),
        rawSentiment: null,
      };
    }).filter(a => a.url);
  } catch (err) {
    console.warn(`  [scraper] Finnhub general failed: ${err.message}`);
    return [];
  }
}

async function fetchFinnhubCompany(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || key === 'your_finnhub_key_here') return [];

  try {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${weekAgo}&to=${today}&token=${key}`;
    const data = JSON.parse(await httpGet(url));
    if (!Array.isArray(data)) return [];

    return data.slice(0, 10).map(item => ({  // limit to 10 per ticker
      title: item.headline || 'Untitled',
      summary: (item.summary || '').slice(0, 500),
      url: item.url || '',
      source: 'finnhub',
      publishedAt: item.datetime ? new Date(item.datetime * 1000).toISOString() : new Date().toISOString(),
      tickers: [ticker, ...extractTickers(`${item.headline || ''} ${item.summary || ''}`)],
      rawSentiment: null,
    })).filter(a => a.url);
  } catch {
    return [];
  }
}

// ─── Source C: Alpha Vantage News Sentiment ────────────────────────────────────

async function fetchAlphaVantageNews(tickers) {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) {
    console.warn('  [scraper] ALPHA_VANTAGE_KEY not set — skipping Alpha Vantage News');
    return [];
  }

  try {
    // Alpha Vantage limits to 50 tickers per call and 5 calls/min on free tier
    const tickerStr = (tickers || []).slice(0, 20).join(',');
    const url = tickerStr
      ? `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${tickerStr}&apikey=${key}`
      : `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&apikey=${key}`;

    const data = JSON.parse(await httpGet(url));
    if (!data.feed || !Array.isArray(data.feed)) return [];

    return data.feed.map(item => {
      // Extract overall sentiment score (-1 to 1)
      const sentimentScore = parseFloat(item.overall_sentiment_score) || null;

      // Extract mentioned tickers
      const mentioned = (item.ticker_sentiment || [])
        .map(ts => ts.ticker)
        .filter(t => TICKER_SET.has(t));

      return {
        title: item.title || 'Untitled',
        summary: (item.summary || '').slice(0, 500),
        url: item.url || '',
        source: 'alphavantage',
        publishedAt: item.time_published
          ? formatAVDate(item.time_published)
          : new Date().toISOString(),
        tickers: mentioned.length > 0 ? mentioned : extractTickers(`${item.title} ${item.summary}`),
        rawSentiment: sentimentScore,
      };
    }).filter(a => a.url);
  } catch (err) {
    console.warn(`  [scraper] Alpha Vantage News failed: ${err.message}`);
    return [];
  }
}

function formatAVDate(avDate) {
  // Alpha Vantage format: "20260408T143000"
  try {
    if (avDate.length >= 15) {
      const y = avDate.slice(0, 4);
      const m = avDate.slice(4, 6);
      const d = avDate.slice(6, 8);
      const h = avDate.slice(9, 11);
      const min = avDate.slice(11, 13);
      const s = avDate.slice(13, 15);
      return new Date(`${y}-${m}-${d}T${h}:${min}:${s}Z`).toISOString();
    }
    return new Date(avDate).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ─── Main export ────────────────────────────────────────────────────────────────

/**
 * Fetch articles from all sources, deduplicate by URL.
 * @param {string[]} [tickerFilter] — optional list of tickers to focus on
 * @returns {Promise<Array>} — normalized articles
 */
async function fetchAllNews(tickerFilter) {
  console.log('[scraper] Fetching news from all sources...');

  // Fire all sources in parallel
  const [rssArticles, finnhubGeneral, avArticles] = await Promise.all([
    fetchAllRSS(),
    fetchFinnhubGeneral(),
    fetchAlphaVantageNews(tickerFilter),
  ]);

  // Optionally fetch Finnhub company-specific news for filtered tickers
  let finnhubCompany = [];
  if (tickerFilter && tickerFilter.length > 0 && tickerFilter.length <= 10) {
    const key = process.env.FINNHUB_API_KEY;
    if (key && key !== 'your_finnhub_key_here') {
      // Rate limit: 60 calls/min — space them out slightly
      const results = [];
      for (const ticker of tickerFilter.slice(0, 10)) {
        results.push(await fetchFinnhubCompany(ticker));
        await new Promise(r => setTimeout(r, 200));  // ~5 req/sec
      }
      finnhubCompany = results.flat();
    }
  }

  // Combine all
  const all = [...rssArticles, ...finnhubGeneral, ...finnhubCompany, ...avArticles];

  // Dedupe by URL
  const seen = new Set();
  const deduped = [];
  for (const article of all) {
    const normalizedUrl = article.url.replace(/\/$/, '').toLowerCase();
    if (!seen.has(normalizedUrl)) {
      seen.add(normalizedUrl);
      // Dedupe tickers within article
      article.tickers = [...new Set(article.tickers)];
      deduped.push(article);
    }
  }

  // Apply ticker filter if provided
  let filtered = deduped;
  if (tickerFilter && tickerFilter.length > 0) {
    const filterSet = new Set(tickerFilter);
    filtered = deduped.filter(a =>
      a.tickers.some(t => filterSet.has(t)) || a.tickers.length === 0
    );
  }

  // Sort by date (newest first)
  filtered.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Log stats
  const bySource = {};
  for (const a of filtered) {
    bySource[a.source] = (bySource[a.source] || 0) + 1;
  }
  console.log(`[scraper] Fetched ${filtered.length} articles (deduped from ${all.length}):`);
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`  ${src}: ${count}`);
  }

  return filtered;
}

module.exports = { fetchAllNews, extractTickers };
