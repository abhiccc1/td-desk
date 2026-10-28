# Proposal: Full SVI Surface Utilization for Trading Intelligence

## Problem Statement

The td-desk platform computes a full SVI (Stochastic Volatility Inspired) volatility surface every ~200ms via the Rust/PyO3 quant engine (`td_core.svi_fit`), but currently uses it only as a **fallback** when per-strike BSM IV computation fails. This wastes significant compute and misses the primary value proposition of SVI: identifying mispricings, visualizing volatility structure, and guiding strategy construction.

### Current State

| Component | Status | Impact |
|-----------|--------|--------|
| SVI fitting (backend) | ✅ Working — fits every chain snapshot | Computes `a, b, rho, m, sigma` params |
| SVI cache (Redis) | ✅ Working — `cache:svi:{underlying}:{expiry}`, 300s TTL | Available for all consumers |
| SVI REST endpoint | ✅ Working — `GET /api/v1/svi/{underlying}/{expiry}` | Returns camelCase JSON |
| Option chain IV column | ✅ Market IV primary, SVI IV in dedicated column | Always shown side-by-side |
| Option chain Edge column | ✅ IV Diff (Market - SVI) with color coding | Mispricing signal per strike |
| Strategy analyzer | ⚠️ SVI used only for missing premium gap-fill | Rare trigger |

## Proposed Features

### Phase 1: IV Skew & Mispricing in Option Chain

**Goal:** Show traders where options are cheap or expensive relative to the fitted volatility surface.

#### 1.1 Add "SVI IV" and "IV Diff" columns to option chain ✅ COMPLETED

Add two new columns per side (calls/puts):

- **SVI IV** — The theoretical IV from the fitted SVI surface at each strike
- **IV Diff** — `Market IV - SVI IV` (positive = option is expensive, negative = cheap)

Color coding:
- **Green** (negative diff): Option is cheaper than theoretical — potential buy opportunity
- **Red** (positive diff): Option is more expensive than theoretical — potential sell/write opportunity
- **Neutral** (near zero): Fair value

```
OI | Delta | IV | SVI IV | Diff | Call LTP | Strike | Put LTP | Diff | SVI IV | IV | Delta | OI
```

**Implementation:**
- Frontend: Add `callSviIv`, `callIvDiff`, `putSviIv`, `putIvDiff` to `OptionChainRow`
- In `strikeToRow()`: Always compute SVI IV (not just as fallback), compute diff
- New AG Grid columns with conditional cell coloring

#### 1.2 IV Smile/Skew Chart ✅ COMPLETED

A lightweight chart (using lightweight-charts or recharts) showing:
- **X-axis:** Strike price (or moneyness k = log(strike/spot))
- **Y-axis:** Implied Volatility (%)
- **Blue line:** SVI fitted curve (smooth theoretical)
- **Scatter dots:** Actual market IVs per strike (from greeks)
- **Highlighted outliers:** Strikes where market IV deviates significantly from SVI

This can be a new panel (`iv-skew`) in the mosaic layout, or embedded below the option chain.

**Implementation:**
- New component: `components/charts/iv-skew-chart.tsx`
- Data source: SVI params from store + per-strike greeks IVs from greeks store
- Compute: Generate SVI curve points from `a, b, rho, m, sigma` across strike range
- Register as new panel in `panel-registry.tsx` and `panels.ts`

### Phase 2: Strategy Intelligence

#### 2.1 SVI-Guided Strategy Selection ✅ COMPLETED

When a trader selects a strategy template (e.g., Short Strangle), use SVI to:
- **Auto-select strikes** where market IV is most above SVI (overpriced wings for selling)
- Show estimated "edge" per leg: `(market_premium - svi_fair_premium) × quantity`
- Display total strategy edge in the order summary bar

**Implementation:**
- Add `StrikeMode: "svi-edge"` to strategy templates
- In `applyTemplate()`: For each leg, find strike where `market_iv - svi_iv` is maximized (for sells) or minimized (for buys)
- Compute fair premium via `svi_iv → bs_price` (already exists in `strategy_analyzer.py`)
- Show edge in the order summary grid

#### 2.2 Fair Value Premium Column ✅ COMPLETED

Add a "Fair" column next to LTP showing the BSM price computed from SVI IV:
- `Fair = bs_price(spot, strike, t, r, svi_iv, is_call)`
- Color: Green if LTP < Fair (cheap to buy), Red if LTP > Fair (expensive to buy)

This gives traders an instant "is this option fairly priced?" signal.

**Implementation:**
- Backend: New endpoint `GET /api/v1/fair-prices/{underlying}/{expiry}` or compute client-side
- Client-side preferred (SVI params already in store, BS formula is simple)
- Add `callFair`, `putFair` columns to option chain grid

