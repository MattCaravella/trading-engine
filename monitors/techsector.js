/**
 * Tech Sector Monitor — Alpha Vantage
 *
 * Uses 2 API calls per day (well within 25/day free tier):
 *   1. SECTOR         — IT sector 1-day & 5-day performance
 *   2. (shared cache) — same result reused all day
 *
 * Logic:
 *   IT sector 1D >+0.5%  → bullish boost on all tech universe tickers
 *   IT sector 1D <-1.0%  → bearish signal, engine will down-score tech
 *   IT sector 1D neutral  → no adjustment
 */

const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [k,...v]=line.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim();
});

const AV_KEY = process.env.ALPHA_VANTAGE_KEY;
const AV_BASE = 'https://www.alphavantage.co/query';

// Tech & growth universe — pulled from shared universe
const { UNIVERSE } = require('../data/universe');
const TECH_SECTORS = new Set(['AAPL','MSFT','NVDA','META','GOOGL','GOOG','AMZN','TSLA','AVGO','ORCL',
  'AMD','QCOM','TXN','INTC','AMAT','MU','LRCX','KLAC','NOW','CRM','SNOW','PLTR','UBER',
  'NET','PANW','CRWD','ZS','ADBE','INTU','IBM','HPE','CSCO','DELL','ANET','MRVL','SMCI',
  'WDAY','DDOG','GTLB','TTD','HUBS','OKTA','MNDY','CFLT','MDB','ESTC','TEAM','AI','PATH',
  'COIN','HOOD','SOFI','UPST','AFRM']);
const TECH_UNIVERSE = UNIVERSE.filter(t => TECH_SECTORS.has(t));

// Cache so we only hit AV once per day
let _cache = { data: null, date: null };

async function fetchSectorPerformance() {
  const today = new Date().toISOString().slice(0, 10);
  if (_cache.date === today && _cache.data) return _cache.data;

  const url = `${AV_BASE}?function=SECTOR&apikey=${AV_KEY}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();

  if (json['Note'] || json['Information']) {
    console.warn('[techsector] Alpha Vantage rate limit hit:', json['Note'] || json['Information']);
    return _cache.data || null;
  }

  _cache = { data: json, date: today };
  return json;
}

function parsePct(str) {
  if (!str) return null;
  return parseFloat(str.replace('%', ''));
}

async function getSignals() {
  const data = await fetchSectorPerformance();
  if (!data) return [];

  const rank1d = data['Rank B: 1 Day Performance']   || {};
  const rank5d = data['Rank C: 5 Day Performance']   || {};
  const rank1m = data['Rank D: 1 Month Performance'] || {};

  const it1d = parsePct(rank1d['Information Technology']);
  const it5d = parsePct(rank5d['Information Technology']);
  const it1m = parsePct(rank1m['Information Technology']);

  if (it1d === null) return [];

  // Compare IT vs overall market (using S&P proxy via Financials + Industrials avg)
  const allSectors1d = Object.values(rank1d).map(v => parsePct(v)).filter(v => v !== null);
  const marketAvg1d  = allSectors1d.length ? allSectors1d.reduce((a,b)=>a+b,0)/allSectors1d.length : 0;
  const relative1d   = it1d - marketAvg1d;

  console.log(`  [techsector] IT sector: 1D=${it1d>0?'+':''}${it1d?.toFixed(2)}%  5D=${it5d>0?'+':''}${it5d?.toFixed(2)}%  vs market: ${relative1d>0?'+':''}${relative1d.toFixed(2)}%`);

  const signals = [];

  // Strong tech tailwind — add bullish signals to whole universe
  if (it1d >= 0.5 || relative1d >= 0.75) {
    const score     = Math.min(40, Math.round(10 + Math.abs(it1d) * 8 + Math.abs(relative1d) * 5));
    const momentum  = it5d >= 1.0 ? ' + 5D momentum strong' : '';
    const reason    = `IT sector +${it1d.toFixed(2)}% (${relative1d>=0?'+':''}${relative1d.toFixed(2)}% vs market)${momentum}`;

    for (const ticker of TECH_UNIVERSE) {
      signals.push({ ticker, direction: 'bullish', score, reason });
    }
    return signals;
  }

  // Tech headwind — add bearish signals to tone down buying
  if (it1d <= -1.0 || relative1d <= -1.0) {
    const score  = Math.min(35, Math.round(10 + Math.abs(it1d) * 5));
    const reason = `IT sector ${it1d.toFixed(2)}% (${relative1d.toFixed(2)}% vs market) — tech headwind`;

    for (const ticker of TECH_UNIVERSE) {
      signals.push({ ticker, direction: 'bearish', score, reason });
    }
    return signals;
  }

  // Neutral — no adjustment
  return [];
}

module.exports = { getSignals };
