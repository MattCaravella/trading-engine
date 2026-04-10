const { UNIVERSE } = require('../data/universe');

/**
 * SEC 8-K filing monitor.
 * Parses EDGAR full-text search for recent 8-K filings, matches against UNIVERSE,
 * and filters for positive catalysts.
 */

const POSITIVE_KEYWORDS = ['agreement', 'approval', 'partnership', 'acquisition',
  'merger', 'contract', 'license', 'collaboration', 'joint venture', 'fda approval',
  'material definitive agreement', 'strategic alliance'];

const CATALYST_BONUS = {
  'acquisition': 15, 'merger': 15, 'fda approval': 20, 'approval': 15,
  'material definitive agreement': 10, 'partnership': 10, 'strategic alliance': 10,
  'collaboration': 8, 'joint venture': 8, 'contract': 8, 'license': 8, 'agreement': 5,
};

async function getSignals() {
  const signals = [];

  try {
    const today = new Date().toISOString().slice(0, 10);
    // EDGAR EFTS search API — returns Elasticsearch-format results with _source objects
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22material+definitive+agreement%22+OR+%22approval%22+OR+%22partnership%22+OR+%22acquisition%22&forms=8-K&dateRange=custom&startdt=${today}&enddt=${today}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'TradingBot/1.0 contact@example.com', 'Accept': 'application/json' },
    });

    if (!res.ok) {
      // Fallback: try the EDGAR full-text search endpoint
      const fallbackUrl = `https://efts.sec.gov/LATEST/search-index?q=*&forms=8-K&dateRange=custom&startdt=${today}&enddt=${today}`;
      const fallbackRes = await fetch(fallbackUrl, {
        headers: { 'User-Agent': 'TradingBot/1.0 contact@example.com', 'Accept': 'application/json' },
      });
      if (!fallbackRes.ok) {
        console.log(`  [sec_8k] EDGAR API error: ${res.status}`);
        return [];
      }
    }

    let data;
    try {
      data = await res.json();
    } catch {
      // EDGAR may return non-JSON; try parsing as text
      console.log('  [sec_8k] non-JSON response from EDGAR');
      return [];
    }

    // EDGAR returns nested: { hits: { total: {...}, hits: [...] } }
    const rawHits = data?.hits?.hits || data?.hits || data?.filings || data?.results || [];
    const hits = Array.isArray(rawHits) ? rawHits : [];
    if (hits.length === 0) {
      console.log('  [sec_8k] no 8-K filings found today');
      return [];
    }

    console.log(`  [sec_8k] processing ${hits.length} 8-K filings...`);

    // Build lookup: company name words -> ticker for matching
    const universeSet = new Set(UNIVERSE);

    for (const rawFiling of hits) {
      // EDGAR EFTS wraps each hit in _source
      const filing = rawFiling._source || rawFiling;
      const companyName = (filing.display_names?.[0] || filing.company_name || filing.entity_name || '').toUpperCase();
      const title       = (filing.file_description || filing.title || '').toLowerCase();
      const content     = (title + ' ' + companyName).toLowerCase();

      // Try to extract ticker from filing data — EDGAR uses CIK, not tickers
      let ticker = (filing.ticker || filing.tickers?.[0] || '').toUpperCase().trim();

      // If no ticker field, try matching company name against universe
      if (!ticker || !universeSet.has(ticker)) {
        // Naive match: check if any universe ticker appears in company name
        for (const t of UNIVERSE) {
          if (companyName.includes(` ${t} `) || companyName.includes(`${t},`) ||
              companyName.startsWith(`${t} `) || companyName === t) {
            ticker = t;
            break;
          }
        }
      }

      if (!ticker || !universeSet.has(ticker)) continue;

      // Check for positive catalyst keywords
      let bestCatalyst = null;
      let bestBonus    = 0;
      for (const kw of POSITIVE_KEYWORDS) {
        if (content.includes(kw) || title.includes(kw)) {
          const bonus = CATALYST_BONUS[kw] || 5;
          if (bonus > bestBonus) {
            bestBonus    = bonus;
            bestCatalyst = kw;
          }
        }
      }

      if (!bestCatalyst) continue; // No positive catalyst found

      const score = Math.min(60, 30 + bestBonus);

      signals.push({
        ticker,
        direction: 'bullish',
        score,
        reason: `SEC 8-K: "${bestCatalyst}" filing for ${companyName}`,
        source: 'sec_8k',
      });
    }
  } catch (err) {
    console.log(`  [sec_8k] error: ${err.message}`);
    return [];
  }

  console.log(`  [sec_8k] ${signals.length} signal(s)`);
  return signals;
}

module.exports = { getSignals };
