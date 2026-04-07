/**
 * Signal Lifecycle State Machine
 *
 * States: GENERATED → CONFIRMED → APPROVED → EXECUTED
 * Rejection states: REJECTED_STALE, REJECTED_DUPLICATE, REJECTED_RISK,
 *                   REJECTED_GOVERNOR, REJECTED_EARNINGS, REJECTED_UNCONFIRMED
 *
 * Every state transition is logged to signal_transitions.jsonl for full audit trail.
 * Persists per-cycle signal snapshot for postmortem analysis.
 */

const fs   = require('fs');
const path = require('path');

const TRANSITIONS_FILE = path.join(__dirname, 'trade_history/signal_transitions.jsonl');
const CYCLE_LOG_FILE   = path.join(__dirname, 'trade_history/cycle_log.jsonl');

// Valid transitions
const VALID_TRANSITIONS = {
  GENERATED:  ['CONFIRMED', 'REJECTED_STALE', 'REJECTED_DUPLICATE', 'REJECTED_UNCONFIRMED'],
  CONFIRMED:  ['APPROVED', 'REJECTED_RISK', 'REJECTED_GOVERNOR', 'REJECTED_EARNINGS'],
  APPROVED:   ['EXECUTED', 'REJECTED_FILL'],
  EXECUTED:   [], // terminal for lifecycle tracking (postmortem handles ACTIVE→CLOSED)
};

const REJECTION_STATES = new Set([
  'REJECTED_STALE', 'REJECTED_DUPLICATE', 'REJECTED_RISK',
  'REJECTED_GOVERNOR', 'REJECTED_EARNINGS', 'REJECTED_UNCONFIRMED', 'REJECTED_FILL'
]);

class SignalTracker {
  constructor() {
    this.signals = new Map(); // signalId → { state, transitions[], ticker, ... }
    this.cycleRejections = { stale: 0, duplicate: 0, risk: 0, governor: 0, earnings: 0, unconfirmed: 0 };
  }

  // Generate a unique signal ID
  _genId(ticker, source) {
    return `${ticker}_${source}_${Date.now()}`;
  }

  // Register a new signal (GENERATED state)
  register(ticker, source, score, direction, reason) {
    const id = this._genId(ticker, source);
    this.signals.set(id, {
      id, ticker, source, score, direction, reason,
      state: 'GENERATED',
      createdAt: Date.now(),
      transitions: [{ from: null, to: 'GENERATED', at: Date.now(), reason: 'Signal created' }],
    });
    return id;
  }

  // Transition a signal to a new state
  transition(id, newState, reason) {
    const sig = this.signals.get(id);
    if (!sig) return false;

    const validNext = VALID_TRANSITIONS[sig.state] || [];
    if (!validNext.includes(newState)) {
      console.warn(`  [Lifecycle] Invalid transition: ${sig.state} → ${newState} for ${sig.ticker}`);
      return false;
    }

    const entry = {
      from: sig.state,
      to: newState,
      at: Date.now(),
      reason,
    };
    sig.transitions.push(entry);
    sig.state = newState;

    // Track rejections for cycle summary
    if (REJECTION_STATES.has(newState)) {
      const key = newState.replace('REJECTED_', '').toLowerCase();
      if (this.cycleRejections[key] !== undefined) this.cycleRejections[key]++;
    }

    // Append to audit log
    this._logTransition(sig, entry);
    return true;
  }

  // Bulk: mark signal confirmed (has technical backing)
  confirm(id) {
    return this.transition(id, 'CONFIRMED', 'Technical confirmation present');
  }

  reject(id, state, reason) {
    return this.transition(id, state, reason);
  }

  approve(id) {
    return this.transition(id, 'APPROVED', 'Passed all risk gates');
  }

  execute(id, orderId) {
    return this.transition(id, 'EXECUTED', `Order placed: ${orderId}`);
  }

  // Log transition to JSONL file
  _logTransition(sig, entry) {
    const line = JSON.stringify({
      signalId: sig.id,
      ticker: sig.ticker,
      source: sig.source,
      score: sig.score,
      ...entry,
    });
    try {
      const dir = path.dirname(TRANSITIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(TRANSITIONS_FILE, line + '\n');
    } catch {}
  }

  // End-of-cycle summary
  getCycleSummary() {
    const total     = this.signals.size;
    const executed  = [...this.signals.values()].filter(s => s.state === 'EXECUTED').length;
    const confirmed = [...this.signals.values()].filter(s => s.state === 'CONFIRMED' || s.state === 'APPROVED' || s.state === 'EXECUTED').length;
    const rejected  = [...this.signals.values()].filter(s => REJECTION_STATES.has(s.state)).length;

    return {
      total,
      confirmed,
      executed,
      rejected,
      rejections: { ...this.cycleRejections },
    };
  }

  // Log full cycle to JSONL
  logCycle(equity, positionCount) {
    const summary = this.getCycleSummary();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      equity,
      positions: positionCount,
      ...summary,
    });
    try {
      const dir = path.dirname(CYCLE_LOG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(CYCLE_LOG_FILE, line + '\n');
    } catch {}
    return summary;
  }

  // Print cycle rejection histogram
  printRejectionHistogram() {
    const r = this.cycleRejections;
    const total = Object.values(r).reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const parts = Object.entries(r).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`);
    console.log(`  [Lifecycle] Rejections: ${parts.join(', ')}`);
  }

  // Reset for new cycle
  reset() {
    this.signals.clear();
    this.cycleRejections = { stale: 0, duplicate: 0, risk: 0, governor: 0, earnings: 0, unconfirmed: 0 };
  }
}

// Singleton instance
const tracker = new SignalTracker();

module.exports = { tracker, SignalTracker, REJECTION_STATES };
