/**
 * AI Summarizer — Uses Claude (Haiku) to analyze news articles
 *
 * Analyzes article sentiment, extracts tickers, sectors, urgency,
 * and market impact assessment. Implements rate limiting and caching.
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

const Anthropic = require('@anthropic-ai/sdk');
const { getCache, setCache } = require('./cache');

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_key_here' || key.trim() === '') {
    return null;
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// ─── Keyword-based sentiment analyzer (no API needed) ───────────────────────
const BULLISH_WORDS = [
  'beat','beats','exceeds','exceeded','surpass','surpassed','record','upgrade','upgraded',
  'outperform','strong','surge','surged','soar','soared','rally','rallied','gain','gains',
  'profit','profitable','growth','growing','boom','booming','bullish','positive','optimistic',
  'buy','overweight','raises','raised','dividend','buyback','repurchase','expansion','deal',
  'breakthrough','innovation','approval','approved','partnership','acquire','acquisition',
  'upside','recovery','rebound','momentum','breakout','beat expectations','tops estimates',
  'all-time high','new high','accelerat','strong demand','revenue growth','margin expansion',
];
const BEARISH_WORDS = [
  'miss','misses','missed','below','disappoints','disappointed','downgrade','downgraded',
  'underperform','weak','decline','declined','drop','dropped','fall','fell','plunge','plunged',
  'crash','crashed','loss','losses','bearish','negative','pessimistic','sell','underweight',
  'cuts','cut','layoff','layoffs','recession','slowdown','warning','warns','risk','crisis',
  'lawsuit','investigation','probe','fraud','scandal','bankruptcy','default','inflation',
  'tariff','sanctions','shutdown','closure','recall','shortfall','headwind','overvalued',
  'downside','concern','fears','slump','contraction','miss estimates','below expectations',
];
const URGENCY_WORDS = ['breaking','urgent','alert','just in','flash','developing','live','now'];
const SECTOR_KEYWORDS = {
  Tech:['tech','software','chip','semiconductor','AI','cloud','data','cyber','SaaS','computing'],
  Health:['health','pharma','drug','FDA','biotech','medical','hospital','vaccine','clinical'],
  Energy:['oil','gas','energy','solar','wind','renewable','crude','pipeline','drilling','OPEC'],
  Fin:['bank','financ','interest rate','fed','lending','insurance','credit','mortgage','fintech'],
  Consumer:['retail','consumer','e-commerce','restaurant','apparel','luxury','grocery','brand'],
  Indust:['industrial','manufactur','aerospace','defense','transport','logistics','construction'],
  Materials:['mining','metal','steel','copper','gold','chemical','materials','lithium'],
  REIT:['real estate','REIT','property','housing','rent','commercial property'],
  Util:['utility','utilities','electric','power','grid','water','natural gas'],
  Comms:['media','stream','telecom','broadcast','advertis','social media','entertainment'],
};

function keywordAnalyze(article) {
  const text = `${article.title || ''} ${article.summary || ''}`.toLowerCase();
  let bullScore = 0, bearScore = 0;

  for (const w of BULLISH_WORDS) if (text.includes(w)) bullScore++;
  for (const w of BEARISH_WORDS) if (text.includes(w)) bearScore++;

  const sentiment = bullScore > bearScore + 1 ? 'bullish'
                  : bearScore > bullScore + 1 ? 'bearish'
                  : 'neutral';

  const totalHits = bullScore + bearScore;
  const confidence = totalHits >= 5 ? 'high' : totalHits >= 2 ? 'medium' : 'low';

  let urgency = 'low';
  for (const w of URGENCY_WORDS) if (text.includes(w)) { urgency = 'high'; break; }
  if (urgency === 'low') {
    const age = Date.now() - new Date(article.publishedAt).getTime();
    if (age < 2 * 3600000) urgency = 'high';       // < 2 hours old
    else if (age < 8 * 3600000) urgency = 'medium'; // < 8 hours old
  }

  const sectors = [];
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) if (text.includes(kw)) { sectors.push(sector); break; }
  }

  return {
    sentiment,
    confidence,
    tickers: article.tickers || [],
    sectors,
    urgency,
    summary: (article.title || '').slice(0, 100),
    marketImpact: `Keyword analysis: ${bullScore} bullish, ${bearScore} bearish signals`,
  };
}

const ANALYSIS_PROMPT = `You are a financial news analyst. Analyze the following news article and return a JSON object with your assessment.

Article Title: {{TITLE}}
Article Summary: {{SUMMARY}}
Source: {{SOURCE}}

Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "confidence": "high" | "medium" | "low",
  "tickers": ["AAPL", "NVDA"],
  "sectors": ["Tech", "Energy"],
  "urgency": "high" | "medium" | "low",
  "summary": "One-sentence summary of market relevance",
  "marketImpact": "Brief description of potential market impact"
}

Rules:
- "sentiment" reflects the article's implications for the mentioned stocks
- "confidence" reflects how clear the signal is (earnings beat = high, vague rumor = low)
- "tickers" should be valid US stock ticker symbols mentioned or implied
- "sectors" should be broad categories (Tech, Healthcare, Energy, Finance, Consumer, Industrial, Materials, Real Estate, Utilities, Communications)
- "urgency" reflects time sensitivity (breaking news = high, opinion piece = low)
- Keep "summary" under 100 characters
- Keep "marketImpact" under 200 characters`;

/**
 * Analyze a single article using Claude Haiku
 * @param {Object} article — normalized article from scraper
 * @returns {Object|null} — analysis result or null on failure
 */
