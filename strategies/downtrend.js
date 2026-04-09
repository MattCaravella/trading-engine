const { getBars, closes, rsi, sma, adx } = require('../data/prices');
const { UNIVERSE } = require('../data/universe');

const ADX_MAX = 30; // Allow slightly higher ADX than bollinger — downtrend reversals can happen in moderate trends

function countDowntrendDays(cls) {
  let count = 0;
  for (let i=cls.length-1;i>=20;i--) {
    const ma = cls.slice(i-20,i).reduce((a,b)=>a+b,0)/20;
    if (cls[i] < ma) count++; else break;
  }
  return count;
}

function hasBullishDivergence(cls) {
  if (cls.length < 30) return false;
  const recent = cls.slice(-30);
  const rsiSeries = [];
  for (let i=14;i<=recent.length;i++) rsiSeries.push(rsi(recent.slice(0,i),14));
  if (rsiSeries.length < 10) return false;
  const prices = recent.slice(-20);
  let low1=0,low2=0;
  for (let i=1;i<prices.length-1;i++) {
    if (prices[i]<prices[low1]){low2=low1;low1=i;}
    else if (prices[i]<prices[low2]) low2=i;
  }
  if (low1===low2) return false;
  const [e,l] = low1<low2?[low1,low2]:[low2,low1];
  return prices[l]<prices[e] && rsiSeries[Math.max(0,l-2)]>rsiSeries[Math.max(0,e-2)];
}

async function getSignals() {
  const signals = [];
  await Promise.allSettled(UNIVERSE.map(async ticker => {
    try {
      const bars = await getBars(ticker,100);
      const cls  = closes(bars);
      if (cls.length < 50) return;

      // ADX regime filter — skip extreme trends where reversals fail
      const adxVal = adx(bars, 14);
      if (adxVal !== null && adxVal > ADX_MAX) return;

      const rsiVal = rsi(cls,14);
      if (rsiVal===null||rsiVal>35) return;
      const days = countDowntrendDays(cls);
      if (days < 15) return;
      const div  = hasBullishDivergence(cls);
      let score  = Math.min(50,20+days);
      if (div) score = Math.min(80,score+25);
      // ADX bonus: lower ADX = better mean-reversion environment
      if (adxVal !== null && adxVal < 20) score = Math.min(90, score + 10);
      signals.push({ ticker, direction:'bullish', score, reason:`Downtrend reversal: ${days}d downtrend, RSI=${rsiVal.toFixed(0)}${div?', RSI divergence':''}, ADX=${adxVal?.toFixed(0)||'?'}`, source:'downtrend' });
    } catch {}
  }));
  return signals;
}

module.exports = { getSignals };
