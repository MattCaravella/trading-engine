/**
 * Governor — Portfolio-Level Risk Manager
 *
 * Inspired by PROJECT_DOCUMENTATION.md Governor + Guardian modules.
 * Evaluates portfolio-wide health before allowing new trades.
 *
 * Kill Levels (checked every cycle):
 *   1. Drawdown Kill  — 8% from peak equity → no new buys
 *   2. Sector Kill    — 25% max in any one sector
 *   3. Daily Cap      — Max 6 new trades per day
 *   4. Exposure Check — Ensures stops exist for all positions
 */

const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [k,...v]=line.split('='); if(k&&v.length) process.env[k.trim()]=v.join('=').trim();
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
const ALPACA_URL    = process.env.ALPACA_BASE_URL;

// ─── Configuration ───────────────────────────────────────────────────────────
const MAX_DRAWDOWN_PCT     = 8;       // 8% from peak → halt new buys
const MAX_SECTOR_PCT       = 25;      // 25% max in any sector
const MAX_DAILY_TRADES     = 10;      // Max new buys per day (increased for faster deployment)
const MAX_SHORT_POSITIONS  = 6;       // Max concurrent short positions
const MAX_SHORT_EXPOSURE   = 0.30;    // Max 30% of portfolio in shorts
const MAX_DAILY_SHORTS     = 3;       // Max new short entries per day
const MIN_DAILY_DOLLAR_VOL = 1000000; // Skip stocks with <$1M avg daily dollar volume
const MAX_CORRELATED       = 8;       // Max positions with high correlation (loosened from 3→6→8)
const CORR_THRESHOLD       = 0.75;    // Correlation threshold (lowered from 0.85 — allows sector-aligned thesis)
const MIN_CORR_POSITION_VAL = 500;    // Only check correlation against positions worth > $500

const STATE_FILE = path.join(__dirname, 'trade_history/governor_state.json');