### Phase 3: Vol Surface & Analytics

#### 3.1 Vol Surface Heatmap ✅ COMPLETED

A 2D heatmap panel showing IV across:
- **X-axis:** Strike prices
- **Y-axis:** Expiry dates
- **Color:** IV level (blue=low, red=high)

Requires SVI params for multiple expiries (already computed per expiry).

**Implementation:**
- Fetch SVI params for all available expiries of the selected underlying
- New component: `components/charts/vol-surface.tsx`
- Use canvas-based rendering for performance (many cells)
- New panel in mosaic layout

#### 3.2 IV Percentile / IV Rank ✅ COMPLETED

Show where current IV sits relative to historical IV:
- **IV Rank:** % of days in last N days where IV was lower than current
- **IV Percentile:** Percentile of current IV in historical distribution

Requires historical IV data (from the `greeks` TimescaleDB table, once the persistence bug is fixed).

**Implementation:**
- Backend: Query TimescaleDB for historical ATM IV
- New endpoint: `GET /api/v1/iv-rank/{underlying}`
- Display in toolbar next to SPOT badge or in a dedicated analytics panel

#### 3.3 SVI Parameter Change Alerts ✅ COMPLETED

Track SVI parameter changes over time:
- Alert when `rho` (skew) shifts significantly (regime change)
- Alert when `sigma` (smile width) expands (volatility event)
- Alert when `arbitrageFree` becomes `false` (model instability)

**Implementation:**
- Backend: Compare current SVI params with previous (store history in Redis or TimescaleDB)
- Publish alerts via WebSocket (`svi:alert:{underlying}:{expiry}`)
- Frontend: Toast notifications for significant changes

## Architecture Notes

### Data Flow (Proposed)

```
Kotak WebSocket → Ticks → Snapshot Aggregator → Redis pub/sub
                                                      ↓
                                            Quant Service
                                            ├─ batch_compute_greeks_warm() → per-strike IV, Delta, Greeks
                                            └─ svi_fit() → SVI params (a, b, rho, m, sigma)
                                                      ↓
                                            Redis Cache
                                            ├─ cache:greeks:{u}:{e} (per-strike)
                                            └─ cache:svi:{u}:{e} (surface params)
                                                      ↓
                                            API Gateway + WebSocket Fan-out
                                                      ↓
                                            Frontend
                                            ├─ Option Chain Grid
                                            │   ├─ Market IV (from greeks) ← existing
                                            │   ├─ SVI IV (from svi params) ← NEW: always shown
                                            │   ├─ IV Diff (market - SVI) ← NEW: mispricing signal
                                            │   └─ Fair Premium (BSM from SVI IV) ← NEW
                                            ├─ IV Skew Chart ← NEW panel
                                            ├─ Vol Surface Heatmap ← NEW panel
                                            └─ Strategy Builder
                                                └─ SVI-guided strike selection ← NEW mode
```

### Client-Side SVI Computation

Since SVI params are just 5 numbers (`a, b, rho, m, sigma`), computing SVI IV and BSM fair prices client-side is trivial and avoids extra API calls:

```typescript
// SVI IV at any strike (already exists in sviIv function)
function sviIv(svi: SviParams, strike: number, spot: number, t: number): number

// BSM price from SVI IV (new, simple formula)
function sviFairPrice(svi: SviParams, strike: number, spot: number, t: number, r: number, isCall: boolean): number
```

## Priority & Effort Estimates

| Feature | Priority | Effort | Trader Value |
|---------|----------|--------|--------------|
| 1.1 SVI IV + Diff columns | ✅ **DONE** | Small (frontend-only) | High — instant mispricing signal |
| 1.2 IV Skew Chart | ✅ **DONE** | Medium (new component) | High — visual skew analysis |
| 2.2 Fair Value column | ✅ **DONE** | Small (frontend-only) | Medium — fair pricing reference |
| 2.1 SVI-guided strikes | ✅ **DONE** | Medium (template logic) | High — automated edge finding |
| 3.1 Vol Surface Heatmap | ✅ **DONE** | Large (multi-expiry data) | Medium — advanced analytics |
| 3.2 IV Rank/Percentile | ✅ **DONE** | Large (needs historical data) | Medium — context for IV levels |
| 3.3 SVI Change Alerts | ✅ **DONE** | Medium (backend + WS) | Low-Medium — regime change detection |

## Recommended Starting Point

**Phase 1.1** (SVI IV + Diff columns) can be implemented entirely in the frontend with zero backend changes — the SVI params are already in the store. This gives traders immediate value: see at a glance which options are mispriced relative to the volatility surface.
