/**
 * Centralized Configuration Loader
 *
 * Loads config.json and exports all trading parameters.
 * This is the single source of truth for all thresholds and constants
 * currently hardcoded across engine.js, governor.js, strategies, etc.
 *
 * Usage:
 *   const { load, reload } = require('./config');
 *   const cfg = load();
 *   // cfg.engine.maxPositions, cfg.governor.maxDrawdownPct, etc.
 *
 * Hot-reload (e.g. after editing config.json):
 *   const cfg = reload();
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

let _config = null;

// ─── Schema validation rules ────────────────────────────────────────────────
const RULES = [
  // Engine
  { path: 'engine.maxPositions',    type: 'number', min: 1, max: 100 },
  { path: 'engine.positionPct',     type: 'number', min: 0.01, max: 0.5 },
  { path: 'engine.maxExposure',     type: 'number', min: 0.1, max: 1.0 },
  { path: 'engine.cooldownHours',   type: 'number', min: 0, max: 168 },
  { path: 'engine.buyThreshold',    type: 'number', min: 0, max: 100 },
  // Governor
  { path: 'governor.maxDrawdownPct',    type: 'number', min: 1, max: 50 },
  { path: 'governor.maxSectorPct',      type: 'number', min: 5, max: 100 },
  { path: 'governor.maxDailyTrades',    type: 'number', min: 1, max: 100 },
  { path: 'governor.corrThreshold',     type: 'number', min: 0.1, max: 1.0 },
  { path: 'governor.maxCorrelated',     type: 'number', min: 1, max: 50 },
  // Exit profiles
  { path: 'exits.profiles.mean_reversion.hardStop', type: 'number', min: 1, max: 30 },
  { path: 'exits.profiles.mean_reversion.trail',    type: 'number', min: 1, max: 20 },
  { path: 'exits.profiles.trend.hardStop',           type: 'number', min: 1, max: 30 },
  { path: 'exits.profiles.trend.trail',              type: 'number', min: 1, max: 20 },
  // Monte Carlo
  { path: 'monteCarlo.sims',    type: 'number', min: 100, max: 50000 },
  // Signal cache
  { path: 'signalCache.apiFailureThreshold', type: 'number', min: 0.01, max: 1.0 },
  // Scheduler
  { path: 'scheduler.fastRefreshMs',   type: 'number', min: 60000 },
  { path: 'scheduler.tradeExecMs',     type: 'number', min: 60000 },
];

function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

function validate(config) {
  const errors = [];
  for (const rule of RULES) {
    const val = getNestedValue(config, rule.path);
    if (val === undefined) continue; // optional field
    if (typeof val !== rule.type) {
      errors.push(`${rule.path}: expected ${rule.type}, got ${typeof val}`);
      continue;
    }
    if (rule.min !== undefined && val < rule.min) errors.push(`${rule.path}: ${val} < min ${rule.min}`);
    if (rule.max !== undefined && val > rule.max) errors.push(`${rule.path}: ${val} > max ${rule.max}`);
  }
  if (errors.length > 0) {
    console.error(`[Config] VALIDATION ERRORS:\n  ${errors.join('\n  ')}`);
    throw new Error(`config.json has ${errors.length} validation error(s)`);
  }
}

function load() {
  if (!_config) {
    _config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    validate(_config);
  }
  return _config;
}

function reload() {
  _config = null;
  return load();
}

module.exports = { load, reload, validate };
