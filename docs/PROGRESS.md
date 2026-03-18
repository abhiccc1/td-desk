# TD-Desk Development Progress

> This file tracks all completed work, active proposals, and known issues.
> Updated automatically after each implementation block.

## Architecture Overview

```
Frontend (Next.js + AG Grid + Zustand + shadcn/ui)
  ↕ REST + WebSocket
API Gateway (FastAPI)
  ↕ Redis pub/sub + cache
Market Data Service (Kotak Neo SDK WebSocket → binary protocol)
Quant Service (Rust/PyO3 td_core — BSM Greeks, IV solver, SVI fitting, Heston/FFT pricing, VG jump-diffusion, strategy payoff)
Order Service (basket management, broker execution stubs)
  ↕
Redis | TimescaleDB
```

---

## Completed Features

### Live Option Chain Pipeline
- [x] Kotak Neo WebSocket connection via vendored SDK (HSWebSocketLib binary protocol)
- [x] Binary auth handshake, scrip subscription (`mws`/`ifs` types)
- [x] Tick parsing → SnapshotAggregator → Redis pub/sub → WebSocket fan-out → AG Grid
- [x] Dynamic expiry fetching from scrip master (replaces hardcoded dates)
- [x] On-demand subscription (SubscriptionManager with LRU channel eviction)
- [x] Spot price from Kotak index feed (`nse_cm|26000` via `mws`)
- [x] Spot divider row in option chain with live price + change/pct
- [x] ITM call row shading
- [x] LTP columns clickable for order leg creation
- [x] Single-row headers with Call/Put color tinting

### Greeks & SVI
- [x] Batch IV solver via `td_core.batch_compute_greeks_warm` (Rust/rayon)
- [x] SVI surface fitting via `td_core.svi_fit` every chain snapshot
- [x] Greeks cached to Redis hash (`cache:greeks:{u}:{e}`, 300s TTL)
- [x] SVI cached to Redis (`cache:svi:{u}:{e}`, 300s TTL)
- [x] camelCase serialization (alias_generator on all Pydantic schemas)
- [x] **Phase 1.1: SVI IV + Edge columns** — Market IV, SVI theoretical IV, and IV Diff (mispricing signal) shown per strike with color coding (green=cheap, red=expensive)
- [x] **Phase 1.2: IV Smile/Skew Chart** — New visx panel showing SVI fitted curve (blue line) + market IV scatter (blue dots=calls, purple=puts) + spot price marker. Registered as `iv-skew` panel in mosaic layout.
- [x] **Phase 2.1: SVI-Guided Strategy Selection** — New "Edge" strike mode in strategy config. For SELL legs: auto-selects OTM strike where market IV is most above SVI (overpriced premium). For BUY legs: selects where market IV is most below SVI (cheapest).
- [x] **Phase 2.2: Fair Value Premium Column** — "Fair" columns next to Call/Put LTP showing BSM price computed from SVI IV. Green if LTP < Fair (cheap to buy), Red if LTP > Fair (expensive). Uses client-side `bsPrice()` from `lib/black-scholes.ts`.
- [x] **Phase 3.1: Vol Surface Heatmap + 3D** — Canvas-based 2D heatmap panel with 2D/3D toggle. 2D: X=strike (spot±10%), Y=expiry (days/weeks), Color=IV (blue→green→yellow→red). 3D: WebGL rotatable surface via Plotly.js (lazy-loaded, ~800KB gl3d bundle). Backend `GET /api/v1/svi-surface/{underlying}` fetches SVI for all cached expiries. Spot marker as yellow dashed line. Auto-resizes, refreshes every 30s. Default view: 2D.
- [x] **Phase 3.2: IV Rank / Percentile** — ATM IV snapshot stored in TimescaleDB `iv_history` hypertable on every SVI fit (persistent across restarts). Backend `GET /api/v1/iv-rank/{underlying}` queries daily deduplicated ATM IV over 365 days, computes IV Rank and IV Percentile. Displayed in toolbar next to SPOT badge: `IV 18.5% R:42%` with color (green=low, yellow=mid, red=high rank).
- [x] **Phase 3.3: SVI Parameter Change Alerts** — Quant service compares current SVI params with previous on each fit. Detects: rho shift >0.05 (skew regime change), sigma shift >0.03 (smile expansion/contraction), a shift >0.02 (vol level jump), arbitrage-free=false (model instability). Alerts published via Redis `svi:alerts:*` → fan-out bridge → WebSocket → frontend. Displayed as shadcn Alert components in option chain panel header with dismiss buttons. Keeps last 20 alerts in store.

