function getET() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getETComponents() {
  const et   = getET();
  const day  = et.getDay();
  const hour = et.getHours();
  const min  = et.getMinutes();
  const mins = hour * 60 + min;
  return { day, hour, min, mins, et };
}

const TIMES = {
  PRE_MARKET_START: 8  * 60,
  MARKET_OPEN:      9  * 60 + 30,
  MARKET_CLOSE:     16 * 60,
  AFTER_HOURS_END:  17 * 60,
};

// ─── US Market Holidays (NYSE/NASDAQ closed) ────────────────────────────────
// Format: 'YYYY-MM-DD'
const MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Presidents' Day
  '2027-04-16', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-07-05', // Independence Day (observed)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving Day
  '2027-12-24', // Christmas Day (observed)
]);

function isMarketHoliday() {
  const et = getET();
  const year  = et.getFullYear();
  const month = String(et.getMonth() + 1).padStart(2, '0');
  const day   = String(et.getDate()).padStart(2, '0');
  return MARKET_HOLIDAYS.has(`${year}-${month}-${day}`);
}

function isWeekend()     { const { day } = getETComponents(); return day === 0 || day === 6; }
function isWeekday()     { return !isWeekend() && !isMarketHoliday(); }
function isPreMarket()   { const { mins } = getETComponents(); return isWeekday() && mins >= TIMES.PRE_MARKET_START && mins < TIMES.MARKET_OPEN; }
function isMarketHours() { const { mins } = getETComponents(); return isWeekday() && mins >= TIMES.MARKET_OPEN && mins < TIMES.MARKET_CLOSE; }
function isAfterHours()  { const { mins } = getETComponents(); return isWeekday() && mins >= TIMES.MARKET_CLOSE && mins < TIMES.AFTER_HOURS_END; }
function isTradingDay()  { return isWeekday(); }

function timeLabel() {
  if (isMarketHoliday()) return 'HOLIDAY';
  if (isPreMarket())   return 'PRE-MARKET';
  if (isMarketHours()) return 'MARKET';
  if (isAfterHours())  return 'AFTER-HOURS';
  if (isWeekend())     return 'WEEKEND';
  return 'CLOSED';
}

function etTimeString() {
  return getET().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
}

module.exports = { getET, getETComponents, isWeekend, isWeekday, isPreMarket, isMarketHours, isAfterHours, isTradingDay, isMarketHoliday, timeLabel, etTimeString, TIMES };
