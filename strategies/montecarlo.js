const { getBars, closes, returns } = require('../data/prices');

const SIMS = 2000;

// Strategy-specific simulation horizons and tolerances
const PROFILES = {
  mean_reversion: { horizon: 10, ruinMax: 10, ddMax: 45, label: 'MC(reversion)' },
  trend:          { horizon: 20, ruinMax: 5,  ddMax: 35, label: 'MC(trend)' },
  default:        { horizon: 20, ruinMax: 7,  ddMax: 40, label: 'MC(default)' },
};

const SOURCE_TO_MC_PROFILE = {
  downtrend: 'mean_reversion', bollinger: 'mean_reversion',
  ma_crossover: 'trend',
};

// Short profile — ruin = stock goes UP 8%+ (opposite of longs)
const SHORT_RUIN_PCT    = 0.08;  // 8% adverse move = "ruin" for a short
const SHORT_RUIN_LIMIT  = 20;    // Max 20% chance of that happening in 10 days
const SHORT_RUIN_HARD   = 35;    // Hard skip if >35% chance of 8% squeeze

async function simulateTicker(ticker, capital, horizon = 20) {
  const bars = await getBars(ticker, 252);
  const rets = returns(closes(bars));
  if (rets.length < 30) return null;
  const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
  const std  = Math.sqrt(rets.reduce((s,r)=>s+(r-mean)**2,0)/rets.length);
  const finals=[]; let ruinCount=0; const dds=[];
  for (let s=0;s<SIMS;s++) {
    let val=capital, peak=capital, maxDD=0;
    for (let d=0;d<horizon;d++) {
      const u1=Math.random(),u2=Math.random();
      const z=Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
      val *= (1+mean+std*z);
      if (val>peak) peak=val;
      const dd=(peak-val)/peak;
      if (dd>maxDD) maxDD=dd;
    }
    finals.push(val); dds.push(maxDD);
    if (val<capital*0.90) ruinCount++;  // Ruin = 10% loss (aligned with 8% drawdown kill)
  }
  finals.sort((a,b)=>a-b); dds.sort((a,b)=>a-b);
  return {
    ticker, p5:finals[Math.floor(SIMS*0.05)], p50:finals[Math.floor(SIMS*0.50)], p95:finals[Math.floor(SIMS*0.95)],
    probRuin:(ruinCount/SIMS*100).toFixed(1),
    maxDrawdownP95:(dds[Math.floor(SIMS*0.95)]*100).toFixed(1),
    annualizedVol:(std*Math.sqrt(252)*100).toFixed(1),
  };
}

async function assessPositionRisk(ticker, portfolioValue, signalSource) {
  try {
    const mcProfile = PROFILES[SOURCE_TO_MC_PROFILE[signalSource] || 'default'];
    const r = await simulateTicker(ticker, portfolioValue*0.10, mcProfile.horizon);
    if (!r) return { safe:true, maxPct:10, reason:'Insufficient data' };
    const ruin=parseFloat(r.probRuin), dd=parseFloat(r.maxDrawdownP95), vol=parseFloat(r.annualizedVol);
    // Hard skip only if ruin is extreme (>30%) — protects against true blow-up candidates
    if (ruin > 30) return { safe:false, maxPct:0, reason:`${mcProfile.label}: ${ruin}% ruin > 30% hard limit — skip` };
    // Tiered sizing for elevated ruin (size down instead of skip)
    if (ruin > 20) return { safe:true, maxPct:3, reason:`${mcProfile.label}: ${ruin}% ruin — sized to 3%` };
    if (ruin > mcProfile.ruinMax) return { safe:true, maxPct:5, reason:`${mcProfile.label}: ${ruin}% ruin > ${mcProfile.ruinMax}% limit — sized to 5%` };
    if (dd > mcProfile.ddMax)     return { safe:true, maxPct:3, reason:`${mcProfile.label}: ${dd}% drawdown > ${mcProfile.ddMax}% limit — sized to 3%` };
    if (vol > 80)   return { safe:true,  maxPct:3, reason:`${mcProfile.label}: vol=${vol}% — size to 3%` };
    if (vol > 50)   return { safe:true,  maxPct:5, reason:`${mcProfile.label}: vol=${vol}% — size to 5%` };
    return { safe:true, maxPct:10, reason:`${mcProfile.label}: vol=${vol}%, maxDD=${dd}%, ruin=${ruin}% — ok` };
  } catch(e) { return { safe:true, maxPct:5, reason:`Monte Carlo error: ${e.message}` }; }
}