### Positions Panel
- [x] Live positions via Kotak Order & Position Streaming WebSocket (`wss://<baseurl>/realtime`)
- [x] `KotakRealtimeConnector` — connects after auth, receives `type: "position"` and `type: "order"` events
- [x] Debounced full REST fetch on position delta → transformed + published via Redis `orders:updates:default`
- [x] Position transformation extracted to `shared/positions.py` (used by both WS pipeline and REST endpoint)
- [x] **Pure WS-driven flow** — no periodic REST polling; REST fetch only on WS connect + position/order deltas
- [x] **Backend sends ltp=0** — frontend computes unrealized P&L from live option chain ticks (already had this override)
- [x] Initial REST `/positions` endpoint enriches LTP from cache for cold-start display
- [x] Frontend receives positions via WebSocket push (no more 5s polling)
- [x] Initial REST fetch on mount for cold start; streaming updates thereafter
- [x] All positions (open + closed) with `isOpen` flag
- [x] Realized P&L: `Σ(totalSellAmt - totalBuyAmt)` for closed positions (net_qty == 0)
- [x] Unrealized P&L: `bookedPnl + (netQty × liveLTP × adj)` from live option chain ticks
- [x] Kotak formula for avg price with multiplier/precision adjustments
- [x] Open position checkboxes with select-all + Square Off dialog (shadcn)
- [x] Closed positions greyed out (opacity-45)
- [x] Replaces Price Chart as default panel

### Order Management
- [x] Three-tab UI: New (strategy builder), Open (pending orders), Closed (order history)
- [x] shadcn Tabs, Badge, Button, Input, Checkbox, Dialog components
- [x] Order book from Kotak REST API (`/quick/user/orders`)
- [x] Open/closed split, sorted by time descending, 12h AM/PM format
- [x] Closed orders refresh only when count changes
- [x] Strategy template chips (Short Straddle, Strangle, Bull Put, Bear Call, Iron Condor)
- [x] Delta/Premium/Offset strike modes with decimal delta support (step 0.01)
- [x] MIS/NRML product type selector (Kotak API param names)
- [x] Lots multiplier (basket-level, overwrites all leg quantities)
- [x] Per-leg: B/S toggle, CE/PE toggle, strike stepper, qty stepper, order type selector
- [x] Lot sizes from Kotak scrip master (API-fetched, not hardcoded)
- [x] Quantity snapping to lot size multiples
- [x] **Live order placement via Kotak Neo SDK** — `POST /api/v1/place-orders` endpoint using `neo_api_client.place_order()`. Single reusable endpoint for new orders, square-off, and partial exit. BUY orders placed before SELL orders. Automatic freeze quantity splitting (per-instrument NSE/BSE limits).
- [x] **Frontend wired to live execution** — `handleSubmit` in order drawer calls `placeOrders()` directly (bypasses old basket service). Square Off and Partial Exit in position monitor wired to same endpoint.
- [x] **Trading symbol cache** — Scrip master caches `pTrdSymbol` per underlying/expiry/strike in Redis (`cache:scrip:trdsym:{u}:{e}`) for order placement symbol resolution.
- [x] **Freeze quantities** — Added to `instruments.json` and `InstrumentMaster`; cached in Redis (`cache:freeze_quantities`). Orders exceeding limits auto-split into lot-aligned chunks.