// ─── Sector mapping — covers full universe (SP500 + MIDCAP + SMALLCAP) ──────
const SECTOR_MAP = {
  // Technology
  AAPL:'Tech',MSFT:'Tech',NVDA:'Tech',META:'Tech',GOOGL:'Tech',GOOG:'Tech',AMZN:'Tech',AVGO:'Tech',
  ORCL:'Tech',AMD:'Tech',QCOM:'Tech',TXN:'Tech',INTC:'Tech',MU:'Tech',AMAT:'Tech',LRCX:'Tech',
  KLAC:'Tech',NOW:'Tech',CRM:'Tech',ADBE:'Tech',INTU:'Tech',SNOW:'Tech',PLTR:'Tech',PANW:'Tech',
  CRWD:'Tech',ZS:'Tech',NET:'Tech',CSCO:'Tech',IBM:'Tech',HPE:'Tech',DELL:'Tech',ANET:'Tech',
  MRVL:'Tech',SMCI:'Tech',WDAY:'Tech',DDOG:'Tech',HUBS:'Tech',TTD:'Tech',OKTA:'Tech',MDB:'Tech',
  TEAM:'Tech',AI:'Tech',PATH:'Tech',COIN:'Tech',ADI:'Tech',MCHP:'Tech',GTLB:'Tech',CFLT:'Tech',
  ESTC:'Tech',ZM:'Tech',DOCU:'Tech',TWLO:'Tech',BILL:'Tech',BOX:'Tech',SMAR:'Tech',
  MNDY:'Tech',APPN:'Tech',NCNO:'Tech',RAMP:'Tech',COUP:'Tech',JAMF:'Tech',QLYS:'Tech',SPSC:'Tech',
  QTWO:'Tech',EVTC:'Tech',NEWR:'Tech',PCTY:'Tech',PAYC:'Tech',CDAY:'Tech',
  ATEN:'Tech',CEVA:'Tech',ALRM:'Tech',BAND:'Tech',RSKD:'Tech',TASK:'Tech',CINT:'Tech',ARLO:'Tech',
  PCMI:'Tech',MITK:'Tech',DXC:'Tech',
  // Financials
  JPM:'Fin',BAC:'Fin',GS:'Fin',MS:'Fin',WFC:'Fin',C:'Fin',BLK:'Fin',SCHW:'Fin',AXP:'Fin',
  V:'Fin',MA:'Fin',PYPL:'Fin',COF:'Fin',DFS:'Fin',SYF:'Fin',ALLY:'Fin',USB:'Fin',TFC:'Fin',
  KEY:'Fin',MTB:'Fin',FITB:'Fin',HBAN:'Fin',CFG:'Fin',ICE:'Fin',CME:'Fin',CBOE:'Fin',
  HOOD:'Fin',SOFI:'Fin',UPST:'Fin',AFRM:'Fin',IBKR:'Fin',
  RF:'Fin',ZION:'Fin',CMA:'Fin',WAL:'Fin',NDAQ:'Fin',MKTX:'Fin',
  BOKF:'Fin',FFIN:'Fin',WSFS:'Fin',SNV:'Fin',PNFP:'Fin',CVBF:'Fin',IBOC:'Fin',SFNC:'Fin',
  CATY:'Fin',FULT:'Fin',UMBF:'Fin',CBSH:'Fin',WTFC:'Fin',NBTB:'Fin',FBIZ:'Fin',
  BANF:'Fin',BRKL:'Fin',HAFC:'Fin',FBMS:'Fin',IBCP:'Fin',FFBC:'Fin',UVSP:'Fin',CBTX:'Fin',
  PFIS:'Fin',HONE:'Fin',ESSA:'Fin',SBCF:'Fin',FXNC:'Fin',SMBC:'Fin',
  // Healthcare
  UNH:'Health',LLY:'Health',JNJ:'Health',ABBV:'Health',MRK:'Health',PFE:'Health',TMO:'Health',
  ABT:'Health',DHR:'Health',BMY:'Health',AMGN:'Health',GILD:'Health',REGN:'Health',VRTX:'Health',
  MRNA:'Health',BNTX:'Health',CAH:'Health',MCK:'Health',CVS:'Health',CI:'Health',HUM:'Health',
  ELV:'Health',HCA:'Health',STE:'Health',BAX:'Health',BDX:'Health',MDT:'Health',SYK:'Health',BSX:'Health',
  BIIB:'Health',MOH:'Health',CNC:'Health',UHS:'Health',HOLX:'Health',HOLOGIC:'Health',ZBH:'Health',
  IQV:'Health',CRL:'Health',ILMN:'Health',WST:'Health',
  PDCO:'Health',HSIC:'Health',PRGO:'Health',JAZZ:'Health',ACAD:'Health',EXEL:'Health',ITCI:'Health',
  NTRA:'Health',PRVA:'Health',GKOS:'Health',MMSI:'Health',INVA:'Health',
  AXSM:'Health',IMVT:'Health',PRAX:'Health',ARDX:'Health',VRNA:'Health',HALO:'Health',KNSA:'Health',
  CLDX:'Health',ACRS:'Health',TARS:'Health',OMCL:'Health',LMAT:'Health',
  // Consumer (Discretionary + Staples)
  HD:'Consumer',LOW:'Consumer',MCD:'Consumer',SBUX:'Consumer',NKE:'Consumer',TJX:'Consumer',
  ROST:'Consumer',TGT:'Consumer',WMT:'Consumer',COST:'Consumer',DG:'Consumer',DLTR:'Consumer',
  EBAY:'Consumer',ETSY:'Consumer',PG:'Consumer',KO:'Consumer',PEP:'Consumer',CL:'Consumer',
  EL:'Consumer',PM:'Consumer',MO:'Consumer',STZ:'Consumer',
  BURL:'Consumer',M:'Consumer',KSS:'Consumer',CHWY:'Consumer',W:'Consumer',
  AZO:'Consumer',AAP:'Consumer',ORLY:'Consumer',GPC:'Consumer',LKQ:'Consumer',
  AN:'Consumer',KMX:'Consumer',LAD:'Consumer',PAG:'Consumer',SAH:'Consumer',
  LEA:'Consumer',BWA:'Consumer',
  MDLZ:'Consumer',GIS:'Consumer',K:'Consumer',CPB:'Consumer',CAG:'Consumer',HRL:'Consumer',
  MKC:'Consumer',CHD:'Consumer',SPB:'Consumer',CLX:'Consumer',
  ULTA:'Consumer',COTY:'Consumer',REV:'Consumer',AVP:'Consumer',
  BTI:'Consumer',LO:'Consumer',BUD:'Consumer',TAP:'Consumer',SAM:'Consumer',BREW:'Consumer',
  BOOKING:'Consumer',EXPE:'Consumer',
  BOOT:'Consumer',HIBB:'Consumer',CATO:'Consumer',ODP:'Consumer',BJ:'Consumer',PSMT:'Consumer',
  PTLO:'Consumer',FRPT:'Consumer',CENTA:'Consumer',RICK:'Consumer',BOWL:'Consumer',PLAY:'Consumer',
  DINE:'Consumer',CAKE:'Consumer',
  // Auto
  F:'Auto',GM:'Auto',TSLA:'Auto',RIVN:'Auto',LCID:'Auto',RACE:'Auto',HOG:'Auto',
  // Industrials
  BA:'Indust',CAT:'Indust',GE:'Indust',MMM:'Indust',HON:'Indust',RTX:'Indust',LMT:'Indust',
  UPS:'Indust',FDX:'Indust',DAL:'Indust',UAL:'Indust',DE:'Indust',EMR:'Indust',
  NOC:'Indust',GD:'Indust',L3H:'Indust',
  AAL:'Indust',LUV:'Indust',JBLU:'Indust',ALK:'Indust',SAVE:'Indust',
  ETN:'Indust',PH:'Indust',ROK:'Indust',AME:'Indust',FTV:'Indust',GNRC:'Indust',
  XYL:'Indust',XYLEM:'Indust',
  WM:'Indust',RSG:'Indust',CTAS:'Indust',FAST:'Indust',GWW:'Indust',MSC:'Indust',
  TT:'Indust',IR:'Indust',CARR:'Indust',OTIS:'Indust',
  SAIA:'Indust',WERN:'Indust',HUBG:'Indust',LSTR:'Indust',MATX:'Indust',RXO:'Indust',GXO:'Indust',
  AOS:'Indust',NVT:'Indust',AIMC:'Indust',AAON:'Indust',TREX:'Indust',BECN:'Indust',IBP:'Indust',
  MYRG:'Indust',STRL:'Indust',ROAD:'Indust',PRIM:'Indust',SHYF:'Indust',ZEUS:'Indust',
  KFRC:'Indust',NVEE:'Indust',GTES:'Indust',FTDR:'Indust',
  // Energy
  XOM:'Energy',CVX:'Energy',COP:'Energy',EOG:'Energy',MPC:'Energy',VLO:'Energy',OXY:'Energy',
  DVN:'Energy',HAL:'Energy',SLB:'Energy',HES:'Energy',
  PXD:'Energy',PSX:'Energy',BKR:'Energy',NOV:'Energy',FANG:'Energy',CLR:'Energy',APA:'Energy',
  MRO:'Energy',CTRA:'Energy',
  LNG:'Energy',CQP:'Energy',KMI:'Energy',WMB:'Energy',OKE:'Energy',ET:'Energy',EPD:'Energy',
  PAA:'Energy',TRGP:'Energy',ENBL:'Energy',
  SM:'Energy',CIVI:'Energy',MTDR:'Energy',RRC:'Energy',CRGY:'Energy',VTLE:'Energy',MGY:'Energy',
  MNRL:'Energy',GPRE:'Energy',REX:'Energy',REPX:'Energy',TPVG:'Energy',
  PLUG:'Energy',FCEL:'Energy',BLNK:'Energy',
  // Communications / Media
  NFLX:'Comms',DIS:'Comms',CMCSA:'Comms',T:'Comms',VZ:'Comms',TMUS:'Comms',SPOT:'Comms',
  SNAP:'Comms',PINS:'Comms',RDDT:'Comms',
  CHTR:'Comms',DISH:'Comms',PARA:'Comms',FOX:'Comms',
  MTCH:'Comms',IAC:'Comms',ZG:'Comms',TRIP:'Comms',
  // Real Estate
  AMT:'REIT',PLD:'REIT',EQIX:'REIT',CCI:'REIT',SPG:'REIT',O:'REIT',
  WELL:'REIT',DLR:'REIT',PSA:'REIT',EXR:'REIT',
  NNN:'REIT',STAG:'REIT',IIPR:'REIT',COLD:'REIT',EPRT:'REIT',NTST:'REIT',GOOD:'REIT',
  VNQ:'REIT',
  ILPT:'REIT',GMRE:'REIT',BRSP:'REIT',APLE:'REIT',
  // Utilities
  NEE:'Util',DUK:'Util',SO:'Util',AEP:'Util',XEL:'Util',
  EXC:'Util',ED:'Util',PCG:'Util',SRE:'Util',WEC:'Util',
  // Materials
  LIN:'Materials',APD:'Materials',SHW:'Materials',NEM:'Materials',FCX:'Materials',NUE:'Materials',
  ECL:'Materials',PPG:'Materials',AA:'Materials',CLF:'Materials',X:'Materials',
  IOSP:'Materials',KWR:'Materials',TROX:'Materials',HWKN:'Materials',ASIX:'Materials',KOP:'Materials',
  // Broad-market ETFs
  SPY:'ETF',QQQ:'ETF',IWM:'ETF',DIA:'ETF',EEM:'ETF',EFA:'ETF',ARKK:'ETF',ARKG:'ETF',ARKW:'ETF',
  // Sector ETFs (mapped to their sector)
  XLK:'Tech',XLF:'Fin',XLE:'Energy',XLV:'Health',XLI:'Indust',XLP:'Consumer',XLU:'Util',
  XLRE:'REIT',XLB:'Materials',XLC:'Comms',XLY:'Consumer',
  // Commodity ETFs
  GLD:'Commodity',SLV:'Commodity',USO:'Commodity',
  // Bond ETFs
  TLT:'Bond',IEF:'Bond',HYG:'Bond',
};

