const { getBars, closes, rsi, sma } = require('../data/prices');

const UNIVERSE = ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','JPM','BAC','AMD','INTC','QCOM','MU','CSCO','ADBE','CRM','ORCL','IBM','XOM','CVX','COP','PFE','JNJ','MRK','UNH','LLY','ABBV','BA','CAT','GE','MMM','WMT','TGT','COST','HD','LOW','PLTR','COIN','SOFI','RIVN','PLUG','F','GM'];

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
      const rsiVal = rsi(cls,14);
      if (rsiVal===null||rsiVal>35) return;
      const days = countDowntrendDays(cls);
      if (days < 15) return;
      const div  = hasBullishDivergence(cls);
      let score  = Math.min(50,20+days);
      if (div) score = Math.min(80,score+25);
      signals.push({ ticker, direction:'bullish', score, reason:`Downtrend reversal: ${days}d downtrend, RSI=${rsiVal.toFixed(0)}${div?', RSI divergence':''}`, source:'downtrend' });
    } catch {}
  }));
  return signals;
}

module.exports = { getSignals };