### Static Data & Spot
- [x] Day open/high/low/prevClose from Kotak tick data
- [x] SPOT badge in toolbar with live change + pct (from prevClose)
- [x] Spot divider pill in option chain with change data
- [x] Static data cached in Redis (`cache:static:{symbol}`, 24h TTL, date-tagged)

### Instrument Master
- [x] `data/instruments.json` — single source of truth for underlying metadata (lot sizes, spot tokens, segments, exchange)
- [x] `InstrumentMaster` class + `UnderlyingConfig` Pydantic model (`shared/instruments.py`)
- [x] Scrip master refactored: removed `TRACKED_UNDERLYINGS`, `lot_sizes`, `_cache_lot_sizes`; uses `InstrumentMaster` for filtering and segment prefixes
- [x] Kotak connector refactored: removed `INSTRUMENT_TOKENS` dict; accepts `spot_tokens` param with reverse lookup
- [x] Subscription manager refactored: builds index tokens from `InstrumentMaster` per-underlying segment
- [x] API gateway: `/lot-sizes` reads from `InstrumentMaster` (no Redis); new `/underlyings` endpoint
- [x] Docker: `data/` volume-mounted into `market_data_service` and `api_gateway`
- [x] Frontend: dynamic underlying list fetched from `/underlyings` API with hardcoded fallback
- [x] BSE underlyings (SENSEX, BANKEX) with `instrument_type: "IO"` (BSE uses `IO` not `OPTIDX` for index options)
- [x] SENSEX enabled with expiry fetching from BSE F&O scrip master CSV

### Auth & Connection
- [x] Kotak Neo TOTP two-step auth (totp_login + totp_validate)
- [x] SecretStr fix — real JWT stored in Redis (not masked `**********`)
- [x] Scrip master download (file paths API + CSV parse + expiry/token/lot extraction)
- [x] Kotak epoch bug workaround (parse dates from pScripRefKey instead of lExpiryDate)

### Heston / FFT Pricing Engine (Phase 3+4)
- [x] Carr-Madan FFT engine (`rust_core/src/fft.rs`) — `CharacteristicFunction` trait, O(N log N) strike-strip pricing with Simpson's rule + α-dampening
- [x] Heston stochastic vol model (`rust_core/src/heston.rs`) — Albrecher et al. CF formulation (branch-cut safe), call/put pricing via FFT, IV inversion via BSM solver
- [x] PyO3 exports: `heston_price`, `heston_price_chain`, `heston_iv`, `fft_price_at_strikes`
- [x] `HestonParams` Pydantic schema (`shared/schemas/greeks.py`)
- [x] 19 Rust unit tests passing (FFT vs BSM closed-form, put-call parity, Heston smile shape, IV roundtrip)

### Variance Gamma Jump-Diffusion (Phase 5)
- [x] VG model (`rust_core/src/vg.rs`) — Madan-Carr-Chang (1998) CF with martingale correction, call/put pricing via FFT, IV inversion
- [x] PyO3 exports: `vg_price`, `vg_price_chain`, `vg_iv`, `"vg"` arm in `fft_price_at_strikes`
- [x] `VarianceGammaParams` Pydantic schema (`shared/schemas/greeks.py`)
- [x] 6 Rust unit tests: CF(0)=1, positive prices, put-call parity, IV roundtrip, fat tails (high ν), negative skew (negative θ)
- [x] 25 total Rust tests passing