function getSector(ticker) {
  return SECTOR_MAP[ticker] || 'Other';
}

// Lazy-load database to avoid circular deps
let _db = null;
function getDb() {
  if (_db === null) {
    try { _db = require('./database'); } catch { _db = false; }
  }
  return _db || null;
}

// ─── State persistence ───────────────────────────────────────────────────────
function loadState() {
  // Try database first (primary source of truth)
  try {
    const db = getDb();
    if (db) {
      const dbState = db.getGovernorState();
      if (dbState && Object.keys(dbState).length > 0) {
        return {
          peakEquity: dbState.peakEquity || 0,
          dailyTrades: dbState.dailyTrades || {},
          lastDay: dbState.lastDay || null,
          ...dbState,
        };
      }
    }
  } catch (err) {
    // Fall through to JSON
  }

  // Fallback to JSON
  if (fs.existsSync(STATE_FILE)) try { return JSON.parse(fs.readFileSync(STATE_FILE)); } catch {}
  return { peakEquity: 0, dailyTrades: {}, lastDay: null };
}

function saveState(s) {
  // Save to JSON (backup / transition)
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

  // Also persist to SQLite database
  try {
    const db = getDb();
    if (db) db.saveGovernorState(s);
  } catch (err) {
    // JSON already saved as backup
  }
}