async function summarizeArticle(article) {
  // Check cache first
  const cached = getCache(article.url);
  if (cached && cached.analysis) {
    return cached.analysis;
  }

  const client = getClient();
  if (!client) {
    // No Claude API key — use keyword-based analysis + Alpha Vantage rawSentiment
    let analysis;
    if (article.rawSentiment !== null && article.rawSentiment !== undefined) {
      // Alpha Vantage provides sentiment scores — use them with keyword enrichment
      const kw = keywordAnalyze(article);
      analysis = {
        sentiment: article.rawSentiment > 0.15 ? 'bullish' : article.rawSentiment < -0.15 ? 'bearish' : kw.sentiment,
        confidence: Math.abs(article.rawSentiment) > 0.3 ? 'high' : Math.abs(article.rawSentiment) > 0.15 ? 'medium' : kw.confidence,
        tickers: article.tickers || [],
        sectors: kw.sectors,
        urgency: kw.urgency,
        summary: (article.title || '').slice(0, 100),
        marketImpact: `Alpha Vantage sentiment=${article.rawSentiment.toFixed(2)}, keywords: ${kw.marketImpact}`,
      };
    } else {
      // RSS articles — pure keyword analysis
      analysis = keywordAnalyze(article);
    }
    setCache(article.url, article, analysis);
    return analysis;
  }

  try {
    const prompt = ANALYSIS_PROMPT
      .replace('{{TITLE}}', article.title || '')
      .replace('{{SUMMARY}}', article.summary || '')
      .replace('{{SOURCE}}', article.source || '');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';

    // Parse JSON from response — handle potential markdown wrapping
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const analysis = JSON.parse(jsonStr);

    // Validate required fields
    if (!analysis.sentiment || !analysis.confidence || !analysis.urgency) {
      throw new Error('Missing required fields in AI response');
    }

    // Normalize sentiment values
    const validSentiments = ['bullish', 'bearish', 'neutral'];
    if (!validSentiments.includes(analysis.sentiment)) {
      analysis.sentiment = 'neutral';
    }

    // Ensure tickers is an array
    if (!Array.isArray(analysis.tickers)) {
      analysis.tickers = article.tickers || [];
    }
    if (!Array.isArray(analysis.sectors)) {
      analysis.sectors = [];
    }

    // Cache the result
    setCache(article.url, article, analysis);

    return analysis;
  } catch (err) {
    console.warn(`  [summarizer] Failed to analyze "${article.title?.slice(0, 50)}": ${err.message}`);
    return null;
  }
}

/**
 * Process multiple articles with concurrency limiting
 * @param {Array} articles — array of normalized articles
 * @param {number} maxConcurrent — max parallel API calls (default 5)
 * @returns {Array} — articles enriched with .analysis property
 */
async function batchSummarize(articles, maxConcurrent = 5) {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;  // 48 hours ago

  // Filter out old articles
  const recent = articles.filter(a => {
    const pubTime = new Date(a.publishedAt).getTime();
    return pubTime > cutoff;
  });

  console.log(`[summarizer] Analyzing ${recent.length} articles (skipped ${articles.length - recent.length} older than 48h)`);

  const enriched = [];
  const queue = [...recent];
  const inFlight = new Set();
  let completed = 0;

  return new Promise((resolve) => {
    function processNext() {
      while (inFlight.size < maxConcurrent && queue.length > 0) {
        const article = queue.shift();
        const promise = summarizeArticle(article)
          .then(analysis => {
            article.analysis = analysis;
            enriched.push(article);
          })
          .catch(() => {
            article.analysis = null;
            enriched.push(article);
          })
          .finally(() => {
            inFlight.delete(promise);
            completed++;
            if (completed % 10 === 0) {
              console.log(`  [summarizer] Progress: ${completed}/${recent.length}`);
            }
            processNext();
          });
        inFlight.add(promise);
      }

      if (inFlight.size === 0 && queue.length === 0) {
        console.log(`[summarizer] Completed: ${enriched.length} articles analyzed`);
        resolve(enriched);
      }
    }

    processNext();
  });
}

module.exports = { summarizeArticle, batchSummarize };