### Heston/VG Full-Stack Integration
- [x] `ModelPricer` indicator (`quant_service/indicators/model_pricer.py`) — runs Heston + VG FFT pricing on each `CHAIN_SNAPSHOT`, concurrent with ChainGreeksCalculator
- [x] `MODEL_PRICES_COMPUTED` event type — carries per-strike Heston/VG IVs and prices
- [x] `ModelPricesResult` / `ModelStrikeResult` Pydantic schemas with camelCase aliases
- [x] Redis caching: `cache:model-prices:{underlying}:{expiry}` (300s TTL)
- [x] Redis pub/sub: `model:prices:{underlying}:{expiry}` channel
- [x] API endpoint: `GET /api/v1/model-prices/{underlying}/{expiry}`
- [x] WebSocket fan-out: `model:prices:*` pattern in `fan_out.py`
- [x] Frontend `ModelPricesResult` type + `modelPrices` store state
- [x] `fetchModelPrices()` API client (real + mock stub)
- [x] WS subscription: `model:prices:{underlying}:{expiry}` topic
- [x] IV Skew Chart: Heston (orange dashed) + VG (cyan dotted) curves overlaid on SVI + market scatter
- [x] Option Chain Grid: Heston IV + VG IV columns on both call/put sides
- [x] Model Comparison panel: table view with BSM IV, SVI IV, Heston IV, VG IV per strike
- [x] Panel registered as `model-comparison` in mosaic layout

### Infrastructure & Quality
- [x] Default cache TTL raised from 5s → 30s
- [x] Greeks/SVI cache TTL: 300s
- [x] Dead code removed (GreeksCalculator single-tick path, kotak_binary.py, unused middleware, _epoch_to_date_str)
- [x] Data format audit: all schemas use camelCase aliases, REST + WS consistent
- [x] Frontend path mismatches fixed (baskets→basket, OHLCV path params, positions flat array)
- [x] DB persister infinite retry loop fixed (drop records on failure)
- [x] shadcn/ui components: Tabs, Badge, Button, Input, Checkbox, Dialog, Toggle

---

## Active Proposals

### SVI Full Utilization (`docs/proposals/svi-full-utilization.md`)

| Phase | Feature | Status |
|-------|---------|--------|
| 1.1 | SVI IV + Edge columns in option chain | ✅ Done |
| 1.2 | IV Smile/Skew Chart panel | ✅ Done |
| 2.1 | SVI-guided strategy strike selection | ✅ Done |
| 2.2 | Fair Value premium column | ✅ Done |
| 3.1 | Vol Surface heatmap | ✅ Done |
| 3.2 | IV Rank / Percentile | ✅ Done |
| 3.3 | SVI parameter change alerts | ✅ Done |

---

### Quant Engine Roadmap (Rust Core)

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | BSM Greeks + IV solver | ✅ Done |
| 2 | SVI surface fitting | ✅ Done |
| 3 | Heston stochastic vol CF | ✅ Done |
| 4 | Carr-Madan FFT pricing engine | ✅ Done |
| 5 | Variance Gamma model | ✅ Done |
| 6 | Heston/VG full-stack integration | ✅ Done |
| — | Heston/VG calibration optimizer (argmin/nalgebra) | ❌ Deferred |

---