// ─── Alpaca helper ───────────────────────────────────────────────────────────
async function alpaca(endpoint) {
  const res = await fetch(`${ALPACA_URL}/v2${endpoint}`, {
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET }
  });
  return res.json();
}

// ─── 1. Drawdown Circuit Breaker ─────────────────────────────────────────────
function checkDrawdown(equity, state) {
  if (equity > state.peakEquity) state.peakEquity = equity;
  const drawdownPct = ((state.peakEquity - equity) / state.peakEquity) * 100;
  const killed = drawdownPct >= MAX_DRAWDOWN_PCT;
  return {
    killed,
    drawdownPct: drawdownPct.toFixed(2),
    peakEquity: state.peakEquity.toFixed(2),
    reason: killed ? `DRAWDOWN KILL: -${drawdownPct.toFixed(2)}% from peak $${state.peakEquity.toFixed(0)} (limit: ${MAX_DRAWDOWN_PCT}%)` : null
  };
}

// ─── 2. Sector Concentration Check ──────────────────────────────────────────
// Sectors exempt from concentration limits (diversified by nature)
const EXEMPT_SECTORS = new Set(['ETF', 'Commodity', 'Bond']);

function checkSectorConcentration(positions, equity, newTicker, newValue) {
  const sectorExposure = {};
  for (const pos of positions) {
    const sector = getSector(pos.symbol);
    const mktVal = Math.abs(parseFloat(pos.market_value));
    sectorExposure[sector] = (sectorExposure[sector] || 0) + mktVal;
  }

  const newSector = getSector(newTicker);

  // ETFs, Commodity ETFs, and Bond ETFs are diversified — exempt from sector limits
  if (EXEMPT_SECTORS.has(newSector)) {
    const currentSectorVal = sectorExposure[newSector] || 0;
    return {
      blocked: false,
      sector: newSector,
      currentPct: ((currentSectorVal / equity) * 100).toFixed(1),
      projectedPct: (((currentSectorVal + newValue) / equity) * 100).toFixed(1),
      reason: null
    };
  }

  const currentSectorVal = sectorExposure[newSector] || 0;
  const projectedPct = ((currentSectorVal + newValue) / equity) * 100;
  const blocked = projectedPct > MAX_SECTOR_PCT;

  return {
    blocked,
    sector: newSector,
    currentPct: ((currentSectorVal / equity) * 100).toFixed(1),
    projectedPct: projectedPct.toFixed(1),
    reason: blocked ? `SECTOR LIMIT: ${newSector} at ${projectedPct.toFixed(1)}% (max ${MAX_SECTOR_PCT}%)` : null
  };
}

