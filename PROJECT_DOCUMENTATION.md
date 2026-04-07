# Algorithmic Paper-Trading System — Complete Documentation

**Version:** 4.1 (Bootstrapping Phase)
**Platform:** Alpaca Paper Trading + QuiverQuant + FMP
**Last Updated:** April 7, 2026

---

## Table of Contents

1. [System Philosophy](#system-philosophy)
2. [Architecture Overview](#architecture-overview)
3. [Signal Lifecycle State Machine](#signal-lifecycle-state-machine)
4. [The Pipeline Cycle](#the-pipeline-cycle)
5. [Strategy Scouts](#strategy-scouts)
6. [Risk Gatekeepers](#risk-gatekeepers)
7. [Execution & Position Management](#execution--position-management)
8. [Data Layer](#data-layer)
9. [Bootstrapping Protocol](#bootstrapping-protocol)
10. [Shadow Evaluation System](#shadow-evaluation-system)
11. [Kill Criteria & Failsafes](#kill-criteria--failsafes)
12. [Portfolio-Level Limits](#portfolio-level-limits)
13. [MCP Server & Claude Desktop Integration](#mcp-server--claude-desktop-integration)
14. [Skills Library](#skills-library)
15. [Module Reference](#module-reference)
16. [Database Schema](#database-schema)
17. [Configuration](#configuration)
18. [Build Phases](#build-phases)

---

## System Philosophy

This system combines two complementary trading approaches to build a diversified edge:

**Swing Trading (Technical)** generates frequent, small wins by exploiting short-term mean reversion and trend pullback setups on liquid US equities. Signals are trade-ready and decay quickly (hours).

**Position Trading (Alt-Data)** takes fewer, high-conviction entries driven by insider purchasing clusters and congressional trading patterns. Signals are idea candidates that require confirmation and decay slowly (days).

The edge comes not just from signal generation but from the **exposure coach** — a portfolio-level arbitrator that allocates capital across strategies, adjusts for market regime, and halts all activity during hostile conditions. Every decision is logged, every trade gets a postmortem, and the system self-calibrates over time.

**Core Design Principles:**

1. One canonical Signal object everywhere — no format translation between components
2. One Portfolio State snapshot per cycle — recomputed from Alpaca as ground truth
3. Full audit trail on every state transition — signals, stops, sizing, closures
4. Priority ranking uses additive regime adjustments, not multiplicative (prevents compounding errors)
5. Alt-data generates "Idea Candidates" — never auto-executes without technical confirmation
6. Strict data caching in SQLite — never pull live data per-cycle when a cache is fresh
7. No confidence without calibration data — bootstrapping uses conservative defaults
8. Fallback behaviors defined for every component — degraded service beats no service

---

## Architecture Overview

```
                    ┌─────────────────────────────┐
                    │       EXTERNAL APIs          │
                    │  Alpaca · QuiverQuant · FMP  │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │     data_adapters.py         │
                    │  Cache-first fetch layer     │
                    │  Freshness scoring (0–1)     │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │     repository.py            │
                    │  ONLY module touching SQLite │
                    │  Enforces all invariants     │
                    └──────────┬──────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                      │
   ┌─────▼─────┐       ┌──────▼──────┐       ┌──────▼──────┐
   │  SCOUTS   │       │  PIPELINE   │       │   SKILLS    │
   │  Generate │       │  Orchestrate│       │  Analysis   │
   │  Signals  │       │  15-min loop│       │  for Claude │
   └─────┬─────┘       └──────┬──────┘       └─────────────┘
         │                     │
         │              ┌──────▼──────┐
         └──────────────►  SIGNAL     │
                        │  QUEUE      │
                        │  Rank + Eval│
                        └──────┬──────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
         ┌──────▼──────┐ ┌────▼────┐ ┌───────▼───────┐
         │  GOVERNOR   │ │GUARDIAN │ │   OPERATOR    │
         │  Regime +   │ │ Sizing +│ │   Alpaca      │
         │  Allocation │ │ Stress  │ │   Orders      │
         └─────────────┘ └─────────┘ └───────┬───────┘
                                             │
                                     ┌───────▼───────┐
                                     │  POSTMORTEM   │
                                     │  Performance  │
                                     │  Ledger       │
                                     └───────────────┘
```

The system runs on a 15-minute cycle during market hours (9:30 AM–4:00 PM ET). Each cycle refreshes portfolio state from Alpaca, runs all active strategy scouts, processes the signal queue through cascading risk gates, executes approved trades, and monitors open positions for stops, targets, and time exits. A premarket scan runs at 8:00–8:30 AM to warm data caches and pre-stage signals for market open.

---

## Signal Lifecycle State Machine

Every signal follows a strict state machine with validated transitions and a full audit trail. No state can be skipped, and every transition is logged with a timestamp, reason, source component, and optional portfolio snapshot.

```
GENERATED ──► CANDIDATE ──► CONFIRMED ──► APPROVED ──► EXECUTED ──► ACTIVE ──► CLOSED ──► POSTMORTEM_COMPLETE
                 │               │            │                                   │
                 │               │            ├──► REJECTED_RISK                  │
                 │               │            └──► REJECTED_REGIME                │
                 │               └──► REJECTED_CONFIRMATION                       │
                 └──► REJECTED_EXPIRED                                            │
                 └──► REJECTED_DUPLICATE                                          │
```

**Forward path:** A signal is generated by a Scout, auto-promoted to Candidate, confirmed (either automatically for trade-ready signals or via technical overlay for idea candidates), approved by Governor, sized and stress-tested by Guardian, executed via Alpaca, monitored as an active position, closed on stop/target/time, and finally analyzed in postmortem.

**Rejection states are terminal** — once rejected, a signal never re-enters the pipeline.

**Transition storage:** The `signal_transitions` table records every state change with: signal_id, from_state, to_state, reason, transition_source (governor/guardian/operator/queue/postmortem), portfolio_state_json snapshot, and timestamp.

---

## The Pipeline Cycle

The pipeline (`pipeline.py`) orchestrates one complete cycle via `run_cycle()`:

**Step 1 — Mode Check:** Auto-promotion from BOOTSTRAPPING to CALIBRATED if criteria are met (30+ closed trades per strategy, 60+ days regime-tagged data, 1+ regime transition observed).

**Step 2 — API Health Check:** Tests connectivity to Alpaca, QuiverQuant, and FMP. If failure rate exceeds 15%, triggers System Kill (no new entries, manage stops only).

**Step 3 — Portfolio State Refresh:** Fetches live account data from Alpaca (equity, positions, cash) and computes ground-truth portfolio state: net/gross exposure, drawdown from peak, kill state evaluation.

**Step 4 — Run Scouts:** Executes all active strategy scanners against the scan universe (~115 tickers from core universe + FMP most-actives + open positions). Each scout returns signals + rejection histogram + data source counts.

**Step 5 — Data Quality Assessment:** Flags cycles as "degraded" if more than 30% of ticker lookups fell back to secondary sources or more than 15% returned no data.

**Step 6 — Process Signal Queue:** Ranks all pending signals by priority score (confidence x freshness x decay x R:R boost), then evaluates each through Governor and Guardian. Applies daily trade cap and risk budget limits.

**Step 7 — Execute Approved Trades:** Sends ExecutionRequests to the Operator, which places orders via Alpaca, monitors fills, and places protective stop-loss orders.

**Step 8 — Monitor Active Positions:** Checks all ACTIVE positions for stop hits, target hits, and time stops. Reconciles stop orders on Alpaca (re-places any missing). Routes all closures through PostmortemAnalyzer.

**Step 9 — Run Postmortems:** Processes any stopped-out positions through the performance ledger with full metric computation (MFE, MAE, R-multiple, execution drift, holding duration).

**Step 10 — Log & Report:** Appends structured cycle data to `daily_cycle_log.jsonl` and returns a PipelineCycleResult with equity, exposure, rejection histograms, and data quality metrics.

---

## Strategy Scouts

### Mean Reversion Scanner

**File:** `scouts/mean_reversion.py`
**Family:** Technical | **Horizon:** Swing (2–10 days) | **Entry:** Limit at prior close
**Confirmation:** Trade-Ready (no manual confirmation needed)

Detects oversold bounce setups using a multi-factor filter:

- RSI(14) below 38 (adaptive via alt-data up to 42)
- Price below lower Bollinger Band (20-period, 2 standard deviations)
- Volume surge of 1.2x or more vs. 20-day average
- ADX above 20 (confirming directional environment for revert)

**Alt-data integration:** Insider open-market purchases relax the RSI threshold by +2.0 per distinct buyer (max +4.0). Insider clusters (3+ buyers) add +1.0 bonus. Congress purchases relax by +1.5 per transaction (max +3.0). Government contracts add +0.5 flat. Hard cap: effective RSI threshold never exceeds 42.

**Position sizing:** Stop at the lesser of 3x ATR below entry or 5-bar swing low. Target is the 20-day SMA (the "mean" to revert to). Includes a staleness guard that rejects signals if the latest trade price diverges more than 3% (or 1.5x ATR) from the bar close.

**Confidence:** 0.55–0.80 base, scaled by RSI depth, Bollinger Band depth, and volume strength, then adjusted by the alt-data overlay (up to +/- 0.15).

**Signal expiry:** 120 minutes, half-life 45 minutes (fast decay for intraday setups).

---

### Insider Cluster Detector

**File:** `scouts/insider_cluster.py`
**Family:** Alt-Data | **Horizon:** Position (2–8 weeks) | **Entry:** Market
**Confirmation:** Idea Candidate (requires technical overlay during bootstrapping)

Detects coordinated insider purchasing activity within a 14-day window:

- Filters to open-market purchases only (SEC Form 4: AcquiredDisposed=A, TransactionCode=P)
- Requires 3 or more distinct insiders buying within 14 days
- Minimum $50K transaction value per purchase
- Cluster scoring: 40% insider count + 25% time compression + 20% dollar value + 15% recency

**Cluster scoring breakdown:**
- Time compression: same-day purchases score 1.0, spread over 7 days scores ~0.5
- Recency: clusters from today score 1.0, from 7 days ago score 0.5
- Dollar value: $1.25M+ total scores 1.0, scaled linearly below
- Insider count: normalized against detection threshold

**Position sizing:** Entry at current market price. Stop 10% below entry. Target 15–25% above entry, scaled with cluster strength.

**Confidence:** 0.45–0.75 base, mapped from cluster overall score.

**Data source fallback:** Primary source is QuiverQuant /live/insiders (paid tier). Falls back to QuiverQuant /live/congresstrading (free tier) using the same cluster detection logic with adapted data format.

**Signal expiry:** 7,200 minutes (5 days), half-life 1,800 minutes (slow decay for position trades).

---

### Trend Pullback Scanner

**File:** `scouts/trend_pullback.py`
**Family:** Technical | **Horizon:** Swing (5–15 days) | **Entry:** Limit at 20-SMA or current price
**Confirmation:** Trade-Ready | **Shadow Mode:** Starts in shadow; promoted after statistical validation

Detects healthy pullbacks within established uptrends:

- Trend confirmed: 50-day SMA above 200-day SMA (golden cross)
- Price above 50-day SMA (participating in the trend)
- Pullback trigger: price within 1.5% of 20-day SMA
- ADX above 20 (directional trend strength)
- Volume at least 0.8x 20-day average (not a desert)
- RSI between 40 and 65 (healthy pullback zone)

**Regime gating:** Only activates in BROADENING or CONCENTRATION regimes. Skipped entirely in non-trending environments.

**Position sizing:** Stop at the lesser of 2x ATR below entry or 5-bar swing low (tighter than mean reversion). Target at prior 20-day swing high or SMA_50 + 2x ATR if the swing high is too close. Minimum R:R of 1.0.

**Confidence:** 0.55–0.75 base, scaled by trend strength (SMA spread), pullback quality (proximity to SMA), and ADX strength, then adjusted by alt-data overlay.

**Complementary design:** Mean reversion fires during selloffs (buy weakness). Trend pullback fires during uptrends (buy strength). Together they expand coverage across more market conditions.

**Shadow mode:** When shadow_mode=True, emits ShadowRecord objects (persisted to shadow_signals table, outside the main lifecycle state machine). The ShadowEvaluator later scores outcomes and decides when to promote the strategy to live execution.

---

### Alt-Data Confidence Overlay

**File:** `alt_data_overlay.py`

A cross-strategy intelligence layer that adjusts technical signal confidence based on alternative data. This is not a standalone signal generator — it modifies confidence scores for signals from other scouts.

**Overlay effects (additive):**
- Congress purchases in last 30 days: +0.04 per transaction (max +0.08)
- Congress sales in last 30 days: -0.02 per transaction (max -0.04)
- Insider open-market buys in last 14 days: +0.05 per distinct insider (max +0.10)
- Insider cluster (3+ buyers): +0.05 bonus on top
- Government contracts (current quarter): +0.02 catalyst flag

**Total overlay clamped to [-0.05, +0.15]** to prevent alt-data from overwhelming the primary technical signal.

---

## Risk Gatekeepers

### Governor — Regime & Allocation Gate

**File:** `governor.py`

The Governor is the portfolio-level safety layer that evaluates whether signals should proceed to risk sizing. It operates at the macro level, checking system health, regime alignment, and portfolio capacity.

**Evaluation order (highest precedence first):**

1. **Kill criteria check:** System Kill (API failures), Allocation Kill (drawdown), Regime Disagreement Kill, Signal Kill (strategy-specific consecutive losses)
2. **Exposure budget:** Is there room under the ceiling for a new position?
3. **Strategy concentration:** Has this strategy hit its maximum position count?
4. **Duplicate detection:** Is there already an active position for this ticker/strategy combo?

**Regime adjustments:** Additive confidence modifiers based on MarketRegime and StrategyFamily. For example, technical strategies get +0.04 in BROADENING regimes and -0.08 in CONTRACTION. Returns 0.0 during bootstrapping (regime adjustments disabled until calibrated).

**Bootstrap-specific logic:**
- Caps positions at 50% of normal maximum during bootstrapping
- Maintains an allowlist of alt-data strategies that can skip manual confirmation
- Returns whether manual confirmation should be required for a given strategy

**Output:** GovernorDecision containing approved/rejected status, rejection reason, exposure ceiling, exposure recommendation, kill state, regime state, and regime adjustment for downstream sizing.

---

### Guardian — Position Sizer + Stress Tester

**File:** `guardian.py`

The Guardian takes Governor-approved signals and determines exact position size, then validates safety through a battery of pre-execution stress tests. Every stress test must pass for the trade to proceed.

**Position sizing methods (selected by availability):**
- **Kelly criterion** (half-Kelly): Uses calibrated win rate and R:R ratio. Only available when calibration data exists with sufficient sample size.
- **ATR-based:** 3x ATR stop defines dollar risk per share; position sized to target risk budget.
- **Fixed fractional:** Fixed percentage of equity per trade, scaled by confidence.
- **Bootstrap minimum:** ~1% equity or $500 risk. Used during bootstrapping when calibration is unavailable.

Selection follows a fallback chain: Kelly > ATR > Fixed Fractional > Bootstrap Min.

**Stress tests (all six must pass):**
1. **Sector concentration:** No single sector exceeds 25% of equity
2. **Correlated shock:** Simulates -2 sigma move; blocks if correlated positions exceed limit
3. **Liquidity:** Position must be less than 1% of 20-day average daily volume
4. **Gap risk:** Position risk multiplied by 2 (worst-case gap) must stay under 3% of equity
5. **Exposure ceiling:** New position won't breach Governor's ceiling
6. **Strategy concentration:** Strategy hasn't hit its maximum position count

**Staleness fail-safe:** Validates theoretical entry price against live market price using a volatility-scaled threshold (max of 3% or 1.5x ATR/price). Blocks execution if the signal's price assumption has drifted too far.

**Output:** GuardianDecision (pass/block with all stress test results) and ExecutionRequest (only populated if all checks pass).

---

## Execution & Position Management

### Operator — Execution Bridge

**File:** `executor.py`

The Operator bridges Guardian ExecutionRequests to the Alpaca API and manages the complete APPROVED through ACTIVE through CLOSED lifecycle.

**Order placement:** Maps ExecutionRequests to Alpaca market, limit, or stop orders. Uses signal_id as client_order_id for reconciliation. Transitions signal APPROVED to EXECUTED on success. If the fill is immediate, activates the position and places a protective stop-loss order.

**Stop-loss management:**
- Places GTC stop orders on Alpaca after entry fill with 3 retries and exponential backoff (2s, 4s delays)
- Raises RuntimeError if all attempts fail — the position is logged as UNPROTECTED but the internal stop monitor still runs every 15 minutes
- Runs stop order reconciliation every monitoring cycle: cross-checks all ACTIVE positions against open Alpaca orders and re-places any missing stops automatically

**Position monitoring (every cycle):**
- Detects positions closed externally (stop hit by Alpaca, manual close, liquidation)
- Checks for target hits against current market price
- Checks for time stops (holding period exceeds max_holding_days)
- Confirms delayed fills (EXECUTED signals where the Alpaca position appears on a later cycle)
- Routes ALL closures through PostmortemAnalyzer for atomic finalization

**Exit price resolution:** When a position disappears from Alpaca, the Operator resolves the actual exit price by checking (in order): recent closed orders, account fill activities, and current market price as last resort.

**Portfolio state building:** Fetches live Alpaca account data and recomputes ground-truth PortfolioState: equity, exposure, drawdown, kill state evaluation. This is the system's truth anchor.

---

### Postmortem Analyzer — Performance Ledger

**File:** `postmortem.py`

Analyzes every closed position to extract performance metrics and atomically finalize the lifecycle, insert the ledger record, and refresh calibration — all in a single transaction.

**Metrics computed per trade:**
- **Execution drift:** (actual_fill - theoretical_entry) / one_r_value, measured in R-units
- **MFE (Max Favorable Excursion):** Best unrealized P&L from entry to exit, as percentage of entry
- **MAE (Max Adverse Excursion):** Worst unrealized P&L from entry to exit, as percentage of entry
- **Realized R-multiple:** (exit_price - entry_price) / one_r_value
- **P&L percentage:** (exit_price - entry_price) / entry_price
- **Holding duration:** Minutes from entry to exit

**Atomic finalization:** The `close_position_with_postmortem()` repository method executes in a single transaction: ACTIVE to CLOSED transition, CLOSED to POSTMORTEM_COMPLETE transition, PostmortemRecord insertion to performance_ledger, active_positions row deletion, and calibration table refresh. This guarantees the lifecycle state, position table, and performance ledger never get out of sync.

**Batch processing:** `process_all_active_stops()` iterates all ACTIVE positions, checks prices against internal stop levels, and closes any that have been breached — a second layer of stop protection beyond the broker-side GTC orders.

**Attribution analysis:** Reads the performance ledger and aggregates metrics by confirmation filter (which technical overlays contributed to winning vs. losing trades), feeding back into strategy refinement.

---

## Data Layer

### Data Adapters

**File:** `data_adapters.py`

Unified fetch layer between raw API clients and the trading system's SQLite cache. Every adapter follows the cache-first pattern: check SQLite cache, fall back to API if stale, degrade gracefully on failure. All adapters return `(data, freshness_score)` tuples where freshness ranges from 1.0 (just fetched) to 0.0 (stale or failed).

**QuiverQuant adapters:** Insider trades (bulk and per-ticker), congressional trades, short volume, WallStreetBets mentions, government contracts. TTLs range from 2 hours (WSB) to 12 hours (government contracts).

**Alpaca adapters:** Account data, positions, historical bars, latest trade prices. TTLs range from 1 minute (account, prices) to 12 hours (daily bars).

**FMP adapters:** Real-time quotes, historical daily prices, full OHLCV bars, ETF sector weights. TTLs range from 4 hours (quotes) to 24 hours (historical, sector weights).

**Daily bar trading-day cache:** An in-memory cache keyed by trading date that rolls when the date changes. Prevents repeated API calls for the same daily bars across 15-minute cycles within a trading day. Falls back from Alpaca to FMP automatically.

**Composite freshness:** Computed as the minimum freshness across all data sources used in a cycle. Propagated to Signal.data_freshness_score and used by the Governor for System Kill evaluation.

**API health check:** Tests connectivity to all endpoints and returns a health snapshot used for Governor System Kill evaluation (15% failure rate threshold).

---

### Universe Builder

**File:** `universe.py`

Two-stage architecture for efficient opportunity scanning with minimal API usage.

**Stage 1 — Core Universe:** ~100 liquid US equities (mega-cap tech, large-cap semis, software/cloud, internet, financials, healthcare, consumer, industrials, energy). Hardcoded — zero API calls.

**Stage 2 — Dynamic Expansion:** One FMP API call per day (6-hour cache) fetches the most active tickers by volume, filtered to price above $5 on major exchanges. Returns ~30-50 additional high-volume tickers. Open positions are always included to ensure continuous monitoring.

**Result:** ~115 deduplicated tickers per scan cycle, consuming only 1 API call per day for universe construction.

---

### Database

**File:** `database.py`

SQLite with MEMORY journal mode (required for FUSE/mounted filesystem compatibility), NORMAL synchronous mode for crash safety, and foreign key enforcement. Eight tables with JSON columns for lossless Pydantic round-tripping.

---

### Repository

**File:** `repository.py` (~1,600 lines)

The ONLY module that touches SQLite during execution. All other components interact with the database exclusively through this repository.

**Persistence invariants enforced:**
1. Irreversible stop ratchet — LONG stops only move up, SHORT stops only move down
2. Irreversible ladder stages — can only increment, blocked entirely in BOOTSTRAPPING
3. Valid lifecycle transitions — checked against VALID_TRANSITIONS before any state change
4. Stale-read protection — conditional UPDATE with WHERE lifecycle_state check prevents race conditions
5. Atomic audit logging — signal state change + transition log insert in single transaction
6. ACTIVE/active_positions invariant — open_position() verifies ACTIVE state, close_position() verifies CLOSED

**Method groups:** Signal CRUD (save, get, query by state, duplicate check), lifecycle transitions (with audit trail), active position management (open, close, update stop/ladder/trailing), workflow methods (activate_signal_with_position, close_position_with_postmortem), calibration queries, and performance ledger queries.

---

## Bootstrapping Protocol

The system starts in BOOTSTRAPPING mode — a conservative phase designed to collect performance data while limiting risk exposure.

**Key constraints during bootstrapping:**
- `confidence_calibrated` is null — position sizer treats as baseline 0.30 with minimum lot sizing
- Maximum position allocation capped at 50% of normal size
- Kill criteria use hardcoded defaults (flat "5 consecutive losses" rule, no MAE comparison)
- Regime weights are neutral (1.0x) until sufficient regime-tagged returns exist
- All alt-data signals require confirmation (even if normally auto-execute)
- Ladder stages are frozen (no partial exits)
- Postmortem runs on every trade from Day 1

**Exit criteria (all must be met to promote to CALIBRATED):**
- 30 or more closed trades per strategy
- 60 or more days of regime-tagged return data
- At least 1 regime transition observed

When all criteria are met, the system auto-promotes via `_check_auto_promote()` in the pipeline. All sub-components are updated in-place.

---

## Shadow Evaluation System

**File:** `shadow_evaluator.py`

A parallel persistence and evaluation system for strategies in observation mode. Allows safe testing of new strategies with real market data before committing live capital.

**How it works:**
1. A Scout in shadow mode emits ShadowRecord objects (not Signal objects) — these are persisted to the shadow_signals table, completely outside the main lifecycle state machine
2. Each ShadowRecord includes hypothetical Governor and Guardian decisions (what would have happened if this were live)
3. The ShadowEvaluator periodically scores outcomes by walking forward through price bars after the signal creation date, tracking MFE, MAE, and detecting stop hits, target hits, or time exits

**Two-step promotion gate:**

Step 1 — Automatic statistical gate (must pass all):
- Minimum 25 resolved tradable signals (only signals that would have passed Governor + Guardian)
- Minimum 10 trading days span
- Win rate above 40%
- Average R-multiple on winners above 1.0
- Positive expected value
- At least 2 distinct regime contexts observed

Step 2 — Manual acknowledgement:
- Config.json must contain `{"shadow_promotions": {strategy: {"acknowledged": true}}}`
- Prevents auto-enabling without human review

The pipeline checks `is_live_enabled()` before each cycle to decide whether a scout runs in live or shadow mode.

---

## Kill Criteria & Failsafes

Four kill levels, evaluated every cycle in order of precedence:

**System Kill:** API failure rate exceeds 15% over the last hour. Halts all new entries; manages stops only. Automatically resumes when health recovers.

**Allocation Kill:** Portfolio drawdown exceeds 8% from peak equity. Switches to REDUCE_ONLY or CASH_PRIORITY mode. No new entries until drawdown recovers.

**Regime Disagreement Kill:** Macro regime disagreement combined with market-top-detector score above 70. Forces CASH_PRIORITY.

**Signal Kill:** Strategy-specific. Triggered when a strategy has 5 consecutive losses AND rolling win rate drops below the 10th percentile of historical performance. Only blocks signals from the affected strategy — other strategies continue normally. The dual condition (consecutive losses AND poor win rate) prevents false kills from normal losing streaks.

---

## Portfolio-Level Limits

Thirteen hard rules enforced at all times:

- Maximum total exposure: dynamic, set by regime (typically 70% ceiling)
- Maximum single position: 5% of equity (2.5% during bootstrapping)
- Maximum single sector: 25% of equity
- Maximum correlated positions: 3
- Maximum daily trades: 8
- Maximum open positions: 20
- Maximum per strategy: 5 positions
- Minimum cash reserve: 20%
- Allocation kill: 8% drawdown from peak
- Signal kill: 5 consecutive losses + win rate below p10
- System kill: 15% API failure rate
- Regime disagreement kill: top risk above 70

---

## MCP Server & Claude Desktop Integration

**File:** `mcp_server/server.py`

Exposes 30+ tools for Claude Desktop to interact with the trading system directly via the Model Context Protocol.

**Alpaca account tools:** View equity, cash, buying power, P&L, positions, orders, market status.

**Alpaca trading tools:** Place market/limit buy orders, sell orders, stop-loss orders, trailing stops. Cancel open orders. Get current prices.

**QuiverQuant congressional tools:** View recent congressional trades, filter by ticker or politician, monitor watched politicians.

**QuiverQuant insider tools:** View recent insider trades, filter by ticker, find insider buys above minimum value thresholds.

---

## Skills Library

Seventeen specialized analysis skills are available as directories (each with SKILL.md + supporting scripts), accessible via Claude Desktop:

**Core Trading Skills:**
- **trader-memory-core:** Persistent thesis tracking across the full lifecycle (screening through analysis, sizing, position management, and postmortem). Supports 5 thesis types: dividend income, growth momentum, mean reversion, earnings drift, and pivot breakout.
- **exposure-coach:** Market posture synthesis integrating breadth, regime, and flow signals. Outputs exposure ceiling, growth-vs-value bias, and entry recommendations (NEW_ENTRY_ALLOWED, REDUCE_ONLY, CASH_PRIORITY).
- **position-sizer:** Risk-based position sizing with fixed fractional, ATR-based, and Kelly Criterion methods. Enforces maximum position and sector percentage constraints.

**Market Analysis Skills:**
- **macro-regime-detector:** Classifies market regime (Concentration, Broadening, Contraction, Distribution, Reversal).
- **market-breadth-analyzer:** Advance/decline ratios, new highs/lows, participation breadth metrics.
- **market-top-detector:** Distribution day counting and top probability scoring.
- **technical-analyst:** Pattern recognition for breakouts, support/resistance levels, and trend strength.

**Risk & Performance Skills:**
- **signal-postmortem:** Structured outcome analysis including MAE, MFE, holding duration, and R-multiple.
- **edge-signal-aggregator:** Multi-source signal fusion with confidence weighting.
- **backtest-expert:** Historical scenario backtesting.
- **scenario-analyzer:** What-if analysis for position changes.

**Specialty Skills:**
- **options-strategy-advisor:** Options structure suggestions (spreads, verticals).
- **portfolio-manager:** Portfolio-level risk allocation and rebalancing.
- **market-environment-analysis:** Macro conditions summary.
- **ftd-detector:** Failure-to-deliver anomaly detection.
- **financial-strength-scorer:** Balance sheet and cash flow fundamental analysis.

---

## Module Reference

| Module | Lines | Purpose |
|--------|-------|---------|
| `pipeline.py` | ~750 | Main orchestrator — runs complete 15-minute cycles |
| `contracts.py` | ~600 | Pydantic models, enums, constants — the type system |
| `repository.py` | ~1,600 | Domain persistence — ONLY module touching SQLite |
| `executor.py` | ~750 | Alpaca order placement, stop management, position monitoring |
| `guardian.py` | ~400 | Position sizing + 6 stress tests |
| `governor.py` | ~350 | Regime, allocation, kill criteria evaluation |
| `postmortem.py` | ~350 | Performance metrics + atomic lifecycle finalization |
| `signal_queue.py` | ~300 | Priority ranking + Governor/Guardian evaluation pipeline |
| `data_adapters.py` | ~950 | Cache-first API fetch layer with freshness scoring |
| `shadow_evaluator.py` | ~350 | Shadow signal scoring + two-step promotion gate |
| `alt_data_overlay.py` | ~200 | Cross-strategy alt-data confidence adjustments |
| `premarket_scan.py` | ~250 | Pre-market data warming + signal pre-staging |
| `universe.py` | ~100 | Dynamic scan universe builder (~115 tickers) |
| `database.py` | ~250 | SQLite schema (8 tables) + connection factory |
| `cycle_logger.py` | ~110 | Append-only JSONL cycle observability |
| `mode_resolver.py` | ~90 | BOOTSTRAPPING vs CALIBRATED mode resolution |
| `env_loader.py` | ~60 | Credential loading (.env and config.json) |
| `run_cycle.py` | ~80 | CLI entry point for single cycle execution |
| `scouts/mean_reversion.py` | ~350 | Oversold bounce detection with alt-data relaxation |
| `scouts/insider_cluster.py` | ~400 | Insider purchasing cluster detection |
| `scouts/trend_pullback.py` | ~350 | Pullback-within-uptrend detection (shadow mode) |
| `mcp_server/server.py` | ~500 | 30+ MCP tools for Claude Desktop integration |

---

## Database Schema

**8 tables in SQLite:**

1. **signals** — Signal storage with lifecycle state, full JSON blob, and indexed columns for queries
2. **signal_transitions** — Full audit trail of every state change (from/to state, reason, timestamp, portfolio snapshot)
3. **active_positions** — Per-trade lifecycle controller (entry price, stops, ladder stage, R-multiples, trailing mode)
4. **performance_ledger** — Closed trade records (P&L, R-multiple, MFE, MAE, drift, exit reason)
5. **confidence_calibration** — Per-strategy per-regime calibration (win rate, average R:R, sample size)
6. **portfolio_state_snapshots** — Macro risk truth anchor (equity, exposure, regime, kill state)
7. **data_cache** — API response cache with TTL-based freshness (source x ticker keyed)
8. **shadow_signals** — Shadow strategy evaluation (hypothetical decisions, outcome tracking, MFE/MAE)

---

## Configuration

**config.json** (from config_template.json):

```
alpaca:
  api_key, api_secret, base_url (paper-api.alpaca.markets)

strategy_a (legacy):
  stop_loss_pct, trailing_trigger_pct, trailing_floor_pct, ladder_levels

strategy_b (legacy):
  source_url, politicians, min_trade_size

monitoring:
  check_interval_minutes (15), market_open (09:30),
  market_close (16:00), timezone (US/Eastern)

shadow_promotions:
  {strategy_name}: {acknowledged: true/false}
```

**Environment variables (loaded via env_loader.py):**
- ALPACA_API_KEY, ALPACA_API_SECRET
- QUIVER_API_KEY
- FMP_API_KEY

Priority: environment variables > .env file > config.json

---

## Build Phases

**Phase 1 — "Useful and Real" (current):**
Pydantic models, SQLite schema, data adapters, state machine, Governor/Guardian, mean reversion and insider cluster scouts, postmortem analyzer, position sizer, stress tester, signal queue priority.

**Phase 2 — "Make it Safer":**
Institutional flow tracker, MA crossover detector, full confidence calibration, live regime weight tuning.

**Phase 3 — "Add Research Depth":**
Backtest engine, technical analyst upgrade, historical strategy validation.

**Phase 4 — "Advanced":**
Pairs trader, dark pool scanner, Monte Carlo simulation, options advisor, advanced portfolio optimization.

---

*This document reflects the system as of April 7, 2026, during the bootstrapping phase. The system is running on Alpaca paper trading with no real money at risk.*
