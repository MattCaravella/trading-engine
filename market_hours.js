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

function isWeekend()     { const { day } = getETComponents(); return day === 0 || day === 6; }
function isWeekday()     { return !isWeekend(); }
function isPreMarket()   { const { mins } = getETComponents(); return isWeekday() && mins >= TIMES.PRE_MARKET_START && mins < TIMES.MARKET_OPEN; }
function isMarketHours() { const { mins } = getETComponents(); return isWeekday() && mins >= TIMES.MARKET_OPEN && mins < TIMES.MARKET_CLOSE; }
function isAfterHours()  { const { mins } = getETComponents(); return isWeekday() && mins >= TIMES.MARKET_CLOSE && mins < TIMES.AFTER_HOURS_END; }
function isTradingDay()  { return isWeekday(); }

function timeLabel() {
  if (isPreMarket())   return 'PRE-MARKET';
  if (isMarketHours()) return 'MARKET';
  if (isAfterHours())  return 'AFTER-HOURS';
  if (isWeekend())     return 'WEEKEND';
  return 'CLOSED';
}

function etTimeString() {
  return getET().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
}

module.exports = { getET, getETComponents, isWeekend, isWeekday, isPreMarket, isMarketHours, isAfterHours, isTradingDay, timeLabel, etTimeString, TIMES };