// ─── 3. Daily Trade Cap ─────────────────────────────────────────────────────
function checkDailyCap(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastDay !== today) {
    state.dailyTrades = {};
    state.lastDay = today;
  }
  const count = state.dailyTrades[today] || 0;
  const blocked = count >= MAX_DAILY_TRADES;
  return {
    blocked,
    count,
    max: MAX_DAILY_TRADES,
    reason: blocked ? `DAILY CAP: ${count}/${MAX_DAILY_TRADES} trades today` : null
  };
}

function recordTrade(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyTrades) state.dailyTrades = {};
  state.dailyTrades[today] = (state.dailyTrades[today] || 0) + 1;
}

// ─── 4. Stop Order Reconciliation ───────────────────────────────────────────
// Strategy-specific trail percentages (must match engine.js EXIT_PROFILES)
const TRAIL_BY_PROFILE = {
  mean_reversion: 8, trend: 6, relative_value: 5, default: 6
};
const SOURCE_TO_PROFILE_GOV = {
  downtrend: 'mean_reversion', bollinger: 'mean_reversion',
  ma_crossover: 'trend', relative_value: 'relative_value',
};

function getTrailForSymbol(symbol) {
  // Read position sources from engine state to get correct trail %
  try {
    const stateFile = path.join(__dirname, 'trade_history/engine_state.json');
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile));
      const source = state.positionSources?.[symbol];
      if (source) {
        const profile = SOURCE_TO_PROFILE_GOV[source] || 'default';
        return TRAIL_BY_PROFILE[profile];
      }
    }
  } catch {}
  return TRAIL_BY_PROFILE.default;  // fallback: 6%
}