async function runPortfolioStressTest(positions, portfolioValue) {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Monte Carlo Portfolio Stress Test       ║');
  console.log('╚══════════════════════════════════════════╝\n');
  let t5=0,t50=0,t95=0;
  for (const pos of positions) {
    const r = await simulateTicker(pos.symbol, parseFloat(pos.market_value)).catch(()=>null);
    if (!r) continue;
    console.log(`${pos.symbol.padEnd(6)} Vol=${r.annualizedVol}%pa | Ruin=${r.probRuin}% | MaxDD(95th)=${r.maxDrawdownP95}%`);
    console.log(`       30d: P5=$${r.p5.toFixed(0)} P50=$${r.p50.toFixed(0)} P95=$${r.p95.toFixed(0)}`);
    t5+=r.p5; t50+=r.p50; t95+=r.p95;
  }
  console.log(`\nPortfolio 30d: Bear=$${t5.toFixed(0)} Base=$${t50.toFixed(0)} Bull=$${t95.toFixed(0)}\n`);
  return { totalP5:t5, totalP50:t50, totalP95:t95 };
}

/**
 * Monte Carlo risk check for SHORT positions.
 * "Ruin" = stock goes UP 8%+ within 10 days (short squeeze / gap up scenario).
 */
async function assessShortRisk(ticker, portfolioValue) {
  try {
    const r = await simulateTicker(ticker, portfolioValue * 0.05, 10); // 5% position, 10-day horizon
    if (!r) return { safe: true, maxPct: 5, reason: 'Insufficient data' };
    const vol = parseFloat(r.annualizedVol);

    // Count how many simulations ended with val > capital*(1+SHORT_RUIN_PCT)
    // Re-run to get short-specific ruin count (upward moves)
    const bars = await (async () => {
      const { getBars, closes, returns } = require('../data/prices');
      const b = await getBars(ticker, 252);
      return returns(closes(b));
    })();
    const rets = bars;
    if (rets.length < 30) return { safe: true, maxPct: 5, reason: 'Insufficient data' };
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const std  = Math.sqrt(rets.reduce((s, r2) => s + (r2 - mean) ** 2, 0) / rets.length);
    const capital = portfolioValue * 0.05;
    let squeezeCount = 0;
    for (let s = 0; s < SIMS; s++) {
      let val = capital;
      for (let d = 0; d < 10; d++) {
        const u1 = Math.random(), u2 = Math.random();
        const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        val *= (1 + mean + std * z);
      }
      if (val > capital * (1 + SHORT_RUIN_PCT)) squeezeCount++;
    }
    const squeezeRisk = parseFloat((squeezeCount / SIMS * 100).toFixed(1));

    if (squeezeRisk > SHORT_RUIN_HARD) return { safe: false, maxPct: 0, reason: `MC(short): ${squeezeRisk}% squeeze risk > ${SHORT_RUIN_HARD}% hard limit — skip` };
    if (squeezeRisk > SHORT_RUIN_LIMIT) return { safe: true, maxPct: 3, reason: `MC(short): ${squeezeRisk}% squeeze risk — sized to 3%` };
    if (vol > 80) return { safe: true, maxPct: 3, reason: `MC(short): vol=${vol}% — sized to 3%` };
    if (vol > 50) return { safe: true, maxPct: 5, reason: `MC(short): vol=${vol}% — sized to 5%` };
    return { safe: true, maxPct: 5, reason: `MC(short): squeeze=${squeezeRisk}%, vol=${vol}% — ok` };
  } catch (e) {
    return { safe: true, maxPct: 3, reason: `MC(short) error: ${e.message}` };
  }
}

module.exports = { simulateTicker, assessPositionRisk, assessShortRisk, runPortfolioStressTest };
