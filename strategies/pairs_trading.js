const { getBars, closes, returns, correlation } = require('../data/prices');

const PAIRS = [['MSFT','GOOGL'],['AMD','NVDA'],['META','SNAP'],['ORCL','CRM'],['QCOM','AVGO'],['JPM','BAC'],['GS','MS'],['C','WFC'],['XOM','CVX'],['COP','OXY'],['SLB','HAL'],['PFE','MRK'],['JNJ','ABT'],['UNH','CVS'],['WMT','TGT'],['HD','LOW'],['AMZN','COST'],['GM','F'],['TSLA','RIVN']];

function zScore(series) {
  if (series.length < 10) return 0;
  const mean = series.reduce((a,b)=>a+b,0)/series.length;
  const std  = Math.sqrt(series.reduce((s,v)=>s+(v-mean)**2,0)/series.length);
  return std===0 ? 0 : (series[series.length-1]-mean)/std;
}

function spread(a,b) {
  const n = Math.min(a.length,b.length);
  return Array.from({length:n},(_,i)=>Math.log(a[a.length-n+i])-Math.log(b[b.length-n+i]));
}

async function getSignals() {
  const signals = [];
  await Promise.allSettled(PAIRS.map(async ([A,B]) => {
    try {
      const [bA,bB] = await Promise.all([getBars(A,70),getBars(B,70)]);
      const [cA,cB] = [closes(bA),closes(bB)];
      if (cA.length<60||cB.length<60) return;
      const corr = correlation(returns(cA),returns(cB));
      if (corr < 0.70) return;
      const z = zScore(spread(cA,cB));
      if (Math.abs(z) < 2.0) return;
      const score = Math.min(75, Math.round(Math.abs(z)*20));
      const [buy,sell] = z > 2 ? [B,A] : [A,B];
      signals.push({ ticker:buy, direction:'bullish', score, reason:`RelVal ${A}/${B} z=${z.toFixed(2)} corr=${corr.toFixed(2)} — ${buy} undervalued vs pair`, source:'relative_value' });
    } catch {}
  }));
  return signals;
}

module.exports = { getSignals };