async function reconcileStops(positions, openOrders) {
  const stopSymbols = new Set(
    openOrders
      .filter(o => o.side === 'sell' && (o.type === 'trailing_stop' || o.type === 'stop'))
      .map(o => o.symbol)
  );

  const unprotected = [];
  for (const pos of positions) {
    // Short positions (negative qty) are managed by hard stop in engine — skip trailing stop check
    if (parseFloat(pos.qty) < 0) continue;
    if (!stopSymbols.has(pos.symbol)) {
      unprotected.push(pos.symbol);
    }
  }

  if (unprotected.length > 0) {
    console.log(`  [Governor] ⚠ UNPROTECTED positions (no stop order): ${unprotected.join(', ')}`);
    for (const symbol of unprotected) {
      const pos = positions.find(p => p.symbol === symbol);
      if (!pos) continue;
      const trail = getTrailForSymbol(symbol);
      try {
        const res = await fetch(`${ALPACA_URL}/v2/orders`, {
          method: 'POST',
          headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, qty: String(pos.qty), side: 'sell', type: 'trailing_stop', trail_percent: String(trail), time_in_force: 'gtc' })
        });
        const order = await res.json();
        if (order && order.id) {
          console.log(`  [Governor] ✓ Re-placed trailing stop for ${symbol} (${trail}% trail)`);
        }
      } catch (e) {
        console.warn(`  [Governor] Failed to re-place stop for ${symbol}: ${e.message}`);
      }
    }
  } else {
    console.log(`  [Governor] ✓ All ${positions.length} positions have stop orders`);
  }

  return { unprotected, allProtected: unprotected.length === 0 };
}

// ─── 5. Liquidity Filter ────────────────────────────────────────────────────
async function checkLiquidity(ticker) {
  try {
    const { getBars, closes, volumes, sma } = require('./data/prices');
    const bars = await getBars(ticker, 25);
    const cls  = closes(bars);
    const vols = volumes(bars);
    const avgVol   = sma(vols, 20);
    const avgPrice = sma(cls, 20);
    if (avgVol && avgPrice) {
      const dollarVol = avgVol * avgPrice;
      if (dollarVol < MIN_DAILY_DOLLAR_VOL) {
        return { blocked: true, dollarVol: Math.round(dollarVol), reason: `LOW LIQUIDITY: ${ticker} avg $vol $${Math.round(dollarVol).toLocaleString()} < $${MIN_DAILY_DOLLAR_VOL.toLocaleString()}` };
      }
      return { blocked: false, dollarVol: Math.round(dollarVol) };
    }
    return { blocked: false, dollarVol: null };
  } catch {
    return { blocked: false, dollarVol: null }; // fail open — don't block on data error
  }
}

// ─── 6. Correlation Check ────────────────────────────────────────────────────
async function checkCorrelation(newTicker, positions) {
  try {
    const { getBars, closes, correlation } = require('./data/prices');
    const newBars = await getBars(newTicker, 60);
    const newCls  = closes(newBars);
    if (newCls.length < 30) return { blocked: false, highCorrCount: 0 };

    let highCorrCount = 0;
    const correlated  = [];

    // Only check against current positions with meaningful size (skip legacy 1-share positions)
    const meaningfulPositions = positions.filter(p => Math.abs(parseFloat(p.market_value || 0)) >= MIN_CORR_POSITION_VAL);
    for (const pos of meaningfulPositions) {
      try {
        const posBars = await getBars(pos.symbol, 60);
        const posCls  = closes(posBars);
        const corr    = correlation(newCls, posCls);
        if (corr >= CORR_THRESHOLD) {
          highCorrCount++;
          correlated.push(`${pos.symbol}(${corr.toFixed(2)})`);
        }
      } catch {}
    }

    const blocked = highCorrCount >= MAX_CORRELATED;
    return {
      blocked,
      highCorrCount,
      correlated,
      reason: blocked ? `CORRELATION LIMIT: ${newTicker} correlated with ${correlated.join(', ')} (max ${MAX_CORRELATED})` : null
    };
  } catch {
    return { blocked: false, highCorrCount: 0 };
  }
}

// ─── Full pre-trade evaluation ──────────────────────────────────────────────
async function evaluateTrade(ticker, equity, positions, openOrders, positionValue) {
  const state = loadState();
  const results = { approved: true, reasons: [] };

  // 1. Drawdown check
  const dd = checkDrawdown(equity, state);
  if (dd.killed) { results.approved = false; results.reasons.push(dd.reason); }

  // 2. Daily cap
  const cap = checkDailyCap(state);
  if (cap.blocked) { results.approved = false; results.reasons.push(cap.reason); }

  // 3. Sector concentration
  const sector = checkSectorConcentration(positions, equity, ticker, positionValue || equity * 0.08);
  if (sector.blocked) { results.approved = false; results.reasons.push(sector.reason); }

  // 4. Liquidity
  const liq = await checkLiquidity(ticker);
  if (liq.blocked) { results.approved = false; results.reasons.push(liq.reason); }

  // 5. Correlation
  if (results.approved) { // only run expensive correlation check if still approved
    const corr = await checkCorrelation(ticker, positions);
    if (corr.blocked) { results.approved = false; results.reasons.push(corr.reason); }
  }

  saveState(state);
  return results;
}

