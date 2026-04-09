/**
 * Article Cache — File-based caching layer for news articles and AI analysis
 *
 * Stores articles + analysis results keyed by URL hash.
 * TTL: 24 hours for re-analysis, 48 hours for auto-prune.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_FILE = path.join(__dirname, 'data', 'article_cache.json');
const TTL_MS     = 24 * 60 * 60 * 1000;  // 24 hours
const PRUNE_MS   = 48 * 60 * 60 * 1000;  // 48 hours

let _cache = null;

function hashUrl(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function loadCache() {
  if (_cache) return _cache;
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(CACHE_FILE)) {
    try {
      _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {
      _cache = {};
    }
  } else {
    _cache = {};
  }
  pruneCache();
  return _cache;
}

function saveCache() {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache || {}, null, 2));
  } catch (err) {
    console.warn('[Cache] Failed to save:', err.message);
  }
}

/**
 * Get a cached entry by article URL
 * Returns { article, analysis, cachedAt } or null if not found / expired
 */
function getCache(url) {
  const cache = loadCache();
  const key = hashUrl(url);
  const entry = cache[key];
  if (!entry) return null;

  const age = Date.now() - new Date(entry.cachedAt).getTime();
  if (age > TTL_MS) return null;  // expired

  return entry;
}

/**
 * Store an article + analysis result in cache
 */
function setCache(url, article, analysis) {
  const cache = loadCache();
  const key = hashUrl(url);
  cache[key] = {
    article,
    analysis,
    cachedAt: new Date().toISOString(),
  };
  _cache = cache;
  saveCache();
}

/**
 * Remove entries older than 48 hours
 */
function pruneCache() {
  if (!_cache) return;
  const now = Date.now();
  let pruned = 0;
  for (const [key, entry] of Object.entries(_cache)) {
    const age = now - new Date(entry.cachedAt).getTime();
    if (age > PRUNE_MS) {
      delete _cache[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    saveCache();
  }
  return pruned;
}

/**
 * Get cache stats
 */
function cacheStats() {
  const cache = loadCache();
  const keys = Object.keys(cache);
  const now = Date.now();
  let fresh = 0, stale = 0;
  for (const entry of Object.values(cache)) {
    const age = now - new Date(entry.cachedAt).getTime();
    if (age <= TTL_MS) fresh++;
    else stale++;
  }
  return { total: keys.length, fresh, stale };
}

module.exports = { getCache, setCache, pruneCache, cacheStats, hashUrl };
