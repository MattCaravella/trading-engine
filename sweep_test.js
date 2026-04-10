/**
 * Parameter sweep: test different ATR multipliers to find optimal exit settings
 * Runs the seed_history simulation with different parameters and compares results
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parameters to sweep
const CONFIGS = [
  // [meanRevATR, trendATR, label]
  [1.5, 1.0, 'Tight (1.5/1.0)'],
  [2.0, 1.5, 'Current (2.0/1.5)'],
  [2.5, 1.5, 'MR-wider (2.5/1.5)'],
  [2.5, 2.0, 'Both-wider (2.5/2.0)'],
  [3.0, 2.0, 'MR-wide (3.0/2.0)'],
  [3.0, 2.5, 'Wide (3.0/2.5)'],
  [3.5, 2.0, 'MR-very-wide (3.5/2.0)'],
  [3.5, 2.5, 'Very-wide (3.5/2.5)'],
];

// Also sweep breakeven trigger
const BREAKEVEN_LEVELS = [2, 3, 5];

// Also sweep max hold days
const HOLD_CONFIGS = [
  [15, 26, 'Current holds'],
  [20, 30, 'Longer holds'],
  [25, 40, 'Much longer'],
];

const SEED_FILE = path.join(__dirname, 'seed_history.js');
const LEDGER   = path.join(__dirname, 'trade_history', 'performance_ledger.json');
const SUMMARY  = path.join(__dirname, 'trade_history', 'performance_summary.json');

function clearLedger() {
  fs.writeFileSync(LEDGER, '{"trades":[],"knownClosedOrderIds":[]}');
}

function readSummary() {
  try { return JSON.parse(fs.readFileSync(SUMMARY, 'utf8')); }
  catch { return null; }
}

function patchSeedFile(mrATR, trendATR, breakevenPct, mrHoldDays, trendHoldDays) {
  let code = fs.readFileSync(SEED_FILE, 'utf8');
  
  // Patch ATR multipliers
  code = code.replace(
    /mean_reversion:\s*\{[^}]+\}/,
    `mean_reversion: { atrMult: ${mrATR}, trail: 0.08, profitTarget: null, maxHoldDays: ${mrHoldDays} }`
  );
  code = code.replace(
    /trend:\s*\{[^}]+\}/,
    `trend:          { atrMult: ${trendATR}, trail: 0.06, profitTarget: null, maxHoldDays: ${trendHoldDays} }`
  );
  code = code.replace(
    /relative_value:\s*\{[^}]+\}/,
    `relative_value: { atrMult: ${trendATR}, trail: 0.05, profitTarget: 0.10, maxHoldDays: ${Math.round((mrHoldDays+trendHoldDays)/2)} }`
  );
  code = code.replace(
    /default:\s*\{[^}]+\}/,
    `default:        { atrMult: ${trendATR}, trail: 0.06, profitTarget: 0.12, maxHoldDays: ${Math.round((mrHoldDays+trendHoldDays)/2)} }`
  );
  
  // Patch breakeven trigger
  code = code.replace(
    /BREAKEVEN_TRIGGER_PCT\s*=\s*[\d.]+/,
    `BREAKEVEN_TRIGGER_PCT = ${breakevenPct/100}`
  );
  
  fs.writeFileSync(SEED_FILE, code);
}

async function runSweep() {
  const origCode = fs.readFileSync(SEED_FILE, 'utf8');
  const results = [];
  
  console.log('═'.repeat(70));
  console.log('  ATR MULTIPLIER SWEEP — Finding Optimal Exit Parameters');
  console.log('═'.repeat(70));
  console.log(`  Testing ${CONFIGS.length} ATR configs x ${BREAKEVEN_LEVELS.length} breakeven levels x ${HOLD_CONFIGS.length} hold configs = ${CONFIGS.length * BREAKEVEN_LEVELS.length * HOLD_CONFIGS.length} combinations`);
  console.log('  Using --universe=top50 --years=3 for speed (~2min per test)');
  console.log('─'.repeat(70));
  
  let testNum = 0;
  const total = CONFIGS.length * BREAKEVEN_LEVELS.length * HOLD_CONFIGS.length;
  
  for (const [mrATR, trendATR, atrLabel] of CONFIGS) {
    for (const be of BREAKEVEN_LEVELS) {
      for (const [mrHold, trendHold, holdLabel] of HOLD_CONFIGS) {
        testNum++;
        const label = `ATR=${atrLabel}, BE=${be}%, Hold=${holdLabel}`;
        process.stdout.write(`  [${String(testNum).padStart(2)}/${total}] ${label}...`);
        
        clearLedger();
        patchSeedFile(mrATR, trendATR, be, mrHold, trendHold);
        
        try {
          execSync('node seed_history.js --universe=top50 --years=3', {
            cwd: __dirname,
            stdio: 'pipe',
            timeout: 300000,
          });
          
          const summary = readSummary();
          if (summary) {
            const annualized = (Math.pow(1 + summary.totalPnlDollar / 100000, 1/3) - 1) * 100;
            results.push({
              mrATR, trendATR, breakeven: be, mrHold, trendHold,
              label, atrLabel, holdLabel,
              trades: summary.totalTrades,
              winRate: summary.winRate,
              pnl: summary.totalPnlDollar,
              annualized,
              profitFactor: summary.profitFactor,
              avgHold: summary.avgHoldingHours,
              exits: summary.exitBreakdown,
            });
            console.log(` $${summary.totalPnlDollar.toFixed(0).padStart(7)} | ${(summary.winRate*100).toFixed(1)}% WR | ${annualized.toFixed(1)}%/yr | PF=${summary.profitFactor.toFixed(2)}`);
          } else {
            console.log(' FAILED (no summary)');
          }
        } catch (e) {
          console.log(' ERROR: ' + e.message.slice(0, 50));
        }
      }
    }
  }
  
  // Restore original file
  fs.writeFileSync(SEED_FILE, origCode);
  
  // Sort by P&L descending
  results.sort((a, b) => b.pnl - a.pnl);
  
  console.log('\n' + '═'.repeat(90));
  console.log('  TOP 10 CONFIGURATIONS (by total P&L)');
  console.log('═'.repeat(90));
  console.log(`  ${'#'.padEnd(3)} ${'ATR Config'.padEnd(22)} ${'BE%'.padEnd(5)} ${'Hold'.padEnd(16)} ${'P&L'.padStart(9)} ${'Ann%'.padStart(7)} ${'WR%'.padStart(6)} ${'PF'.padStart(5)} ${'Trades'.padStart(7)} ${'AvgH'.padStart(5)}`);
  console.log('  ' + '─'.repeat(87));
  
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(`  ${String(i+1).padEnd(3)} ${r.atrLabel.padEnd(22)} ${(r.breakeven+'%').padEnd(5)} ${r.holdLabel.padEnd(16)} $${r.pnl.toFixed(0).padStart(8)} ${r.annualized.toFixed(1).padStart(6)}% ${(r.winRate*100).toFixed(1).padStart(5)}% ${r.profitFactor.toFixed(2).padStart(5)} ${String(r.trades).padStart(6)} ${r.avgHold.toFixed(0).padStart(5)}`);
  }
  
  console.log('\n  WORST 3:');
  for (let i = results.length - 3; i < results.length; i++) {
    const r = results[i];
    console.log(`  ${String(i+1).padEnd(3)} ${r.atrLabel.padEnd(22)} ${(r.breakeven+'%').padEnd(5)} ${r.holdLabel.padEnd(16)} $${r.pnl.toFixed(0).padStart(8)} ${r.annualized.toFixed(1).padStart(6)}% ${(r.winRate*100).toFixed(1).padStart(5)}% ${r.profitFactor.toFixed(2).padStart(5)} ${String(r.trades).padStart(6)} ${r.avgHold.toFixed(0).padStart(5)}`);
  }
  
  // Save full results
  fs.writeFileSync(path.join(__dirname, 'trade_history', 'sweep_results.json'), JSON.stringify(results, null, 2));
  console.log('\n  Full results saved to trade_history/sweep_results.json');
  console.log('═'.repeat(90));
  
  // Recommend the best config
  const best = results[0];
  console.log('\n  RECOMMENDATION:');
  console.log('  ' + '─'.repeat(50));
  console.log('  ATR Multiplier:  Mean Reversion = ' + best.mrATR + 'x, Trend = ' + best.trendATR + 'x');
  console.log('  Breakeven:       ' + best.breakeven + '%');
  console.log('  Max Hold:        MR = ' + best.mrHold + ' days, Trend = ' + best.trendHold + ' days');
  console.log('  Expected:        ' + best.annualized.toFixed(1) + '%/yr, ' + (best.winRate*100).toFixed(1) + '% WR, ' + best.profitFactor.toFixed(2) + ' PF');
}

runSweep().catch(e => { console.error('Sweep failed:', e); process.exit(1); });