// Record that a trade was made (call after successful buy)
function recordTradeExecuted() {
  const state = loadState();
  recordTrade(state);
  saveState(state);
}

// Update peak equity (call at start of each cycle)
function updatePeakEquity(equity) {
  const state = loadState();
  if (equity > state.peakEquity) {
    state.peakEquity = equity;
    saveState(state);
  }
  return state.peakEquity;
}

// Full cycle status report
function getStatus(equity) {
  const state = loadState();
  const dd = checkDrawdown(equity, state);
  const cap = checkDailyCap(state);
  saveState(state);
  return { drawdown: dd, dailyCap: cap, peakEquity: state.peakEquity };
}

// ─── Short Trade Evaluation ──────────────────────────────────────────────────
async function evaluateShortTrade(ticker, equity, positions) {
  const state = loadState();
  const results = { approved: true, reasons: [] };

  // 1. Drawdown check — shorts are HEDGES, so allow them during drawdowns
  // Only block shorts if drawdown exceeds 2x the normal kill level (catastrophic)
  const dd = checkDrawdown(equity, state);
  if (dd.killed && dd.drawdownPct > MAX_DRAWDOWN_PCT * 2) {
    results.approved = false;
    results.reasons.push(`CATASTROPHIC DRAWDOWN: ${dd.drawdownPct.toFixed(1)}% — all trading halted`);
  }

  // 2. Daily short cap (fix: initialize dailyShorts if missing)
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyShorts) state.dailyShorts = {};
  if (state.lastDay !== today) { state.dailyTrades = {}; state.dailyShorts = {}; state.lastDay = today; }
  const dailyShorts = state.dailyShorts[today] || 0;
  if (dailyShorts >= MAX_DAILY_SHORTS) {
    results.approved = false;
    results.reasons.push(`DAILY SHORT CAP: ${dailyShorts}/${MAX_DAILY_SHORTS} shorts today`);
  }

  // 3. Max concurrent short positions
  const currentShorts = positions.filter(p => parseFloat(p.qty) < 0);
  if (currentShorts.length >= MAX_SHORT_POSITIONS) {
    results.approved = false;
    results.reasons.push(`MAX SHORT POSITIONS: ${currentShorts.length}/${MAX_SHORT_POSITIONS} already open`);
  }

  // 4. Max short exposure (% of equity)
  const shortExposure = currentShorts.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);
  const shortExposurePct = shortExposure / equity;
  if (shortExposurePct >= MAX_SHORT_EXPOSURE) {
    results.approved = false;
    results.reasons.push(`MAX SHORT EXPOSURE: ${(shortExposurePct * 100).toFixed(1)}% >= ${MAX_SHORT_EXPOSURE * 100}%`);
  }

  // 5. Already have a short on this ticker
  if (currentShorts.some(p => p.symbol === ticker)) {
    results.approved = false;
    results.reasons.push(`DUPLICATE SHORT: already short ${ticker}`);
  }

  // 6. Sector concentration for shorts (max 25% of short exposure in one sector)
  if (currentShorts.length > 0) {
    const shortSectorExposure = {};
    for (const p of currentShorts) {
      const sec = getSector(p.symbol);
      shortSectorExposure[sec] = (shortSectorExposure[sec] || 0) + Math.abs(parseFloat(p.market_value || 0));
    }
    const newSector = getSector(ticker);
    const currentSectorShort = shortSectorExposure[newSector] || 0;
    const projectedPct = shortExposure > 0 ? ((currentSectorShort + equity * 0.05) / (shortExposure + equity * 0.05)) * 100 : 0;
    if (projectedPct > 50) {
      results.approved = false;
      results.reasons.push(`SHORT SECTOR CONCENTRATION: ${newSector} would be ${projectedPct.toFixed(0)}% of short book (max 50%)`);
    }
  }

  // 7. Liquidity check
  const liq = await checkLiquidity(ticker);
  if (liq.blocked) { results.approved = false; results.reasons.push(liq.reason); }

  saveState(state);
  return results;
}

