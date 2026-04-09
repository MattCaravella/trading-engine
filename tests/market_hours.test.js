/**
 * Tests for market_hours.js — Time detection tests
 *
 * Tests isWeekend, isWeekday, isPreMarket, isMarketHours,
 * isAfterHours, and timeLabel() by mocking the system date.
 */

const marketHours = require('../market_hours');

// Helper: create a Date for a specific ET time
// Note: market_hours.js uses toLocaleString with 'America/New_York' timezone
// We mock Date to control the time reported by the system
function mockDateForET(year, month, day, hour, minute) {
  // Create a date that, when converted to ET, gives us the desired time
  // We construct the date in ET and convert back to UTC for the mock
  const etDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

  // Use the timezone-aware approach
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  // We need a UTC date that when displayed in ET shows our target time.
  // EDT is UTC-4, EST is UTC-5. For simplicity, use a known EDT date (April = EDT)
  // and calculate the UTC offset.
  // April is EDT (UTC-4), so UTC = ET + 4 hours
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour + 4, minute, 0));
  return utcDate;
}

describe('market_hours', () => {
  let realDate;

  beforeAll(() => {
    realDate = global.Date;
  });

  afterEach(() => {
    global.Date = realDate;
  });

  function setMockDate(mockDate) {
    const OrigDate = realDate;
    global.Date = class extends OrigDate {
      constructor(...args) {
        if (args.length === 0) {
          super(mockDate.getTime());
        } else {
          super(...args);
        }
      }
      static now() { return mockDate.getTime(); }
    };
    // Preserve static methods
    global.Date.UTC = OrigDate.UTC;
    global.Date.parse = OrigDate.parse;
  }

  // ─── Weekend / Weekday ─────────────────────────────────────────────────

  describe('isWeekend / isWeekday', () => {
    test('Saturday is weekend', () => {
      // April 5, 2025 is a Saturday
      setMockDate(mockDateForET(2025, 4, 5, 12, 0));
      expect(marketHours.isWeekend()).toBe(true);
      expect(marketHours.isWeekday()).toBe(false);
    });

    test('Sunday is weekend', () => {
      // April 6, 2025 is a Sunday
      setMockDate(mockDateForET(2025, 4, 6, 12, 0));
      expect(marketHours.isWeekend()).toBe(true);
      expect(marketHours.isWeekday()).toBe(false);
    });

    test('Monday is weekday', () => {
      // April 7, 2025 is a Monday
      setMockDate(mockDateForET(2025, 4, 7, 12, 0));
      expect(marketHours.isWeekend()).toBe(false);
      expect(marketHours.isWeekday()).toBe(true);
    });

    test('Friday is weekday', () => {
      // April 4, 2025 is a Friday
      setMockDate(mockDateForET(2025, 4, 4, 12, 0));
      expect(marketHours.isWeekend()).toBe(false);
      expect(marketHours.isWeekday()).toBe(true);
    });
  });

  // ─── Pre-Market (8:00-9:30 ET) ────────────────────────────────────────

  describe('isPreMarket (8:00-9:30 ET)', () => {
    test('8:00 ET on weekday is pre-market', () => {
      setMockDate(mockDateForET(2025, 4, 7, 8, 0));
      expect(marketHours.isPreMarket()).toBe(true);
    });

    test('9:15 ET on weekday is pre-market', () => {
      setMockDate(mockDateForET(2025, 4, 7, 9, 15));
      expect(marketHours.isPreMarket()).toBe(true);
    });

    test('9:30 ET on weekday is NOT pre-market (market open)', () => {
      setMockDate(mockDateForET(2025, 4, 7, 9, 30));
      expect(marketHours.isPreMarket()).toBe(false);
    });

    test('7:59 ET on weekday is NOT pre-market', () => {
      setMockDate(mockDateForET(2025, 4, 7, 7, 59));
      expect(marketHours.isPreMarket()).toBe(false);
    });
  });

  // ─── Market Hours (9:30-16:00 ET) ─────────────────────────────────────

  describe('isMarketHours (9:30-16:00 ET)', () => {
    test('9:30 ET on weekday is market hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 9, 30));
      expect(marketHours.isMarketHours()).toBe(true);
    });

    test('12:00 ET on weekday is market hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 12, 0));
      expect(marketHours.isMarketHours()).toBe(true);
    });

    test('15:59 ET on weekday is market hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 15, 59));
      expect(marketHours.isMarketHours()).toBe(true);
    });

    test('16:00 ET on weekday is NOT market hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 16, 0));
      expect(marketHours.isMarketHours()).toBe(false);
    });

    test('weekend at market time is NOT market hours', () => {
      setMockDate(mockDateForET(2025, 4, 5, 12, 0)); // Saturday
      expect(marketHours.isMarketHours()).toBe(false);
    });
  });

  // ─── After Hours (16:00-17:00 ET) ─────────────────────────────────────

  describe('isAfterHours (16:00-17:00 ET)', () => {
    test('16:00 ET on weekday is after hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 16, 0));
      expect(marketHours.isAfterHours()).toBe(true);
    });

    test('16:30 ET on weekday is after hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 16, 30));
      expect(marketHours.isAfterHours()).toBe(true);
    });

    test('17:00 ET on weekday is NOT after hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 17, 0));
      expect(marketHours.isAfterHours()).toBe(false);
    });

    test('weekend at after-hours time is NOT after hours', () => {
      setMockDate(mockDateForET(2025, 4, 5, 16, 30)); // Saturday
      expect(marketHours.isAfterHours()).toBe(false);
    });
  });

  // ─── timeLabel() ──────────────────────────────────────────────────────

  describe('timeLabel()', () => {
    test('returns PRE-MARKET during pre-market', () => {
      setMockDate(mockDateForET(2025, 4, 7, 8, 30));
      expect(marketHours.timeLabel()).toBe('PRE-MARKET');
    });

    test('returns MARKET during market hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 10, 0));
      expect(marketHours.timeLabel()).toBe('MARKET');
    });

    test('returns AFTER-HOURS during after hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 16, 30));
      expect(marketHours.timeLabel()).toBe('AFTER-HOURS');
    });

    test('returns WEEKEND on Saturday', () => {
      setMockDate(mockDateForET(2025, 4, 5, 12, 0));
      expect(marketHours.timeLabel()).toBe('WEEKEND');
    });

    test('returns CLOSED on weekday outside all windows', () => {
      setMockDate(mockDateForET(2025, 4, 7, 6, 0));
      expect(marketHours.timeLabel()).toBe('CLOSED');
    });

    test('returns CLOSED on weekday after after-hours', () => {
      setMockDate(mockDateForET(2025, 4, 7, 20, 0));
      expect(marketHours.timeLabel()).toBe('CLOSED');
    });
  });

  // ─── TIMES constants ─────────────────────────────────────────────────

  describe('TIMES constants', () => {
    test('PRE_MARKET_START is 480 (8:00)', () => {
      expect(marketHours.TIMES.PRE_MARKET_START).toBe(480);
    });

    test('MARKET_OPEN is 570 (9:30)', () => {
      expect(marketHours.TIMES.MARKET_OPEN).toBe(570);
    });

    test('MARKET_CLOSE is 960 (16:00)', () => {
      expect(marketHours.TIMES.MARKET_CLOSE).toBe(960);
    });

    test('AFTER_HOURS_END is 1020 (17:00)', () => {
      expect(marketHours.TIMES.AFTER_HOURS_END).toBe(1020);
    });
  });
});
