# Autonomous Paper-Trading System — Complete Documentation

**Version:** 1.0
**Platform:** Node.js + Alpaca Paper Trading + QuiverQuant + Alpha Vantage
**Author:** Matthew Caravella
**Last Updated:** April 7, 2026

---

## Table of Contents

1. [System Philosophy](#system-philosophy)
2. [Architecture Overview](#architecture-overview)
3. [The Pipeline Cycle](#the-pipeline-cycle)
4. [Scheduling & Market Hours](#scheduling--market-hours)
5. [Signal Sources — Monitors (Alt-Data)](#signal-sources--monitors-alt-data)
6. [Signal Sources — Strategies (Technical)](#signal-sources--strategies-technical)
7. [Signal Aggregation & Scoring](#signal-aggregation--scoring)
8. [Signal Lifecycle State Machine](#signal-lifecycle-state-machine)
9. [Risk Management — Governor](#risk-management--governor)
10. [Risk Management — Monte Carlo Gate](#risk-management--monte-carlo-gate)
11. [Execution & Position Management](#execution--position-management)
12. [Strategy Calibrator — Adaptive Feedback Loop](#strategy-calibrator--adaptive-feedback-loop)
13. [Postmortem Analyzer](#postmortem-analyzer)
14. [Performance Tracker](#performance-tracker)
15. [Daily Summary & Forecast Reports](#daily-summary--forecast-reports)
16. [Data Layer](#data-layer)
17. [API Integrations](#api-integrations)
18. [File Persistence & State Management](#file-persistence--state-management)
19. [Module Reference](#module-reference)
20. [Complete Configuration Reference](#complete-configuration-reference)
21. [Dependency Graph](#dependency-graph)
22. [Reconstruction Checklist](#reconstruction-checklist)
23. [Git & Deployment](#git--deployment)

---

## System Philosophy

This system is a fully autonomous stock trading engine that runs on a single Node.js process. It combines **12 independent signal sources** across two categories — alternative data monitors and technical analysis strategies — to identify buy candidates in a universe of 500+ US equities.

The system is designed around several core principles:

1. **Signal diversity over signal depth** — 12 independent generators provide uncorrelated buy signals across fundamental, technical, and sentiment data. No single source can trigger a buy alone (alt-data requires technical confirmation).

2. **Cascading risk gates** — Every buy candidate passes through 8 sequential checks: signal staleness, technical confirmation, strategy kill check, governor (drawdown + sector + daily cap + liquidity + correlation), earnings guard, and Monte Carlo risk assessment. Any single failure blocks the trade.

3. **Self-improving weights** — The Strategy Calibrator reads the postmortem performance ledger daily and adjusts signal source weights. Winning strategies get boosted, losing strategies get penalized or killed entirely.

4. **Full audit trail** — Every signal state transition is logged to JSONL. Every trade gets a postmortem record. Every cycle gets a summary. Daily reports are saved to OneDrive.

5. **Operational simplicity** — The entire system is one `node scheduler.js` process. No database, no Python, no Docker. Just Node.js 18+ with native `fetch()`. Auto-starts on Windows login, auto-backs up to GitHub.

6. **Paper trading safety** — Running on Alpaca paper trading ($100,000 account). All risk parameters are tuned for learning, not production. The system builds calibration data before any real money would be risked.

---

## Architecture Overview

```
                    +-------------------------------+
                    |        EXTERNAL APIs           |
                    |  Alpaca  QuiverQuant  AlphaV   |
                    |  Yahoo Finance                 |
                    +---------------+---------------+
                                    |
                    +---------------v---------------+
                    |        data/prices.js          |
                    |   Cache-first fetch layer      |
                    |   15-min in-memory TTL          |
                    +---------------+---------------+
                                    |
         +--------------------------+-------------------------+
         |                          |                         |
   +-----v-----+           +-------v-------+          +------v------+
   |  MONITORS  |           |  STRATEGIES   |          |  EARNINGS   |
   |  (Alt-Data)|           |  (Technical)  |          |  GUARD      |
   |  6 sources |           |  6 sources    |          |  (blocker)  |
   +-----+-----+           +-------+-------+          +------+------+
         |                          |                         |
         +------------+-------------+                         |
                      |                                       |
              +-------v--------+                              |
              |  signal_cache  |                              |
              |  SLOW (24h)    |                              |
              |  FAST (2h)     |                              |
              |  Health check  |                              |
              +-------+--------+                              |
                      |                                       |
              +-------v--------+                              |
              |   signals.js   |                              |
              | Aggregate by   |                              |
              | ticker, weight |                              |
              | overlay vs     |                              |
              | primary        |                              |
              +-------+--------+                              |
                      |                                       |
              +-------v-----------+                           |
              | signal_lifecycle  |                           |
              | GENERATED         |                           |
              | -> CONFIRMED      |                           |
              | -> APPROVED       |                           |
              | -> EXECUTED       |                           |
              +-------+-----------+                           |
                      |                                       |
         +------------+-----------+--------------+            |
         |            |           |              |            |
   +-----v---+ +-----v---+ +----v------+ +-----v-----+     |
   |GOVERNOR | |CALIBRATOR| |MONTE CARLO| |EARNINGS   |<----+
   |drawdown | |kill check| |2000 sims  | |5-day block|
   |sector   | |          | |           | |           |
   |daily cap| |          | |           | |           |
   |liquidity| |          | |           | |           |
   |correlat.| |          | |           | |           |
   +---------+ +----------+ +-----------+ +-----------+
         |            |           |              |
         +------------+-----------+--------------+
                      |
              +-------v--------+
              |    engine.js   |
              |  Place buy     |
              |  Manage stops  |
              |  Profit target |
              |  Hard stop     |
              +-------+--------+
                      |
         +------------+------------+
         |            |            |
   +-----v---+ +-----v----+ +----v--------+
   |POSTMORTEM| |PERF      | |DAILY REPORTS|
   |P&L, MFE | |TRACKER   | |Summary +    |
   |Exit type | |Sharpe    | |Forecast     |
   |Sources   | |Drawdown  | |OneDrive     |
   +----------+ +----------+ +-------------+
```

The system runs on a **60-second heartbeat**. Every minute, the scheduler checks the current market phase (pre-market, market hours, after-hours, closed) and dispatches the appropriate operations.

---

## The Pipeline Cycle

The main trade execution cycle (`engine.js runTradeCycle()`) runs every 5 minutes during market hours. Here is exactly what happens each cycle:

**Step 1 — Account Check:**
Fetches live account data from Alpaca. Checks if trading is blocked. Records equity for drawdown tracking.

**Step 2 — System Health Check:**
Checks `isSystemHealthy()` from signal cache. If more than 15% of data sources failed during the last refresh, triggers System Kill — manages stops only, no new buys.

**Step 3 — Peak Equity Update:**
Updates the governor's peak equity tracker. Calculates current drawdown from peak. Logs both values.

**Step 4 — Detect Stop-Outs:**
Queries Alpaca for recently closed orders. Identifies any trailing stop or hard stop fills. Records the stop-out with timestamp for the 24-hour cooldown.

**Step 5 — Postmortem Processing:**
Passes all closed orders to the postmortem analyzer. New closures get full analysis: entry/exit price, P&L, holding duration, exit reason, source attribution. Results are appended to the performance ledger.

**Step 6 — Position & Order Fetch:**
Gets all open positions and open orders from Alpaca in parallel.

**Step 7 — Stop Reconciliation:**
Governor cross-checks every open position against open sell orders. If any position lacks a trailing stop, it is automatically re-placed. Logs protected/unprotected status.

**Step 8 — Position Management:**
For each open position:
- If P&L >= +7%: sell at market (profit target)
- If P&L <= -6%: sell at market (hard stop), add to cooldown
- If no trailing stop exists and position is older than today: place 4% trailing stop
- If position opened today: skip trailing stop (PDT protection), will be placed overnight

**Step 9 — Signal Processing:**
Resets the lifecycle tracker. If system is healthy, fetches ranked candidates from signal cache. Filters candidates: score >= 65, not already held, not pending buy, not on cooldown.

**Step 10 — Lifecycle Registration:**
Each candidate is registered in the signal lifecycle tracker (GENERATED state). Checked for technical confirmation (must have at least one primary source signal). Unconfirmed candidates are rejected (REJECTED_UNCONFIRMED).

**Step 11 — Risk Gate Cascade:**
For each confirmed candidate, in order:
1. Strategy kill check (calibrator) — skip if source strategy is disabled
2. Governor evaluation — drawdown, sector concentration, daily trade cap, liquidity, correlation
3. Earnings guard — skip if earnings within 5 days
4. Monte Carlo risk assessment — skip if ruin probability > 5% or max drawdown > 30%

**Step 12 — Execution:**
Candidates that pass all gates are approved (APPROVED state). A market buy order is placed with quantity calculated from equity and Monte Carlo's recommended max position percentage. On successful order, the signal transitions to EXECUTED.

**Step 13 — Cycle Summary:**
Logs the lifecycle rejection histogram and total new trades. Saves engine state.

---

## Scheduling & Market Hours

**File:** `scheduler.js` (121 lines) + `market_hours.js` (42 lines)

All times are in **Eastern Time (ET)**. The scheduler uses a 60-second `setInterval` heartbeat.

| Time (ET) | Phase | What Runs |
|-----------|-------|-----------|
| 12:00 AM - 8:00 AM | CLOSED | Idle. No operations. |
| 8:00 AM | PRE-MARKET | `refreshSlow()` — Fetches congress, contracts, lobbying, insider buying, downtrend, tech sector signals. Seeds the slow cache for the day. |
| 8:00 AM - 9:30 AM | PRE-MARKET | Idle after slow refresh completes. |
| 9:30 AM | MARKET OPEN | `refreshFast()` — Fetches Bollinger, MA crossover, pairs trading, trending, flights signals. First trade cycle begins. |
| 9:30 AM - 4:00 PM | MARKET HOURS | Every 5 min: `runTradeCycle()`. Every 30 min: `refreshFast()`. |
| 4:00 PM | AFTER-HOURS | `refreshSlow()`, `placeOvernightTrailingStops()`, `runCalibration()`, `generateSummary()`, `generateForecast()`. |
| 4:00 PM - 5:00 PM | AFTER-HOURS | Idle after after-hours tasks complete. |
| 5:00 PM - 12:00 AM | CLOSED | Idle. |
| Saturday - Sunday | WEEKEND | Completely idle. |

**Market hours detection** uses minutes-from-midnight in ET:
- Pre-market: 480-570 minutes (8:00-9:30 AM)
- Market hours: 570-960 minutes (9:30 AM-4:00 PM)
- After-hours: 960-1020 minutes (4:00-5:00 PM)

**Daily flag reset:** When the ET date changes, all daily flags (preMarketDone, marketOpenDone, afterHoursDone) are reset.

**Mid-day startup:** If the scheduler starts while the market is already open, it immediately seeds the slow cache and begins normal operations.

**Note:** No holiday calendar is implemented. The system runs on weekdays regardless of market holidays, but Alpaca will reject orders on holidays so no harm is done.

---

## Signal Sources — Monitors (Alt-Data)

All monitors are in the `monitors/` directory. Each exports a `getSignals()` function returning an array of signal objects:

```javascript
{ ticker: string, direction: 'bullish'|'bearish', score: number, reason: string }
```

### Congressional Trading Monitor

**File:** `monitors/congress.js` (52 lines)
**API:** QuiverQuant `/beta/live/housetrading` + `/beta/live/senatetrading`
**Cache tier:** SLOW (refreshed at 8 AM + 4 PM)
**Classification:** Overlay source (cannot trigger buys alone)

Monitors US congressional stock purchases filed via STOCK Act disclosures.

**Filters:**
- Transaction type: Purchase only (ignores sales)
- Minimum amount: $1,000
- Recency: Within 30 days

**Scoring:**
- Base score: `min(40, log10(amount) * 8)`
- High-conviction representative bonus: +35 points (max 80 total)

**High-conviction representatives:** Nancy Pelosi, Paul Pelosi, Markwayne Mullin, Tommy Tuberville, Dan Crenshaw, Josh Gottheimer, Michael McCaul, Gilbert Cisneros.

**Deduplication:** Tracks seen trades in `trade_history/congress_seen.json` using composite key: `{Representative}-{Ticker}-{Date}-{Transaction}`. Persists across restarts.

---

### Dark Pool / Off-Exchange Monitor

**File:** `monitors/offexchange.js` (21 lines)
**API:** QuiverQuant `/beta/historical/offexchange/{ticker}`
**Cache tier:** On-demand (called only for top 25 candidates after initial aggregation)
**Classification:** Overlay source

Analyzes dark pool short volume percentage to detect institutional accumulation or distribution.

**Scoring:**
- Bullish (short % <= 30%): `score = (30 - shortPct) / 30 * 40` (accumulation detected)
- Bearish (short % >= 60%): `score = (shortPct - 60) / 40 * 40` (distribution detected)
- Neutral (30-60%): No signal generated

**Note:** Only queried for the top 25 candidates to conserve API calls. Uses the per-ticker historical endpoint (the bulk live endpoint returns 500 errors).

---

### Government Contracts Monitor

**File:** `monitors/govcontracts.js` (24 lines)
**API:** QuiverQuant `/beta/live/govcontractsall`
**Cache tier:** SLOW
**Classification:** Overlay source

Detects companies receiving significant government contract awards.

**Filters:**
- Minimum value: $50,000
- Recency: Within 7 days

**Scoring:** `min(65, log10(value / 1000) * 18)`

**Deduplication:** In-memory Set (resets on restart).

---

### Lobbying Spend Monitor

**File:** `monitors/lobbying.js` (34 lines)
**API:** QuiverQuant `/beta/live/lobbying`
**Cache tier:** SLOW
**Classification:** Overlay source

Aggregates corporate lobbying registrations by ticker to detect companies investing heavily in political influence.

**Filters:**
- Minimum spend per entry: $20,000
- Recency: Within 30 days

**Aggregation:** Groups by ticker, sums total spend across registrants, extracts top lobbying issues.

**Scoring:** `min(55, log10(totalAmount) * 14)`

**Deduplication:** Composite key: `{ticker}-{amount}-{date}-{registrant}`

---

### Executive Flight Tracker

**File:** `monitors/flights.js` (33 lines)
**API:** QuiverQuant `/beta/live/flights`
**Cache tier:** FAST (refreshed every 30 min)
**Classification:** Overlay source

Tracks corporate jet flights. Flights to "deal cities" suggest M&A or partnership activity.

**Deal cities:** New York, Manhattan, San Francisco, London, Chicago, Boston, Washington

**Scoring:**
- Flight to deal city: +15 points per flight
- Other flights: +5 points per flight
- Maximum score: 60

---

### Trending / Retail Sentiment Monitor

**File:** `monitors/trending.js` (30 lines)
**API:** QuiverQuant `/beta/mobile/trendingtickers` + `/beta/mobile/currentmostpopulartickers`
**Cache tier:** FAST
**Classification:** Overlay source

Combines trending and popularity scores from retail trading platforms.

**Scoring:**
- Trending score: `min(30, value * 3)`
- Popular score: `min(25, value * 2)`
- Combined: `min(50, trending + popular)`
- Minimum threshold: Combined score >= 15

---

### Tech Sector Macro Monitor

**File:** `monitors/techsector.js` (110 lines)
**API:** Alpha Vantage `/query?function=SECTOR`
**Cache tier:** SLOW (1 API call per day, cached by date)
**Classification:** Primary source (can contribute to technical confirmation)

Monitors the Information Technology sector's daily performance relative to the overall market average.

**Logic:**
- Fetches 1-day, 5-day, and 1-month IT sector performance
- Calculates relative performance: IT sector return minus average of all sector returns
- **Bullish regime** (IT 1D >= +0.5% OR relative >= +0.75%): Broadcasts bullish signal to all 50+ tech universe tickers. Score: `min(40, 10 + abs(it1d) * 8 + abs(relative) * 5)`
- **Bearish regime** (IT 1D <= -1.0% OR relative <= -1.0%): Broadcasts bearish signal. Score: `min(35, 10 + abs(it1d) * 5)`
- **Neutral**: No signals generated

**Tech universe:** 50+ tickers including AAPL, MSFT, NVDA, META, GOOGL, AMD, QCOM, CRM, NOW, SNOW, PLTR, PANW, CRWD, etc.

---

### Earnings Guard

**File:** `monitors/earnings_guard.js` (68 lines)
**API:** Alpha Vantage `/query?function=EARNINGS_CALENDAR&horizon=3month`
**Not a signal source — this is a risk filter used by the engine.**

Downloads the full earnings calendar (CSV format) once per day. Returns a Set of tickers reporting earnings within the next 5 days. The engine uses this to block buys before earnings announcements.

**Block window:** 5 calendar days

---

## Signal Sources — Strategies (Technical)

All strategies are in the `strategies/` directory. Each exports `getSignals()`.

### Bollinger Band Reversal

**File:** `strategies/bollinger.js` (29 lines)
**Data:** Alpaca daily bars (60-day lookback)
**Cache tier:** FAST
**Classification:** Primary source

Detects oversold bounce setups using Bollinger Bands + RSI + VIX gating.

**Activation gate:** VIX must be >= 20 (high-volatility environment). Strategy is completely idle when VIX < 20.

**Entry conditions (all must be true):**
- Price below lower Bollinger Band (20-period SMA - 2 standard deviations)
- RSI(14) below 35
- Band width >= 5% of midpoint (filters out low-volatility consolidation)

**Scoring:** `min(85, distance_below_band * 8 + min(20, (VIX - 20) * 0.8))`

**Universe:** Full S&P 500+ universe (500+ tickers)

---

### Golden Cross (MA Crossover)

**File:** `strategies/ma_crossover.js` (30 lines)
**Data:** Alpaca daily bars (220-day lookback)
**Cache tier:** FAST
**Classification:** Primary source

Detects golden cross events (50-day SMA crossing above 200-day SMA) with volume confirmation.

**Entry conditions (all must be true):**
- 50-day SMA crossed above 200-day SMA within the last 5 trading days
- Current price above 200-day SMA
- Today's volume >= 1.5x the 20-day average volume

**Scoring:** `min(80, 40 + (6 - daysAgo) * 5 + min(20, (volRatio - 1) * 15))`

Fresher crosses score higher (1-day-old cross: +25 base vs 5-day-old: +5). Higher volume ratios add confirmation bonus.

---

### Pairs Trading (Statistical Arbitrage)

**File:** `strategies/pairs_trading.js` (36 lines)
**Data:** Alpaca daily bars (70-day lookback)
**Cache tier:** FAST
**Classification:** Primary source

Detects mean-reversion opportunities in cointegrated stock pairs using z-score analysis.

**Pair universe (19 pairs):**
MSFT/GOOGL, AMD/NVDA, META/SNAP, ORCL/CRM, QCOM/AVGO, JPM/BAC, GS/MS, C/WFC, XOM/CVX, COP/OXY, SLB/HAL, PFE/MRK, JNJ/ABT, UNH/CVS, WMT/TGT, HD/LOW, AMZN/COST, GM/F, TSLA/RIVN

**Entry conditions:**
- Returns correlation between pair >= 0.70
- Absolute z-score of log-price spread >= 2.0

**Signal direction:**
- z-score > 2.0: Stock B is undervalued relative to A, buy B
- z-score < -2.0: Stock A is undervalued relative to B, buy A

**Scoring:** `min(75, abs(zScore) * 20)`

---

### Insider Buying Cluster

**File:** `strategies/insider_buying.js` (41 lines)
**API:** QuiverQuant `/beta/live/insiders` (falls back to `/beta/live/congresstrading`)
**Cache tier:** SLOW
**Classification:** Primary source

Detects coordinated insider purchasing — multiple distinct buyers purchasing the same ticker within 90 days.

**Filters:**
- Transaction type: Buy/Purchase only
- Minimum amount: $5,000 per transaction
- Lookback window: 90 days
- Minimum unique buyers: 2

**Scoring:**
- Base: `min(80, 35 + numBuyers * 15)`
- Cluster bonus: If 2+ buys within last 30 days, add +15 (max 90)

**Fallback:** If the insiders endpoint returns 403 (paid tier required), falls back to congressional trading data using the same cluster detection logic.

---

### Downtrend Reversal

**File:** `strategies/downtrend.js` (50 lines)
**Data:** Alpaca daily bars (100-day lookback)
**Cache tier:** SLOW
**Classification:** Primary source

Detects potential reversal setups after extended downtrends, optionally confirmed by RSI bullish divergence.

**Entry conditions (all must be true):**
- 15+ consecutive days of closing below the 20-day SMA
- RSI(14) <= 35 (deeply oversold)

**RSI bullish divergence detection:**
Scans the last 20 bars for two price lows. If the later low is lower than the earlier low but the RSI at the later low is higher than at the earlier low, this indicates bullish divergence (momentum is strengthening while price is still falling).

**Scoring:**
- Base: `min(50, 20 + downtrendDays)`
- Divergence bonus: +25 (max 80)

---

### Monte Carlo Risk Assessment

**File:** `strategies/montecarlo.js` (65 lines)
**Data:** Alpaca daily bars (252-day lookback)
**Not a signal source — this is a risk gate used by the engine.**

Runs 2,000 Monte Carlo simulations over a 30-day horizon for each buy candidate to assess position-level risk.

**Simulation method:**
1. Extract daily returns from 252 days of history
2. Calculate mean and standard deviation of returns
3. For each of 2,000 simulations, generate 30 days of random returns using `mean + stddev * Z` where Z is a standard normal random variable
4. Track portfolio value path, max drawdown, and ruin events (>50% loss)

**Risk decision:**
- Ruin probability > 5%: **BLOCK** trade entirely
- Max drawdown at 95th percentile > 30%: **BLOCK** trade entirely
- Annualized volatility > 80%: **APPROVE** but cap position at 3% of equity
- Annualized volatility > 50%: **APPROVE** but cap position at 5% of equity
- Otherwise: **APPROVE** at full position size (8%)

The engine respects the `maxPct` output — it uses `min(POSITION_PCT, risk.maxPct / 100)` for position sizing.

---

## Signal Aggregation & Scoring

**File:** `signals.js` (94 lines)

### Source Classification

Signals are classified into two categories:

**Primary sources** (can trigger a buy on their own):
`bollinger`, `ma_crossover`, `pairs_trading`, `downtrend`, `insider_buying`, `techsector`

**Overlay sources** (can only boost tickers that already have a primary signal):
`congress`, `govcontracts`, `lobbying`, `flights`, `trending`, `offexchange`

### Adaptive Weights

Weights are loaded from the Strategy Calibrator at runtime. Baseline weights:

| Source | Baseline Weight | Category |
|--------|----------------|----------|
| congress | 1.50 | Overlay |
| insider_buying | 1.40 | Primary |
| offexchange | 1.30 | Overlay |
| ma_crossover | 1.20 | Primary |
| downtrend | 1.10 | Primary |
| bollinger | 1.10 | Primary |
| govcontracts | 1.00 | Overlay |
| pairs_trading | 1.00 | Primary |
| techsector | 0.90 | Primary |
| lobbying | 0.80 | Overlay |
| flights | 0.70 | Overlay |
| trending | 0.60 | Overlay |

### Aggregation Formula

For each ticker across all signals:

1. **Primary score:** Sum of `weight * score` for all primary bullish signals
2. **Overlay score:** Sum of `weight * score` for all overlay bullish signals
3. **Bearish score:** Sum of `weight * score` for all bearish signals (any source)

**Overlay capping:**
- If the ticker has at least one primary signal: overlay is capped at 25 points maximum
- If the ticker has NO primary signal: overlay is reduced to 10% (effectively useless)

This prevents congress/lobbying trades from triggering buys without technical confirmation.

**Net score:** `min(100, max(0, round(primaryScore + cappedOverlay - bearishScore)))`

Candidates are ranked by net score descending. Only those scoring >= 65 are passed to the engine as buy candidates.

### Staleness Filtering

**File:** `signal_cache.js`

Every signal carries a `_generatedAt` timestamp. Before aggregation, stale signals are dropped:
- Technical (FAST) signals: expire after **2 hours**
- Alt-data (SLOW) signals: expire after **24 hours**

---

## Signal Lifecycle State Machine

**File:** `signal_lifecycle.js` (171 lines)

Every buy candidate passes through a strict state machine with audit logging:

```
GENERATED
|-- CONFIRMED (has at least one primary/technical signal)
|   |-- APPROVED (passed all risk gates)
|   |   '-- EXECUTED (buy order placed successfully)
|   |-- REJECTED_RISK (Monte Carlo failed)
|   |-- REJECTED_GOVERNOR (drawdown/sector/cap/liquidity/correlation)
|   '-- REJECTED_EARNINGS (earnings within 5 days)
|-- REJECTED_STALE (signal too old)
|-- REJECTED_DUPLICATE (already held or pending)
'-- REJECTED_UNCONFIRMED (no primary technical signal)
```

**Audit trail:** Every state transition is appended to `trade_history/signal_transitions.jsonl` with: signal ID, ticker, source, score, from-state, to-state, reason, timestamp.

**Cycle log:** End-of-cycle summaries are appended to `trade_history/cycle_log.jsonl` with: timestamp, equity, position count, total signals, confirmed count, executed count, rejected count, rejection breakdown by type.

**Rejection histogram:** Printed at the end of each cycle:
```
[Lifecycle] Rejections: unconfirmed:12, governor:3, risk:1, earnings:2
```

---

## Risk Management — Governor

**File:** `governor.js` (330 lines)

The Governor is the portfolio-level risk manager. It evaluates 5 checks before approving any trade. All checks must pass.

### Check 1: Drawdown Circuit Breaker

Tracks peak equity across the lifetime of the system. If current equity drops 8% or more below the peak, ALL new buys are halted. Only stop management continues.

```
drawdownPct = (peakEquity - currentEquity) / peakEquity * 100
if drawdownPct >= 8: KILL all new buys
```

Auto-recovers when equity recovers above the threshold.

**Persistence:** Peak equity and daily trade counts are saved to `trade_history/governor_state.json`.

### Check 2: Daily Trade Cap

Maximum 6 new buy orders per calendar day. Prevents overtrading and excessive commission exposure.

Resets at midnight ET each day.

### Check 3: Sector Concentration

No single sector may exceed 25% of portfolio equity. Before placing a buy, the governor calculates what the sector allocation would be after the new position and blocks if it would breach the limit.

**Sector mapping:** Hardcoded classification for 200+ tickers across 10 sectors: Tech, Financials, Healthcare, Consumer, Auto, Industrials, Energy, Communications, REITs, Utilities, Materials. Unknown tickers default to "Other."

### Check 4: Liquidity Filter

Calculates 20-day average daily dollar volume (`avg_volume * avg_price`). Blocks buys on stocks with less than $1,000,000 average daily dollar volume. Prevents illiquid fills with wide bid-ask spreads.

### Check 5: Correlation Check

Computes the 60-day Pearson correlation between the candidate ticker and every existing position. If 3 or more existing positions have correlation >= 0.70 with the new ticker, the buy is blocked. Prevents loading up on stocks that all move together.

**Performance note:** This check only runs if the first 4 checks pass (avoids expensive correlation computation on already-rejected candidates).

### Stop Order Reconciliation

Every trade cycle, the governor cross-checks all open positions against all open sell orders on Alpaca. If any position lacks a trailing stop or stop order, the governor automatically re-places a 4% trailing stop. Logs the result:

```
[Governor] All 10 positions have stop orders
// or
[Governor] UNPROTECTED positions (no stop order): AAPL, MSFT
[Governor] Re-placed trailing stop for AAPL
```

---

## Risk Management — Monte Carlo Gate

**File:** `strategies/montecarlo.js` (65 lines)

See [Monte Carlo Risk Assessment](#monte-carlo-risk-assessment) in the Strategies section above. The key output is `{ safe: boolean, maxPct: number, reason: string }` which the engine uses to:

1. Block the trade entirely if unsafe
2. Cap position size below the default 8% for high-volatility stocks

---

## Execution & Position Management

**File:** `engine.js` (272 lines)

### Position Sizing

Position size is calculated dynamically:

```javascript
effectivePct = min(POSITION_PCT, riskMaxPct / 100)  // Use Monte Carlo cap if tighter
qty = floor((equity * effectivePct) / currentPrice)
qty = max(1, qty)  // Always at least 1 share
```

Default: 8% of equity per position (~$8,000 on a $100k account). Monte Carlo can reduce this to 5% or 3% for high-volatility stocks.

### Buy Execution

Market orders with `time_in_force: 'day'`. No limit orders are used (simplicity over precision for paper trading).

After a successful buy:
- Trade is logged to CSV and JSON via `logger.js`
- Daily trade counter is incremented via governor
- Trailing stop is placed on the next cycle (or overnight if opened same day)

### Sell Triggers (3 exit types)

**Profit Target (+7%):** If unrealized P&L percentage >= 7%, the entire position is sold at market. Logged as "Profit target."

**Hard Stop (-6%):** If unrealized P&L percentage <= -6%, the entire position is sold at market. The ticker is added to the 24-hour cooldown list. Logged as "Hard stop."

**Trailing Stop (4%):** Alpaca-native GTC trailing stop orders ratchet up automatically as price rises. If price drops 4% from the high water mark, Alpaca fills the stop order. Detected by the engine as a filled closed order.

### PDT Protection

Positions opened on the current day do not get trailing stops placed during market hours. Instead, trailing stops are placed during the after-hours cycle (`placeOvernightTrailingStops()`) after market close. This avoids same-day buy-sell pairs that would count as day trades.

### Cooldown

After a stop-out (trailing stop or hard stop fills), the ticker is quarantined for 24 hours. The engine will not re-buy the ticker during this period. Cooldown state is persisted in `trade_history/engine_state.json`.

---

## Strategy Calibrator — Adaptive Feedback Loop

**File:** `strategy_calibrator.js` (332 lines)

Runs once daily during the after-hours cycle. Reads the complete postmortem performance ledger and adjusts the system's behavior.

### Adaptive Weight Adjustment

For each signal source with 5+ closed trades, the calibrator recalculates its weight:

```
winRate = wins / totalTrades
avgPnl = sum(pnlPct) / totalTrades

wrFactor = 0.4 + winRate * 1.2          // Range: 0.4 (0% WR) to 1.6 (100% WR)
pnlFactor = max(0.5, min(1.5, 1 + avgPnl / 10))  // P&L scaling
multiplier = max(0.3, min(2.0, wrFactor * pnlFactor))

adjustedWeight = baseWeight * multiplier
```

Example: A strategy with 70% win rate and +2% avg P&L gets a ~1.37x boost. A strategy with 30% win rate and -2% avg P&L gets a ~0.56x penalty.

These adjusted weights are loaded by `signals.js` at runtime via `getLiveWeights()`.

### Strategy Kill Switch

A strategy is killed (disabled) when BOTH conditions are met:
- 5 or more consecutive losses
- Rolling win rate below 30%

The dual condition prevents false kills from normal losing streaks. A strategy with 50% win rate won't be killed even with 5 consecutive losses.

Killed strategies are persisted in `trade_history/calibration.json`. The engine checks `isStrategyKilled(source)` before every buy.

### Exit Analysis

Analyzes which exit types are working:
- If hard stops average worse than -4%: suggests widening stop or tighter entry
- If trailing stops average positive: confirms trail is capturing gains
- If trailing stops average negative: suggests trail may be too tight
- If profit targets are hitting frequently: confirms target is well-calibrated

### Daily Lessons Report

Generates a human-readable section included in the daily forecast:
- Strategy weight changes with direction arrows
- Top 3 winners and worst 3 losers with full details
- Exit analysis insights
- Overall system health status (healthy >= 55% WR, acceptable 40-55%, underperforming < 40%)

### Calibration History

Maintains a 90-day rolling history in `trade_history/calibration.json` with daily snapshots of: trade count, win rate, adjusted weights, kills.

---

## Postmortem Analyzer

**File:** `postmortem.js` (215 lines)

Runs every trade cycle to detect newly closed positions. For each closed trade, creates a complete postmortem record.

### Trade Record Fields

```javascript
{
  symbol,              // Ticker symbol
  entryPrice,          // Average fill price on buy
  exitPrice,           // Average fill price on sell
  qty,                 // Shares traded
  pnlPct,             // Percentage return
  pnlDollar,          // Dollar return
  isWin,              // true if pnlPct > 0
  exitReason,         // 'trailing_stop' | 'hard_stop' | 'profit_target' | 'unknown'
  holdingHours,       // Duration from entry to exit in hours
  sources,            // Array of signal sources that triggered the buy
  buyReason,          // Original engine reason string
  entryTime,          // ISO timestamp of buy fill
  exitTime,           // ISO timestamp of sell fill
  orderId             // Alpaca sell order ID
}
```

### Exit Reason Detection

- Order type `trailing_stop`: "trailing_stop"
- Order type `stop`: "hard_stop"
- Order type `market`: Check the matching trade JSON file for engine_reason containing "Profit target" or "Hard stop"

### Performance Summary

Updated after every new postmortem record. Contains:
- Total trades, wins, losses, win rate
- Total P&L dollar, average P&L percentage
- Average holding time in hours
- Profit factor (gross wins / abs(gross losses))
- Maximum consecutive losses and current loss streak
- Recent win rate (last 10 trades)
- Exit reason breakdown (count per type)
- Per-source performance (wins, losses, total P&L for each signal source)

### Persistence

- `trade_history/performance_ledger.json`: Array of all postmortem records + known order IDs
- `trade_history/performance_summary.json`: Rolling aggregate metrics

---

## Performance Tracker

**File:** `performance_tracker.js` (150 lines)

Records end-of-day equity snapshots and computes portfolio-level performance metrics.

### Daily Snapshot

Called at the end of `generateSummary()`. Records: date, equity, position count, day's buys, day's sells.

**Persistence:** `trade_history/equity_curve.json`

### Metrics (require 2+ trading days)

- **Total Return:** (endEquity - startEquity) / startEquity
- **Max Drawdown:** Largest peak-to-trough decline across all snapshots
- **Sharpe Ratio:** (mean daily return / stddev daily return) * sqrt(252). Requires 5+ days.
- **Best/Worst Day:** Maximum and minimum single-day returns
- **Win Days / Loss Days:** Count of positive vs negative return days

---

## Daily Summary & Forecast Reports

### Daily Summary

**File:** `daily_summary.js` (145 lines)
**Output:** `C:\Users\Matth\OneDrive\TradingSummaries\summary_YYYY-MM-DD.txt`
**Trigger:** After-hours cycle at 4 PM ET

Sections:
1. **Account** — Equity, buying power, day P&L ($ and %)
2. **Buys Today** — Symbol, qty, fill price, total, engine reason (why the buy was triggered)
3. **Sells Today** — Symbol, qty, fill price, exit type
4. **Open Positions** — Symbol, qty, entry, current, unrealized P&L ($, %), total
5. **Activity Summary** — Filled orders, buy/sell counts
6. **Performance Tracker** — Equity curve metrics (return, Sharpe, drawdown)
7. **Trade Performance** — Win rate, profit factor, per-source stats

### Daily Forecast

**File:** `daily_forecast.js` (305 lines)
**Output:** `C:\Users\Matth\OneDrive\TradingSummaries\forecast_YYYY-MM-DD.txt`
**Trigger:** After-hours cycle at 4 PM ET (runs after summary)

Sections:
1. **Market Conditions** — VIX level with risk label (LOW/ELEVATED/HIGH FEAR)
2. **Position Outlooks** — Each position assessed technically:
   - BULLISH: Above both 20/50 MAs, normal RSI
   - BEARISH: Below both 20/50 MAs
   - CAUTION: RSI > 70 or above upper Bollinger Band
   - WATCH: RSI < 35 or below lower Bollinger Band
   - MIXED: Split MA signals
   - Bollinger Band position (% of range)
   - Earnings date if within 14 days (via Yahoo Finance)
3. **Action Flags** — Positions in CAUTION/BEARISH/WATCH states
4. **Earnings Watch** — All positions with earnings within 14 days
5. **Top Buy Candidates** — Top 5 from signal cache for next day
6. **Calibration Lessons** — Weight adjustments, kills, winners, losers, exit insights
7. **Performance Tracker** — Same metrics as summary
8. **Strategy Notes** — Active parameters, VIX status, next refresh times

---

## Data Layer

### Price Data & Technical Indicators

**File:** `data/prices.js` (88 lines)

Fetches OHLCV daily bars from Alpaca's market data API with a 15-minute in-memory cache.

**API endpoint:** `https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=1Day&start={date}&limit={days}&feed=iex`

**Cache:** In-memory Map keyed by `{symbol}:{days}` with 15-minute TTL.

**Technical indicators provided:**
- `sma(array, period)` — Simple moving average
- `stddev(array, period)` — Standard deviation
- `rsi(closes, period=14)` — Relative Strength Index (Wilder's method)
- `bollingerBands(closes, period=20, mult=2)` — Returns `{ upper, mid, lower, std }`
- `correlation(a, b)` — Pearson correlation coefficient
- `returns(closes)` — Daily percentage returns

**VIX:** Fetched from Yahoo Finance: `https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d`

### Stock Universe

**File:** `data/universe.js` (59 lines)

Static array of 380+ tickers deduplicated via Set. Covers:
- Technology (60+): AAPL, MSFT, NVDA, META, GOOGL, AMD, QCOM, CRM, SNOW, PLTR, PANW, CRWD, etc.
- Financials (40+): JPM, BAC, GS, V, MA, PYPL, COIN, SOFI, etc.
- Healthcare (50+): UNH, LLY, JNJ, ABBV, MRK, PFE, ABT, MCK, CAH, etc.
- Consumer (40+): HD, LOW, WMT, COST, MCD, NKE, TGT, etc.
- Industrials (40+): BA, CAT, GE, HON, RTX, LMT, UPS, FDX, etc.
- Energy (25+): XOM, CVX, COP, EOG, MPC, OXY, SLB, HAL, etc.
- Communications (15+): NFLX, DIS, T, VZ, TMUS, SPOT, SNAP, etc.
- REITs/Utilities/Materials (30+): AMT, PLD, NEE, LIN, FCX, NUE, etc.
- ETFs (20+): SPY, QQQ, IWM, DIA, XLK, XLF, XLE, XLV, GLD, TLT, ARKK, etc.

All strategies (Bollinger, MA crossover, downtrend) scan this full universe via `require('../data/universe')`.

### Quiver API Wrapper

**File:** `monitors/quiver.js` (21 lines)

Simple fetch wrapper for QuiverQuant API. Adds Bearer token authentication. Throws on non-200 responses.

```javascript
async function quiver(endpoint) {
  const res = await fetch(BASE + endpoint, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Quiver ${endpoint} -> ${res.status}`);
  return res.json();
}
```

---

## API Integrations

### Alpaca Paper Trading

**Base URL:** `https://paper-api.alpaca.markets`
**Auth:** Headers `APCA-API-KEY-ID` + `APCA-API-SECRET-KEY`

**Endpoints used:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/account` | GET | Equity, buying power, trading status |
| `/v2/positions` | GET | Open positions with P&L |
| `/v2/orders?status=open` | GET | Open buy/sell orders |
| `/v2/orders?status=closed&limit=50` | GET | Closed orders (stop-outs, fills) |
| `/v2/orders?status=closed&after={date}` | GET | Today's closed orders (for summary) |
| `/v2/orders?status=all&limit=50` | GET | All recent orders |
| `/v2/orders` | POST | Place buy, trailing stop, hard stop, profit take |

**Market Data Base URL:** `https://data.alpaca.markets/v2`
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/stocks/{symbol}/bars` | GET | Daily OHLCV bars |

### QuiverQuant

**Base URL:** `https://api.quiverquant.com`
**Auth:** Bearer token in Authorization header

**Endpoints used:**
| Endpoint | Purpose |
|----------|---------|
| `/beta/live/housetrading` | House representative trades |
| `/beta/live/senatetrading` | Senate trades |
| `/beta/live/govcontractsall` | Government contracts |
| `/beta/live/lobbying` | Lobbying registrations |
| `/beta/live/flights` | Executive jet flights |
| `/beta/live/insiders` | Insider trades (may require paid tier) |
| `/beta/live/congresstrading` | Congressional trades (fallback for insiders) |
| `/beta/mobile/trendingtickers` | Trending tickers |
| `/beta/mobile/currentmostpopulartickers` | Popular tickers |
| `/beta/historical/offexchange/{ticker}` | Dark pool short volume |

### Alpha Vantage

**Base URL:** `https://www.alphavantage.co/query`
**Auth:** `apikey` query parameter
**Free tier:** 25 requests/day (system uses 2/day)

**Endpoints used:**
| Endpoint | Purpose |
|----------|---------|
| `?function=SECTOR` | Sector performance data |
| `?function=EARNINGS_CALENDAR&horizon=3month` | Earnings calendar (CSV) |

### Yahoo Finance

**Used for:** VIX data only
**Endpoint:** `https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d`
**Also used in forecast for earnings dates:** `https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}?modules=calendarEvents`

---

## File Persistence & State Management

All persistent state is stored as JSON files in the `trade_history/` directory:

| File | Purpose | Updated |
|------|---------|---------|
| `engine_state.json` | Stopped-out tickers + cooldown timestamps | Every trade cycle |
| `governor_state.json` | Peak equity, daily trade counts | Every trade cycle |
| `congress_seen.json` | Congressional trade deduplication set | On each congress refresh |
| `performance_ledger.json` | All closed trade postmortem records | On each trade close |
| `performance_summary.json` | Rolling performance metrics | On each trade close |
| `calibration.json` | Adaptive weights, killed strategies, 90-day history | Daily at 4 PM |
| `equity_curve.json` | Daily equity snapshots | Daily at 4 PM |
| `signal_transitions.jsonl` | Audit trail of signal state changes | Every trade cycle |
| `cycle_log.jsonl` | End-of-cycle summaries | Every trade cycle |
| `trade_history.csv` | CSV log of all order placements | On each order |
| `{date}_{symbol}_{side}_{id}.json` | Individual trade JSON files | On each order |

**Output files (OneDrive):**

| File | Purpose |
|------|---------|
| `C:\Users\Matth\OneDrive\TradingSummaries\summary_YYYY-MM-DD.txt` | Daily trading summary |
| `C:\Users\Matth\OneDrive\TradingSummaries\forecast_YYYY-MM-DD.txt` | Next-day forecast |

---

## Module Reference

| Module | Lines | Purpose |
|--------|-------|---------|
| `scheduler.js` | 121 | Main orchestrator — timing, dispatching, git backup |
| `engine.js` | 272 | Trade execution — buy/sell/stop management, lifecycle |
| `governor.js` | 330 | Portfolio risk — drawdown, sector, cap, liquidity, correlation |
| `signal_cache.js` | 128 | Signal caching — slow/fast tiers, staleness, health monitoring |
| `signals.js` | 94 | Signal aggregation — primary/overlay, adaptive weights |
| `signal_lifecycle.js` | 171 | State machine — GENERATED through EXECUTED with audit trail |
| `strategy_calibrator.js` | 332 | Adaptive feedback — weight adjustment, kills, lessons |
| `postmortem.js` | 215 | Trade analysis — P&L, exit type, source attribution |
| `performance_tracker.js` | 150 | Equity curve — Sharpe ratio, drawdown, win day rate |
| `daily_summary.js` | 145 | End-of-day report — buys, sells, positions, performance |
| `daily_forecast.js` | 305 | Next-day outlook — position assessment, candidates, lessons |
| `market_hours.js` | 42 | ET timezone utilities — market phase detection |
| `logger.js` | 32 | Trade logging — CSV + JSON per order |
| `data/prices.js` | 88 | Alpaca price data — bars, SMA, RSI, Bollinger, correlation |
| `data/universe.js` | 59 | Stock universe — 380+ S&P 500 + growth tickers |
| `monitors/quiver.js` | 21 | QuiverQuant API wrapper |
| `monitors/congress.js` | 52 | Congressional insider trading |
| `monitors/offexchange.js` | 21 | Dark pool short volume |
| `monitors/govcontracts.js` | 24 | Government contract awards |
| `monitors/lobbying.js` | 34 | Corporate lobbying spend |
| `monitors/flights.js` | 33 | Executive flight tracking |
| `monitors/trending.js` | 30 | Retail sentiment / trending |
| `monitors/techsector.js` | 110 | IT sector macro performance |
| `monitors/earnings_guard.js` | 68 | Earnings calendar block |
| `strategies/bollinger.js` | 29 | Bollinger band reversal |
| `strategies/ma_crossover.js` | 30 | Golden cross detection |
| `strategies/pairs_trading.js` | 36 | Statistical arbitrage |
| `strategies/insider_buying.js` | 41 | Insider buying clusters |
| `strategies/downtrend.js` | 50 | Downtrend reversal + divergence |
| `strategies/montecarlo.js` | 65 | Monte Carlo risk simulation |

**Total:** ~2,970 lines across 30 modules. No external npm dependencies — uses only Node.js built-in modules (`fs`, `path`, `child_process`) and native `fetch()` (Node 18+).

---

## Complete Configuration Reference

| Parameter | Value | File | Purpose |
|-----------|-------|------|---------|
| `MAX_POSITIONS` | 12 | engine.js | Maximum concurrent positions |
| `POSITION_PCT` | 0.08 (8%) | engine.js | Equity allocation per position |
| `TRAIL_PERCENT` | 4% | engine.js | Trailing stop distance from peak |
| `HARD_STOP_PCT` | 6% | engine.js | Intraday hard stop loss limit |
| `COOLDOWN_HOURS` | 24 | engine.js | Post-stop-out quarantine period |
| `BUY_THRESHOLD` | 65 | engine.js | Minimum net score to trigger buy |
| `PROFIT_TARGET` | 7% | engine.js | Auto-sell at this gain |
| `MAX_DRAWDOWN_PCT` | 8% | governor.js | Kill all buys if drawdown exceeds |
| `MAX_SECTOR_PCT` | 25% | governor.js | Maximum sector concentration |
| `MAX_DAILY_TRADES` | 6 | governor.js | Maximum new buys per day |
| `MIN_DAILY_DOLLAR_VOL` | $1,000,000 | governor.js | Minimum liquidity |
| `MAX_CORRELATED` | 3 | governor.js | Max correlated positions allowed |
| `CORR_THRESHOLD` | 0.70 | governor.js | Correlation cutoff |
| `SLOW_MAX_AGE` | 24 hours | signal_cache.js | Alt-data signal expiry |
| `FAST_MAX_AGE` | 2 hours | signal_cache.js | Technical signal expiry |
| `API_FAILURE_THRESHOLD` | 15% | signal_cache.js | System kill trigger |
| `OVERLAY_CAP` | 25 | signals.js | Max alt-data score contribution |
| `CACHE_TTL` | 15 min | data/prices.js | Price data cache duration |
| `CONSECUTIVE_LOSS_KILL` | 5 | strategy_calibrator.js | Strategy kill trigger |
| `MIN_WIN_RATE_KILL` | 30% | strategy_calibrator.js | Strategy kill threshold |
| `MIN_TRADES_FOR_ADJUST` | 5 | strategy_calibrator.js | Minimum trades before calibration |
| `BLOCK_DAYS` | 5 | earnings_guard.js | Earnings avoidance window |
| `SIMS` | 2,000 | montecarlo.js | Monte Carlo simulation count |
| `HORIZON` | 30 days | montecarlo.js | Monte Carlo time horizon |
| `FAST_REFRESH_MS` | 30 min | scheduler.js | Technical signal refresh interval |
| `TRADE_EXEC_MS` | 5 min | scheduler.js | Trade execution interval |
| `MIN_AMOUNT` (congress) | $1,000 | congress.js | Min congressional trade size |
| `MAX_DAYS` (congress) | 30 | congress.js | Congressional trade recency |
| `MIN_VALUE` (contracts) | $50,000 | govcontracts.js | Min contract value |
| `MIN_AMOUNT` (lobbying) | $20,000 | lobbying.js | Min lobbying spend |
| `MIN_AMOUNT` (insider) | $5,000 | insider_buying.js | Min insider trade size |
| `MIN_UNIQUE_BUYERS` | 2 | insider_buying.js | Min insider cluster size |
| `VIX_THRESHOLD` | 20 | bollinger.js | VIX gate for Bollinger strategy |
| `RSI_OVERSOLD` | 35 | bollinger.js, downtrend.js | RSI entry threshold |
| `MIN_VOL_RATIO` | 1.5 | ma_crossover.js | Volume confirmation multiplier |
| `MIN_CORRELATION` | 0.70 | pairs_trading.js | Pairs cointegration threshold |
| `MIN_Z_SCORE` | 2.0 | pairs_trading.js | Spread deviation trigger |
| `MIN_DOWNTREND_DAYS` | 15 | downtrend.js | Minimum downtrend length |

---

## Dependency Graph

```
scheduler.js
+-- market_hours.js
+-- signal_cache.js
|   +-- monitors/congress.js --> monitors/quiver.js
|   +-- monitors/govcontracts.js --> monitors/quiver.js
|   +-- monitors/lobbying.js --> monitors/quiver.js
|   +-- monitors/flights.js --> monitors/quiver.js
|   +-- monitors/trending.js --> monitors/quiver.js
|   +-- monitors/techsector.js --> data/universe.js
|   +-- monitors/offexchange.js --> monitors/quiver.js
|   +-- strategies/bollinger.js --> data/prices.js, data/universe.js
|   +-- strategies/ma_crossover.js --> data/prices.js, data/universe.js
|   +-- strategies/pairs_trading.js --> data/prices.js
|   +-- strategies/insider_buying.js --> monitors/quiver.js
|   +-- strategies/downtrend.js --> data/prices.js, data/universe.js
|   +-- signals.js --> strategy_calibrator.js
+-- engine.js
|   +-- logger.js
|   +-- governor.js --> data/prices.js
|   +-- postmortem.js
|   +-- signal_lifecycle.js
|   +-- signal_cache.js (isSystemHealthy)
|   +-- strategy_calibrator.js (isStrategyKilled)
|   +-- monitors/earnings_guard.js
|   +-- strategies/montecarlo.js --> data/prices.js
+-- daily_summary.js --> performance_tracker.js
+-- daily_forecast.js
|   +-- data/prices.js
|   +-- strategy_calibrator.js (generateLessonsReport)
|   +-- performance_tracker.js
+-- strategy_calibrator.js
```

---

## Reconstruction Checklist

To recreate this system from scratch, implement in this order:

### Phase 1: Foundation
1. Create project directory and `.env` file with API credentials
2. `market_hours.js` — ET timezone utilities
3. `logger.js` — CSV + JSON trade logging
4. `data/prices.js` — Alpaca price data + technical indicators
5. `data/universe.js` — Stock ticker universe
6. `monitors/quiver.js` — QuiverQuant API wrapper

### Phase 2: Signal Sources
7. `monitors/congress.js` — Congressional trading
8. `monitors/govcontracts.js` — Government contracts
9. `monitors/lobbying.js` — Lobbying spend
10. `monitors/flights.js` — Executive flights
11. `monitors/trending.js` — Retail sentiment
12. `monitors/techsector.js` — Alpha Vantage sector data
13. `monitors/earnings_guard.js` — Earnings calendar
14. `monitors/offexchange.js` — Dark pool data
15. `strategies/bollinger.js` — Bollinger reversal
16. `strategies/ma_crossover.js` — Golden cross
17. `strategies/pairs_trading.js` — Statistical arbitrage
18. `strategies/insider_buying.js` — Insider clusters
19. `strategies/downtrend.js` — Downtrend reversal
20. `strategies/montecarlo.js` — Monte Carlo risk

### Phase 3: Signal Processing
21. `strategy_calibrator.js` — Adaptive weights + kills
22. `signals.js` — Aggregation with primary/overlay classification
23. `signal_cache.js` — Two-tier caching + health monitoring
24. `signal_lifecycle.js` — State machine + audit trail

### Phase 4: Risk & Execution
25. `governor.js` — Portfolio-level risk management
26. `postmortem.js` — Trade analysis
27. `performance_tracker.js` — Equity curve + metrics
28. `engine.js` — Trade execution (ties everything together)

### Phase 5: Reporting & Orchestration
29. `daily_summary.js` — End-of-day report
30. `daily_forecast.js` — Next-day outlook
31. `scheduler.js` — Master orchestrator

### Phase 6: Deployment
32. Set up `.gitignore` (exclude .env, trade_history/, node_modules/)
33. Initialize git repo, push to GitHub
34. Create Windows startup script (`TradingScheduler.vbs` in Startup folder)
35. Disable PC sleep via `powercfg /change standby-timeout-ac 0`
36. Create OneDrive TradingSummaries folder

---

## Git & Deployment

### GitHub Auto-Backup

On every scheduler startup, the system runs:
```bash
git add -A
git commit -m "Auto-backup YYYY-MM-DD"
git push origin master
```

Gracefully handles "nothing to commit" and logs git errors.

**Repository:** Private GitHub repo (`MattCaravella`)
**Git config:** `user.email = matthew.s.caravella@gmail.com`, `user.name = MattCaravella`

### Windows Auto-Start

**File:** `C:\Users\Matth\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\TradingScheduler.vbs`

```vbs
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\Matth\Desktop\Trading"
objShell.Run "cmd /c node scheduler.js >> scheduler.log 2>&1", 0, False
```

Runs silently on Windows login. No admin privileges required.

### Sleep Prevention

PC sleep is disabled to keep the scheduler running:
```powershell
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
```

Display/screensaver can still activate without affecting the scheduler.

### OneDrive Sync

Daily summary and forecast files are saved directly to `C:\Users\Matth\OneDrive\TradingSummaries\`. OneDrive automatically syncs these to the cloud, accessible from phone or any device.

### Manual Commands

Start scheduler:
```bash
cd C:\Users\Matth\Desktop\Trading && node scheduler.js
```

Run daily summary manually:
```bash
node daily_summary.js
```

Run forecast manually:
```bash
node daily_forecast.js
```

Check if scheduler is running:
```bash
tasklist /FI "IMAGENAME eq node.exe"
```

---

*This document reflects the system as of April 7, 2026. The system is running on Alpaca paper trading with $100,000 in simulated capital.*