function recordShortExecuted() {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyShorts) state.dailyShorts = {};
  state.dailyShorts[today] = (state.dailyShorts[today] || 0) + 1;
  saveState(state);
}

// ─── Aggressive Trade Evaluation ──────────────────────────────────────────────
const AGGRESSIVE_MAX_POSITIONS = 8;
const AGGRESSIVE_MAX_DAILY     = 15;
const AGGRESSIVE_ALLOCATION    = 0.10;

async function evaluateAggressiveTrade(ticker, equity, positions) {
  const state = loadState();
  const results = { approved: true, reasons: [] };

  // 1. Drawdown check — use same drawdown kill as main engine
  const dd = checkDrawdown(equity, state);
  if (dd.killed) {
    results.approved = false;
    results.reasons.push(dd.reason);
  }

  // 2. Max aggressive positions (8)
  // Count positions tagged as aggressive by checking aggressive engine state
  let aggressiveCount = 0;
  try {
    const aggStateFile = path.join(__dirname, 'trade_history/aggressive_state.json');
    if (fs.existsSync(aggStateFile)) {
      const aggState = JSON.parse(fs.readFileSync(aggStateFile));
      aggressiveCount = Object.keys(aggState.aggressivePositions || {}).length;
    }
  } catch {}

  if (aggressiveCount >= AGGRESSIVE_MAX_POSITIONS) {
    results.approved = false;
    results.reasons.push(`AGGRESSIVE MAX POSITIONS: ${aggressiveCount}/${AGGRESSIVE_MAX_POSITIONS} slots filled`);
  }

  // 3. Daily aggressive trade cap (15)
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyAggressive) state.dailyAggressive = {};
  if (state.lastDay !== today) {
    state.dailyTrades = {};
    state.dailyShorts = state.dailyShorts || {};
    state.dailyAggressive = {};
    state.lastDay = today;
  }
  const dailyAggressive = state.dailyAggressive[today] || 0;
  if (dailyAggressive >= AGGRESSIVE_MAX_DAILY) {
    results.approved = false;
    results.reasons.push(`AGGRESSIVE DAILY CAP: ${dailyAggressive}/${AGGRESSIVE_MAX_DAILY} aggressive trades today`);
  }

  // 4. Already have this ticker (in aggressive OR main engine)
  if (positions.some(p => p.symbol === ticker)) {
    results.approved = false;
    results.reasons.push(`DUPLICATE POSITION: already holding ${ticker} (main or aggressive)`);
  }

  // 5. Liquidity check (same as main engine)
  const liq = await checkLiquidity(ticker);
  if (liq.blocked) {
    results.approved = false;
    results.reasons.push(liq.reason);
  }

  // NO sector check — aggressive engine is momentum-driven
  // NO correlation check — positions too small and short-lived
  // NO earnings block — aggressive engine wants catalysts

  saveState(state);
  return results;
}

function recordAggressiveExecuted() {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyAggressive) state.dailyAggressive = {};
  state.dailyAggressive[today] = (state.dailyAggressive[today] || 0) + 1;
  saveState(state);
}

module.exports = {
  evaluateTrade,
  evaluateShortTrade,
  evaluateAggressiveTrade,
  reconcileStops,
  recordTradeExecuted,
  recordShortExecuted,
  recordAggressiveExecuted,
  updatePeakEquity,
  getStatus,
  checkLiquidity,
  getSector,
  MAX_DRAWDOWN_PCT,
  MAX_SECTOR_PCT,
  MAX_DAILY_TRADES,
  MAX_SHORT_POSITIONS,
  MAX_SHORT_EXPOSURE,
  MAX_DAILY_SHORTS,
  AGGRESSIVE_MAX_POSITIONS,
  AGGRESSIVE_MAX_DAILY,
  AGGRESSIVE_ALLOCATION,
};
