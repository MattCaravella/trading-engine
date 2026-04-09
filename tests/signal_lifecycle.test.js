/**
 * Tests for signal_lifecycle.js — State machine tests
 *
 * Tests the SignalTracker class: register, confirm, reject,
 * approve, execute, getCycleSummary, reset.
 * Mocks fs to prevent file writes during tests.
 */

// Mock fs to prevent JSONL writes and .env reads
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn((filePath, ...args) => {
      if (typeof filePath === 'string' && filePath.includes('.env')) {
        return 'ALPACA_API_KEY=test\nALPACA_SECRET_KEY=test\n';
      }
      return actual.readFileSync(filePath, ...args);
    }),
    appendFileSync: jest.fn(),
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
  };
});

const { SignalTracker, REJECTION_STATES } = require('../signal_lifecycle');

// ─── SignalTracker ──────────────────────────────────────────────────────────

describe('SignalTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new SignalTracker();
  });

  // ─── register() ─────────────────────────────────────────────────────────

  test('register() creates GENERATED signal', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test reason');
    expect(id).toBeTruthy();
    expect(id).toContain('AAPL');
    expect(id).toContain('bollinger');

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('GENERATED');
    expect(sig.ticker).toBe('AAPL');
    expect(sig.source).toBe('bollinger');
    expect(sig.score).toBe(75);
    expect(sig.direction).toBe('bullish');
    expect(sig.reason).toBe('Test reason');
    expect(sig.transitions).toHaveLength(1);
    expect(sig.transitions[0].to).toBe('GENERATED');
  });

  // ─── confirm() ──────────────────────────────────────────────────────────

  test('confirm() transitions GENERATED -> CONFIRMED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    const result = tracker.confirm(id);
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('CONFIRMED');
    expect(sig.transitions).toHaveLength(2);
    expect(sig.transitions[1].from).toBe('GENERATED');
    expect(sig.transitions[1].to).toBe('CONFIRMED');
  });

  // ─── approve() ──────────────────────────────────────────────────────────

  test('approve() transitions CONFIRMED -> APPROVED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    tracker.confirm(id);
    const result = tracker.approve(id);
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('APPROVED');
    expect(sig.transitions).toHaveLength(3);
  });

  // ─── execute() ──────────────────────────────────────────────────────────

  test('execute() transitions APPROVED -> EXECUTED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    tracker.confirm(id);
    tracker.approve(id);
    const result = tracker.execute(id, 'order-123');
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('EXECUTED');
    expect(sig.transitions).toHaveLength(4);
    expect(sig.transitions[3].reason).toContain('order-123');
  });

  // ─── reject() ───────────────────────────────────────────────────────────

  test('reject() with REJECTED_STALE from GENERATED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    const result = tracker.reject(id, 'REJECTED_STALE', 'Signal too old');
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('REJECTED_STALE');
  });

  test('reject() with REJECTED_DUPLICATE from GENERATED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    const result = tracker.reject(id, 'REJECTED_DUPLICATE', 'Already exists');
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('REJECTED_DUPLICATE');
  });

  test('reject() with REJECTED_RISK from CONFIRMED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    tracker.confirm(id);
    const result = tracker.reject(id, 'REJECTED_RISK', 'Too risky');
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('REJECTED_RISK');
  });

  test('reject() with REJECTED_GOVERNOR from CONFIRMED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    tracker.confirm(id);
    const result = tracker.reject(id, 'REJECTED_GOVERNOR', 'Governor blocked');
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('REJECTED_GOVERNOR');
  });

  test('reject() with REJECTED_EARNINGS from CONFIRMED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    tracker.confirm(id);
    const result = tracker.reject(id, 'REJECTED_EARNINGS', 'Earnings soon');
    expect(result).toBe(true);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('REJECTED_EARNINGS');
  });

  // ─── Invalid transitions ────────────────────────────────────────────────

  test('invalid transitions return false', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    // Can't go directly from GENERATED to APPROVED
    const result = tracker.approve(id);
    expect(result).toBe(false);

    const sig = tracker.signals.get(id);
    expect(sig.state).toBe('GENERATED'); // state unchanged
  });

  test('cannot execute from GENERATED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    const result = tracker.execute(id, 'order-123');
    expect(result).toBe(false);
  });

  test('cannot confirm from CONFIRMED', () => {
    const id = tracker.register('AAPL', 'bollinger', 75, 'bullish', 'Test');
    tracker.confirm(id);
    // Can't confirm again
    const result = tracker.confirm(id);
    expect(result).toBe(false);
  });

  test('transition on nonexistent signal returns false', () => {
    const result = tracker.confirm('nonexistent_id');
    expect(result).toBe(false);
  });

  // ─── getCycleSummary() ──────────────────────────────────────────────────

  test('getCycleSummary() returns correct counts', () => {
    // Register 4 signals
    const id1 = tracker.register('AAPL', 'bollinger', 80, 'bullish', 'Test');
    const id2 = tracker.register('MSFT', 'ma_crossover', 70, 'bullish', 'Test');
    const id3 = tracker.register('GOOGL', 'bollinger', 60, 'bullish', 'Test');
    const id4 = tracker.register('META', 'bollinger', 50, 'bullish', 'Test');

    // id1: full lifecycle → EXECUTED
    tracker.confirm(id1);
    tracker.approve(id1);
    tracker.execute(id1, 'order-1');

    // id2: confirmed → APPROVED (not executed yet)
    tracker.confirm(id2);
    tracker.approve(id2);

    // id3: rejected as stale
    tracker.reject(id3, 'REJECTED_STALE', 'Too old');

    // id4: confirmed then rejected by governor
    tracker.confirm(id4);
    tracker.reject(id4, 'REJECTED_GOVERNOR', 'Blocked');

    const summary = tracker.getCycleSummary();
    expect(summary.total).toBe(4);
    expect(summary.executed).toBe(1);
    // confirmed includes CONFIRMED, APPROVED, and EXECUTED states
    expect(summary.confirmed).toBe(2); // id1(EXECUTED) + id2(APPROVED); id4 state is REJECTED_GOVERNOR so not counted
    expect(summary.rejected).toBe(2); // id3 + id4
  });

  test('getCycleSummary() with empty tracker', () => {
    const summary = tracker.getCycleSummary();
    expect(summary.total).toBe(0);
    expect(summary.executed).toBe(0);
    expect(summary.confirmed).toBe(0);
    expect(summary.rejected).toBe(0);
  });

  // ─── Rejection counters ─────────────────────────────────────────────────

  test('rejection counters increment correctly', () => {
    const id1 = tracker.register('AAPL', 'bollinger', 80, 'bullish', 'Test');
    const id2 = tracker.register('MSFT', 'bollinger', 70, 'bullish', 'Test');
    const id3 = tracker.register('GOOGL', 'bollinger', 60, 'bullish', 'Test');

    tracker.reject(id1, 'REJECTED_STALE', 'Old');
    tracker.reject(id2, 'REJECTED_STALE', 'Old too');
    tracker.reject(id3, 'REJECTED_DUPLICATE', 'Dupe');

    const summary = tracker.getCycleSummary();
    expect(summary.rejections.stale).toBe(2);
    expect(summary.rejections.duplicate).toBe(1);
    expect(summary.rejections.risk).toBe(0);
    expect(summary.rejections.governor).toBe(0);
  });

  // ─── reset() ────────────────────────────────────────────────────────────

  test('reset() clears all signals', () => {
    tracker.register('AAPL', 'bollinger', 80, 'bullish', 'Test');
    tracker.register('MSFT', 'ma_crossover', 70, 'bullish', 'Test');

    expect(tracker.signals.size).toBe(2);

    tracker.reset();

    expect(tracker.signals.size).toBe(0);
    expect(tracker.cycleRejections.stale).toBe(0);
    expect(tracker.cycleRejections.duplicate).toBe(0);
    expect(tracker.cycleRejections.risk).toBe(0);
    expect(tracker.cycleRejections.governor).toBe(0);
    expect(tracker.cycleRejections.earnings).toBe(0);
    expect(tracker.cycleRejections.unconfirmed).toBe(0);
  });

  test('reset() clears rejection counters', () => {
    const id = tracker.register('AAPL', 'bollinger', 80, 'bullish', 'Test');
    tracker.reject(id, 'REJECTED_STALE', 'Old');

    expect(tracker.cycleRejections.stale).toBe(1);

    tracker.reset();

    expect(tracker.cycleRejections.stale).toBe(0);
  });
});

// ─── REJECTION_STATES set ───────────────────────────────────────────────────

describe('REJECTION_STATES', () => {
  test('contains all expected rejection states', () => {
    expect(REJECTION_STATES.has('REJECTED_STALE')).toBe(true);
    expect(REJECTION_STATES.has('REJECTED_DUPLICATE')).toBe(true);
    expect(REJECTION_STATES.has('REJECTED_RISK')).toBe(true);
    expect(REJECTION_STATES.has('REJECTED_GOVERNOR')).toBe(true);
    expect(REJECTION_STATES.has('REJECTED_EARNINGS')).toBe(true);
    expect(REJECTION_STATES.has('REJECTED_UNCONFIRMED')).toBe(true);
    expect(REJECTION_STATES.has('REJECTED_FILL')).toBe(true);
  });

  test('does not contain non-rejection states', () => {
    expect(REJECTION_STATES.has('GENERATED')).toBe(false);
    expect(REJECTION_STATES.has('CONFIRMED')).toBe(false);
    expect(REJECTION_STATES.has('APPROVED')).toBe(false);
    expect(REJECTION_STATES.has('EXECUTED')).toBe(false);
  });
});
