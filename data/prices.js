const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const DATA_BASE = 'https://data.alpaca.markets/v2';
const HEADERS   = { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
const cache     = new Map();
const CACHE_TTL = 15 * 60 * 1000;

async function getBars(symbol, days = 200) {
  const key    = `${symbol}:${days}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const start  = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
  const res    = await fetch(`${DATA_BASE}/stocks/${symbol}/bars?timeframe=1Day&start=${start}&limit=${days}&feed=iex`, { headers: HEADERS });
  const json   = await res.json();
  if (!json.bars) throw new Error(`No bars for ${symbol}`);
  const bars   = json.bars.map(b => ({ t:b.t, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v }));
  cache.set(key, { ts: Date.now(), data: bars });
  return bars;
}

function closes(bars)  { return bars.map(b => b.c); }
function volumes(bars) { return bars.map(b => b.v); }

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a,b) => a+b, 0) / period;
}

function stddev(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  const mean  = slice.reduce((a,b) => a+b, 0) / period;
  return Math.sqrt(slice.reduce((s,v) => s+(v-mean)**2, 0) / period);
}

function rsi(closes, period = 14) {
  if (closes.length < period+1) return null;
  const slice = closes.slice(-(period+1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains/period) / (losses/period || 0.0001);
  return 100 - 100/(1+rs);
}

function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const mid = sma(closes, period);
  const std = stddev(closes, period);
  return { upper: mid + mult*std, mid, lower: mid - mult*std, std };
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((s,v)=>s+v,0)/n, mb = bx.reduce((s,v)=>s+v,0)/n;
  let num=0, da=0, db=0;
  for (let i=0;i<n;i++) { num+=(ax[i]-ma)*(bx[i]-mb); da+=(ax[i]-ma)**2; db+=(bx[i]-mb)**2; }
  return da===0||db===0 ? 0 : num/Math.sqrt(da*db);
}

function returns(closes) {
  const r = [];
  for (let i=1;i<closes.length;i++) r.push((closes[i]-closes[i-1])/closes[i-1]);
  return r;
}

async function getVIX() {
  try {
    const res  = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d', { headers: {'User-Agent':'Mozilla/5.0'} });
    const json = await res.json();
    return parseFloat(json?.chart?.result?.[0]?.meta?.regularMarketPrice) || null;
  } catch { return null; }
}

module.exports = { getBars, closes, volumes, sma, stddev, rsi, bollingerBands, correlation, returns, getVIX };
