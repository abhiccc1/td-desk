# Quant Proposal Gap Analysis — Ranked by Impact, Effort, Status

## Context

`docs/proposals/quants.md` describes 12 core modules, 10 feature proposals, 15+ strategies, and 5 research directions. This analysis maps every item against what td-desk has already built, then ranks what to build next.

---

## Part 1: Core Quant Modules (12 items)

### Tier 1 — Already Built / Mostly Complete

| # | Module | Status | What Exists | Gap |
|---|--------|--------|-------------|-----|
| 1 | **instrument_master** | ~80% | Scrip master (expiries, lot sizes, tokens from Kotak CSV), cached in Redis | Missing: roll rules, holiday/trading calendar |
| 2 | **market_gateway** | ~95% | Kotak Neo WebSocket + REST, binary auth, reconnect, subscription manager, market-hours guard | Missing: multi-vendor support (only Kotak) |
| 3 | **chain_builder** | 100% | SnapshotAggregator normalizes quotes into `OptionChainSnapshot` by underlying/expiry/strike, Redis pub/sub | — |
| 4 | **pricing_engine** | ~85% | Mid IV (bid/ask → BSM), full Greeks, Heston/VG via FFT, SVI fair values | Missing: synthetic forwards, carry-adjusted fair values |
| 5 | **surface_engine** | ~85% | SVI per-expiry fit, multi-expiry surface endpoint, no-arb checks, Heston/VG IV overlays, 2D/3D vol surface | Missing: SSVI cross-expiry parameterization |

### Tier 2 — Partially Built

| # | Module | Status | What Exists | Gap |
|---|--------|--------|-------------|-----|
| 6 | **risk_engine** | ~30% | Portfolio Greeks aggregated (`RiskExposureCalculator`), net delta/gamma/theta/vega panel | Missing: scenario ladder, max loss calc, margin-aware sizing, kill-switches |
| 7 | **oms_router** | ~25% | Basket management, order staging, strategy templates, Kotak REST order submission | Missing: child-order logic, retry/cancel/replace, fill reconciliation |
| 8 | **monitoring** | ~20% | Heartbeats, market-hours guard, SVI param-change alerts | Missing: stale-feed detection, PnL drift alarms, broker disconnect alerts |

### Tier 3 — Not Started

| # | Module | Status | What Exists | Gap |
|---|--------|--------|-------------|-----|
| 9 | **rv_engine** | 0% | Tick data pipeline exists (raw ticks flow through Redis) | Need: realized vol calculator, intraday variance, overnight/day split, vol regime classification |
| 10 | **flow_engine** | 0% | OI and volume fields exist in `TickData` but aren't analyzed | Need: OI delta tracking, strike clustering, participation metrics |
| 11 | **gex_engine** | 0% | Per-strike Greeks exist, OI comes through ticks | Need: GEX aggregation, zero-gamma level, vanna/charm proxies |
| 12 | **replay_lab** | 0% | TimescaleDB stores historical Greeks/IV | Need: replay engine, paper trading, fill/slippage model |

---

## Part 2: Feature Proposals (10 items)

| # | Feature | Status | Depends On | Impact | Effort |
|---|---------|--------|------------|--------|--------|
| 1 | Live IV smile/surface dashboard | **DONE** | — | — | — |
| 2 | Surface residual scanner (rich/cheap vs fitted) | **~70%** | surface_engine | High | Low — Edge columns exist; need bid/ask spread overlay |
| 3 | Synthetic forward / put-call parity monitor | **0%** | pricing_engine | Medium | Low — chain data + simple math |
| 4 | Gamma exposure + zero-gamma dashboard | **0%** | gex_engine | **Very High** | Medium |
| 5 | Dealer positioning proxy (OI + ΔOI) | **0%** | flow_engine | **Very High** | Medium |
| 6 | OI build-up/unwind heatmap | **0%** | flow_engine | High | Medium |
| 7 | Intraday IV shock monitor | **~30%** | rv_engine | High | Medium — SVI alerts are a start; need open-to-now IV profile |
| 8 | Event overlay (RBI, Budget, CPI, earnings) | **0%** | instrument_master | Medium | Low — static calendar + UI overlay |
| 9 | Execution-quality page | **0%** | oms_router | Medium | High — needs real fill data |
| 10 | Research promotion flow | **0%** | replay_lab | Low | High |

---

## Part 3: Strategies (grouped by prerequisite)

Strategies aren't directly implementable as code — they need the engines above. Here's what unlocks what:

| Strategy Category | Key Prerequisite | Current Readiness |
|---|---|---|
| Surface residual trades (butterflies, skew dislocations) | surface_engine + Edge columns | **Ready now** — Edge columns + SVI fit exist |
| IV vs RV carry (short vol when spread is wide) | **rv_engine** | Blocked — no realized vol yet |
| Gamma-regime strategy (mean reversion in +GEX zones) | **gex_engine** | Blocked — no GEX yet |
| Intraday IV shock mean reversion | **rv_engine** + surface_engine | Blocked — no intraday RV |
| Futures-led directional spreads | flow_engine + market_gateway | Mostly blocked — no flow analysis |
| Event term-structure trades | instrument_master (calendar) + surface_engine | Partially ready — need event calendar |
| Monthly trend-following spreads | rv_engine + risk_engine | Blocked |
| Dispersion-lite (index vs stock options) | surface_engine + multi-underlying | Blocked — single-underlying focus |

---

## Part 4: Ranked Priority List

Ordered by: **trading edge delivered / implementation effort**, accounting for what already exists.

### P0 — High Impact, Leverages Existing Infra

| Rank | Item | Impact | Effort | Why Now |
|------|------|--------|--------|---------|
| **1** | **rv_engine** (Realized Vol) | Very High | Medium | IV-RV spread is THE core edge. Tick pipeline exists. Unlocks IV shock monitor, vol regime, and every vol carry strategy. |
| **2** | **gex_engine** (Gamma Exposure) | Very High | Medium | Per-strike Greeks + OI already flow through Redis. GEX = Σ(gamma × OI × spot² × contract_mult). Unlocks gamma-regime strategy + zero-gamma dashboard. |
| **3** | **flow_engine** (OI/Volume Analysis) | Very High | Medium | OI and volume are already in TickData. Need delta tracking (current - previous) and aggregation. Unlocks dealer positioning proxy + OI heatmap. |

### P1 — High Impact, Low Effort

| Rank | Item | Impact | Effort | Why Now |
|------|------|--------|--------|---------|
| **4** | **Synthetic forward / put-call parity monitor** | Medium | Low | Uses existing chain data. Simple: F = C - P + K·exp(-rT). Shows dislocations. New panel, ~150 lines. |
| **5** | **Surface residual scanner enhancement** | Medium | Low | Edge columns exist. Add: bid/ask spread context (residual > half-spread = actionable), sortable view. |
| **6** | **Event calendar overlay** | Medium | Low | Static JSON of NSE events (RBI dates, Budget, expiry weeks). Display as markers on charts + filter in toolbar. |

### P2 — Medium Impact, Medium Effort

| Rank | Item | Impact | Effort | Why Now |
|------|------|--------|--------|---------|
| **7** | **risk_engine** enhancements (scenario ladder) | Medium | Medium | Portfolio Greeks exist. Add: ±1%, ±2%, ±5% spot shock → P&L ladder. Margin estimation. |
| **8** | **Intraday IV shock monitor** | Medium | Medium | Needs rv_engine (P0 item #1). Once RV exists: compare ATM IV jump vs intraday RV forecast. |
| **9** | **monitoring** improvements | Medium | Low-Med | Stale-feed detection (no tick in N seconds), PnL drift alert, broker disconnect. Operational quality. |

### P3 — Lower Priority / High Effort

| Rank | Item | Impact | Effort | Why Now |
|------|------|--------|--------|---------|
| **10** | **replay_lab** | Medium | High | Needs historical data infra, replay engine, paper trading. Valuable but large scope. |
| **11** | **SSVI cross-expiry parameterization** | Low | Medium | SVI per-expiry already works well. SSVI is a refinement, not a new capability. |
| **12** | **Execution-quality page** | Low | High | Needs real fill data flowing through oms_router. |
| **13** | **Research promotion flow** | Low | High | Notebook → config → paper → live pipeline. Premature until replay_lab exists. |
| **14** | **Deep hedging / VolGAN / TabPFN** | Research | Very High | Interesting but not production-ready for a trading desk. Revisit later. |

---

## Part 5: Recommended Build Order

If implementing sequentially, the optimal path is:

```
Phase A (P0 — unlocks most strategies):
  rv_engine → gex_engine → flow_engine

Phase B (P1 — quick wins while Phase A bakes):
  synthetic forward monitor → surface residual enhancement → event calendar

Phase C (P2 — builds on Phase A):
  risk scenario ladder → IV shock monitor → monitoring improvements

Phase D (P3 — future):
  replay_lab → SSVI → execution quality
```

Phase A items can be built in parallel since they're independent engines that all consume existing tick/Greeks data.

---

## Summary Scorecard

| Category | Total Items | Done | Partial | Missing |
|----------|-------------|------|---------|---------|
| Core Modules (12) | 12 | 3 | 5 | 4 |
| Feature Proposals (10) | 10 | 1 | 2 | 7 |
| Strategy Prerequisites | 8 categories | 1 ready | 1 partial | 6 blocked |
| Research Items (5) | 5 | 0 | 0 | 5 (defer) |

**Bottom line:** The pricing/surface stack is strong (BSM, SVI, Heston, VG, FFT all integrated end-to-end). The biggest gap is **market microstructure analysis** — realized vol, gamma exposure, and order flow. These three engines unlock the majority of the proposed strategies and feature dashboards.
