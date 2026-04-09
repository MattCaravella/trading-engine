/**
 * Alerts — Slack webhook + JSONL log file alerting system.
 *
 * Channels:
 *   1. Log file (always active) — writes to trade_history/alerts.jsonl
 *   2. Slack webhook (optional) — rich formatted messages with color coding
 *
 * Usage:
 *   const { criticalAlert, warningAlert, infoAlert } = require('./alerts');
 *   criticalAlert('Drawdown Kill', 'Portfolio drawdown exceeded 8%', { pct: 8.2 });
 */

const fs   = require('fs');
const path = require('path');

// Load .env the same way the rest of the codebase does
const envPath = path.join(__dirname, '.env');
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
} catch {}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || null;
const ALERTS_LOG_FILE   = path.join(__dirname, 'trade_history/alerts.jsonl');

const COLORS = {
  critical: '#ff5252',
  warning:  '#ffca28',
  info:     '#2979ff',
};

const EMOJI = {
  critical: ':rotating_light:',
  warning:  ':warning:',
  info:     ':information_source:',
};

// ─── Log to JSONL (always active) ──────────────────────────────────────────
function logToFile(level, title, message, details) {
  try {
    const dir = path.dirname(ALERTS_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      title,
      message,
      ...(details ? { details } : {}),
    };
    fs.appendFileSync(ALERTS_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[Alerts] Failed to write log: ${err.message}`);
  }
}

// ─── Send to Slack webhook (fire-and-forget, never throws) ─────────────────
async function sendSlack(level, title, message, details) {
  if (!SLACK_WEBHOOK_URL) return;

  const color = COLORS[level] || COLORS.info;
  const emoji = EMOJI[level] || '';

  const payload = {
    attachments: [{
      color,
      fallback: `${level.toUpperCase()}: ${title} — ${message}`,
      pretext: `${emoji} *${level.toUpperCase()}*`,
      title,
      text: message,
      fields: details ? Object.entries(details).map(([k, v]) => ({
        title: k,
        value: String(v),
        short: String(v).length < 30,
      })) : [],
      ts: Math.floor(Date.now() / 1000),
    }],
  };

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Alerts] Slack send failed: ${err.message}`);
  }
}

// ─── Main alert function ───────────────────────────────────────────────────
function alert(level, title, message, details) {
  logToFile(level, title, message, details);
  sendSlack(level, title, message, details).catch(() => {});
  const tag = level === 'critical' ? 'CRITICAL' : level === 'warning' ? 'WARNING' : 'INFO';
  console.log(`[Alert:${tag}] ${title} — ${message}`);
}

function criticalAlert(title, message, details) { alert('critical', title, message, details); }
function warningAlert(title, message, details)  { alert('warning',  title, message, details); }
function infoAlert(title, message, details)     { alert('info',     title, message, details); }

module.exports = { alert, criticalAlert, warningAlert, infoAlert };