### Expiry Switch Bug Fixes & Latency Tier 1
- [x] **Bug Fix: Greeks store never cleared on expiry switch** — Added `clearGreeks()` action to `greeks-store.ts`; called in `data-feed-orchestrator.ts` on expiry change and in `use-live-data.ts` before initial load. Old expiry Greeks no longer mix with new expiry data.
- [x] **Bug Fix: Time-to-expiry uses midnight UTC instead of IST market close** — Backend (`greeks.py`, `model_pricer.py`) and frontend (`option-chain-grid.tsx`) now parse expiry as 3:30 PM IST (10:00 AM UTC). Fixes ~10-hour `t` error that distorted Greeks, SVI total variance, and model prices.
- [x] **Bug Fix: SVI/model prices not cleared before new expiry load** — `use-live-data.ts` clears `optionChain`, `sviParams`, `modelPrices` immediately when expiry changes (before async fetch). `data-feed-orchestrator.ts` also clears SVI + model prices alongside ticks. No more stale SVI/fair-value flash during load.
- [x] **Tier 1A: Batch Greeks at source** — `ChainGreeksCalculator` now emits a single `GREEKS_BATCH_COMPUTED` event (not N individual `GREEKS_COMPUTED` events). New event type, publisher route (`greeks:batch:{u}:{e}`), fan-out pattern, and frontend handler. Eliminates ~79 redundant Redis publishes, fan-out cycles, and WS sends per chain snapshot.
- [x] **Tier 1C: orjson** — Replaced stdlib `json` with `orjson` in hot-path files: `fan_out.py`, `snapshot.py`, `kotak_neo.py` (on_message), `handlers.py`. Added `orjson>=3.10` to shared, api_gateway, and market_data_service dependencies.
- [x] **Tier 1D: Persistent Redis in quant publisher** — `ResultPublisher` now uses a persistent `aioredis.Redis` client from the shared connection pool instead of opening/closing per publish.

---

## Known Issues

- Realized P&L differs from broker for carry-forward positions — Kotak `cfBuyAmt`/`cfSellAmt` use original trade prices (includes prior-day M2M), broker shows today's P&L only (post-settlement). Trade Report API (`/quick/user/trades`) now fetched for accurate intraday fills. Need settlement prices to fix CF P&L.
- Strategy analysis endpoint broken (wrong EventType, disconnected pub/sub channels)
- OHLCV historical endpoint crashes (missing db_url argument)
- `open`/`high`/`low` fields empty for index static data (only `prevClose`/`change`/`pctChange` populate)
- TimescaleDB `ohlcv` table doesn't exist (materialized view schema mismatch) — HistoricalAggregator auto-disables on missing table
- `greeks` table unique index was missing for ON CONFLICT upsert — added in init.sql

---

## File Reference

| Area | Key Files |
|------|-----------|
| Option chain grid | `frontend/src/components/option-chain/option-chain-grid.tsx` |
| Order drawer | `frontend/src/components/option-chain/inline-order-drawer.tsx` |
| Leg row | `frontend/src/components/option-chain/compact-leg-row.tsx` |
| Strategy templates | `frontend/src/components/option-chain/strategy-templates.ts` |
| Positions panel | `frontend/src/components/positions/position-monitor.tsx` |
| Global toolbar | `frontend/src/components/dashboard/global-toolbar.tsx` |
| Market data store | `frontend/src/stores/market-data-store.ts` |
| Basket store | `frontend/src/stores/basket-store.ts` |
| Instrument master | `data/instruments.json` + `backend/shared/shared/instruments.py` |
| Kotak tick connector | `backend/market_data_service/.../connectors/kotak_neo.py` |
| Kotak realtime connector | `backend/market_data_service/.../connectors/kotak_realtime.py` |
| Position transformer | `backend/shared/shared/positions.py` |
| Subscription mgr | `backend/market_data_service/.../subscription_manager.py` |
| Scrip master | `backend/market_data_service/.../scrip_master.py` |
| Snapshot aggregator | `backend/market_data_service/.../snapshot.py` |
| Greeks/SVI compute | `backend/quant_service/.../indicators/greeks.py` |
| FFT engine (Rust) | `backend/quant_service/rust_core/src/fft.rs` |
| Heston model (Rust) | `backend/quant_service/rust_core/src/heston.rs` |
| VG model (Rust) | `backend/quant_service/rust_core/src/vg.rs` |
| Model pricer | `backend/quant_service/.../indicators/model_pricer.py` |
| Model comparison | `frontend/src/components/charts/model-comparison-panel.tsx` |
| Orders/Positions endpoint | `backend/api_gateway/.../routers/orders.py` |
| Market data endpoints | `backend/api_gateway/.../routers/market_data.py` |
| Analytics endpoints | `backend/api_gateway/.../routers/analytics.py` |
