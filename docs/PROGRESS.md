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
- [x] API gateway: `/lot-sizes` serves `cache:lot_sizes` (written from `InstrumentMaster` at gateway startup); new `/underlyings` endpoint
- [x] Docker: `data/` volume-mounted into `market_data_service` and `api_gateway`
- [x] Frontend: dynamic underlying list fetched from `/underlyings` API with hardcoded fallback
- [x] BSE underlyings (SENSEX, BANKEX) with `instrument_type: "IO"` (BSE uses `IO` not `OPTIDX` for index options)
- [x] SENSEX enabled with expiry fetching from BSE F&O scrip master CSV

### MCX Commodity Options — Backend (2026-09-25)
Options on futures for **CRUDEOIL, CRUDEOILM, NATURALGAS, NATGASMINI, GOLD, GOLDM**, behind `MCX_ENABLED` (default off → hidden from `/underlyings`, not parsed/subscribed). Frontend not yet done.
- [x] Facts verified against Kotak `mcx_fo.csv` (2026-09-25): `pScripRefKey` is **empty** on MCX rows; `pExpiryDate` is a plain UTC epoch (no +315511200 offset); strikes ×100 in sci-notation; `pAssetCode` = token of the FUTCOM each option devolves into (GOLD Oct/Nov options → DEC future)
- [x] `UnderlyingConfig`: `asset_class`, `underlying_source` (spot|future), `future_instrument_type`, `pnl_multiplier`, `session_close` (`mcx_evening` = 23:30 IST in US DST else 23:55), `pricing_model` (bsm_spot|black76), `feature_flag`; helpers `expiry_close_dt`, `time_to_expiry_years`, `pricing_model`, `unit_multiplier`, `exchange_from_segment`
- [x] Lot size ≠ P&L multiplier: `unit_multiplier` = dGenNum/dGenDen (GOLD 100: qty in kg, price ₹/10g; GOLDM 0.1). Applied to paper fills, scenario P&L, strategy payoff/net credit
- [x] Scrip master MCX branch: expiry from epoch **cross-checked** against `pTrdSymbol` date (mismatch → row dropped); option→future validated (same symbol, fut expiry ≥ option expiry, one future per expiry, consistent specs) else the expiry is dropped; CSV lot/multiplier/max-qty compared with `instruments.json` (mismatch logged `scrip_master.contract_spec_changed`)
- [x] New Redis: `cache:scrip:underlying_future:{u}`, `cache:contract_meta:{u}`; new `GET /api/v1/contract-meta/{u}`
- [x] Chain subscription includes its own future token (`mws` only); future tick symbol `"CRUDEOIL 261119 FUT"` → `ticks:future:{u}:{yymmdd}`; snapshot `underlyingPrice` = that future's LTP (never another month), parity fallback; payload adds `underlyingFuture`
- [x] Tick `exchange` from token segment (also fixes BSE ticks labelled NSE)
- [x] Rust `td_core`: `batch_compute_greeks_warm_black76`, `black76_price` (closed-form Black-76 greeks w.r.t. F; FD-verified). NSE BSM path unchanged
- [x] Hardcoded 15:30 IST removed from greeks/model_pricer/calibrator/vrp/risk_analytics → per-underlying close. Heston/VG/FFT skip MCX (spot-drift models)
- [x] Orders: MCX lot-multiple validation; **live MCX placement gated by `MCX_LIVE_ORDERS_ENABLED` (default off)** until the Kotak mcx_fo qty unit (units vs lots) is verified via margin API; modify-order segment derived from trading symbol; trade poller 09:00–23:59 IST when MCX enabled
- [x] Paper `multiplier` columns widened to DOUBLE PRECISION (idempotent ALTER on startup)
- [x] Phase 0 qty unit **verified 2026-09-25 via `/margin-preview`** (BUY/MKT check-margin only, no orders): mcx_fo `quantity` is in **units** (lots × lLotSize), same as NSE. CRUDEOILM(10)/CRUDEOIL(100) margin ratio 0.100 across 4 strikes (lots would give 0.01); GOLD qty 1 deep-ITM margin = premium × 100, GOLDM qty 100 = premium × 100 × 0.1 (0.6% apart) — confirms `unit_multiplier`
- [x] Phase 0 live-tick check (2026-09-25 12:36 IST): MCX tick prices are unscaled ₹ at the quoted unit (CRUDEOILM19OCT26FUT 8,949; GOLD04DEC26FUT 153,151 ₹/10g); option LTPs match check-margin premiums (GOLD 140000CE 13,870 = probe); chains map to the correct futures month (crude Oct→19OCT26FUT, gold Nov→04DEC26FUT); ticks labelled MCX. Kotak MKT margin prices at best ask (explains wide-spread OTM gold diffs)
- [x] `MCX_LIVE_ORDERS_ENABLED=true` set in `.env` (gateway recreated)
- [x] quant_service rebuilt (td_core with Black-76) + restarted 2026-09-25; verified cached CRUDEOILM 9000CE greeks equal a Black-76 recompute from live mid (IV 0.599 vs 0.579 under old BSM, Δ 0.517 vs 0.529); NIFTY greeks unaffected
- [ ] Expiry-day close time: confirm against MCX contract-spec circular
- [x] **Frontend (web + Expo mobile, 2026-09-25)** — `NSE+BSE / MCX` segment toggle (persisted; shown only when `/underlyings` has MCX). Filters the underlying selector, positions (list + totals) and order book, with a "+N in MCX" hint so nothing is hidden silently. Basket is not filtered.
  - Web `lib/instruments.ts`: metadata registry, `unitMultiplier`, `rowValueMultiplier`, `expiryCloseDate`/`timeToExpiryYears` (15:30 IST or MCX evening, same as quant), `pricingModelOf`, `priceTick` (from `/contract-meta`), `foSegmentOf`
  - Web `lib/black-scholes.ts`: Black-76 price/IV/greeks + `modelPrice/modelImpliedVol/modelGreeks`; verified vs Rust (5.8822) and live quant greeks (CRUDEOILM 9000CE identical)
  - **Fixed pre-existing `normalCdf` bug** (used x instead of x/√2 → Φ(1)=0.870 vs 0.841): every client-side BSM number (Fair columns, greeks fallback) was wrong for NSE too; textbook call 11.91 → 10.4506
  - Rupee values × unit multiplier in basket CR/DR, drawer turnover/funds/charges, payoff fallback, greeks exposure (+ ₹ hints/scenarios), portfolio risk notional, position P&L/time value/delta/exposure
  - Seven ad-hoc expiry-time definitions replaced by the shared helper; FUT badge/labels + underlying future symbol; no `nse_fo` default on modify; drawer stepped-leg symbol format fixed; vol-surface strike step for low-priced underlyings; MCX scenario IV held flat
  - Backend: positions (live + paper) carry `valueMultiplier` (live = Kotak `adj`, warns `positions.value_multiplier_mismatch` vs config)
  - `MCX_ENABLED=true` in `.env` (all services)
  - [x] **MCX orders in lots (2026-09-25)**: order legs (`/place-orders`, `/margin-preview`, `/paper/place-orders`, `/orders/{id}/modify`) accept optional `lots`; backend converts via `shared.instruments.order_quantity_from_lots` (per-expiry lot from `cache:contract_meta` for MCX, else config), rejects quantity/lots mismatches. Web + mobile serialize MCX legs as `lots` (quantity omitted) at the API boundary; web basket leg, modify-order and position-exit steppers show lots for MCX. NSE/BSE wire format unchanged
  - [ ] Browser smoke test of both apps with live MCX data
- [ ] MCX holiday calendar; SILVER/SILVERM (config-only once needed)

### Auth & Connection
- [x] Kotak Neo TOTP two-step auth (totp_login + totp_validate)
- [x] SecretStr fix — real JWT stored in Redis (not masked `**********`)
- [x] Scrip master download (file paths API + CSV parse + expiry/token/lot extraction)
- [x] Kotak epoch bug workaround (parse dates from pScripRefKey instead of lExpiryDate)
- [x] **Multi-account login (2026-09-22)** — multiple broker accounts, one live at a time
  - Server-side profiles in `KOTAK_ACCOUNTS` (JSON array of `{id, label, consumer_key, mobile, ucc}`);
    consumer keys never reach the client. `GET /api/v1/auth/kotak/accounts` returns id/label/UCC
    plus a masked mobile only.
  - Login screen shows an account picker; last-used account is remembered in localStorage.
    `KOTAK_CONSUMER_KEY` + Settings mobile/UCC still work as the single-account fallback.
  - Auth managers are created per login attempt and held in `app.state.kotak_auth_pending`
    keyed by account id (replaces the single `app.state.kotak_auth` singleton).
  - `consumer_key`, `account_id` and `ucc` ride in `BrokerCredentials.extra`, so the published
    credentials carry the account identity to every service. Downstream consumer-key reads
    (`orders._get_neo_client`, MDS `session_watcher`, MDS scrip-master cron) prefer the
    credentials and fall back to the env var.
  - **Trade-log isolation**: `trade_logs.ucc` column added; dedup index re-keyed to
    `(time, ucc, fill_id, order_id)`; every read filters on UCC. Two accounts can now hold
    the same `fill_id` without one silently overwriting the other (verified against Postgres).
  - Switching accounts flushes the `positions` snapshot table so the previous book can't be
    shown under the new account.
  - "Switch account" button in the global toolbar (shows the live UCC) → `POST /logout` → picker.
  - Migration `shared/migrations.ensure_trade_log_account_column` runs on gateway startup;
    backfills legacy rows when exactly one account is configured, warns otherwise.
  - `account_id` is resolved strictly: an unknown id is a 404, and an omitted id is only
    inferred when exactly one profile exists (otherwise 400). Previously it silently
    defaulted to the first profile, which would sign a caller into an account it never named.
  - **Mobile app (Expo/React Native, `/mobile-app`)** has the same picker — it does not share
    `frontend/src`, so it needed its own implementation: `fetchKotakAccounts()` in
    `src/lib/api.ts`, account chips on `app/login.tsx`, `lastAccountId` in
    `use-connection-store`, legacy-field note on the Settings tab.
  - Mobile Settings tab shows the live account (profile label + UCC) and has a
    "Switch Account" action — logout + redirect to the picker. Only shown when the
    backend has profiles; plain Logout remains for the legacy path.
  - Tauri desktop shell shares `frontend/src`, so it inherits the UI, but `frontendDist`
    points at the `out/` static export — it needs `npx tauri build` to pick the changes up.
    `devUrl` and the Next dev script are pinned to port 3001 (3000 is taken by another
    project's container on this machine).

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

### Heston/VG Model Calibration (Phase 7)
- [x] `ModelCalibrator` indicator (`quant_service/indicators/calibrator.py`) — subscribes to `CHAIN_SNAPSHOT`, reads cached SVI fit, calibrates Heston (5 params via differential evolution) and VG (3 params via L-BFGS-B with Nelder-Mead fallback) against SVI IV curve
- [x] Target generation: 25 log-moneyness points sampled from SVI (±15% around ATM)
- [x] Heston: enforces Feller condition (2κθ > σ_v²), bounds on all 5 params, ATM-variance-seeded initial guess, popsize=10 × maxiter=50 for ~500 FFT evaluations
- [x] VG: enforces martingale condition (1 − θν − ½σ²ν > 0), L-BFGS-B primary with Nelder-Mead fallback
- [x] Cooldown: calibration runs at most once per 30s per (underlying, expiry) pair
- [x] Thread-pool execution: scipy optimizers run via `asyncio.run_in_executor()` to avoid blocking the event loop
- [x] Calibrated params cached to Redis (`cache:calibrated-heston:*`, `cache:calibrated-vg:*`, 300s TTL)
- [x] `ModelPricer` reads calibrated params from Redis with fallback to hardcoded defaults
- [x] `CALIBRATION_COMPLETED` event type for observability
- [x] `ModelPricesResult` extended with `hestonCalibrated`, `vgCalibrated`, `hestonRmse`, `vgRmse` fields
- [x] Frontend IV Skew Chart legend shows "(uncal)" suffix when using default params
- [x] `scipy>=1.12` added to quant_service dependencies

### Volatility Risk Premium (VRP)
- [x] Backend `GET /api/v1/vrp/{underlying}` — queries `iv_history` for daily-deduplicated spot prices over 45 calendar days, computes 20-day close-to-close log-return realized vol (annualized, sqrt(252)), subtracts from current ATM IV
- [x] Frontend toolbar VRP badge next to IV Rank: green (VRP > 5%, rich premium), yellow (0-5%), red (< 0, cheap vol). 30s polling, native title tooltip with ATM IV / RVol breakdown

### Model Mispricing Scanner
- [x] 4 new edge fields in `OptionChainRow`: `callHestonEdge`, `callVgEdge`, `putHestonEdge`, `putVgEdge` (modelIv − marketIv, positive = cheap/buy)
- [x] `modelEdgeClass` cell styling: green for cheap (buy signal), red for expensive (sell signal)
- [x] Column toggles: "H-Edge" and "V-Edge" in option chain grid, hidden by default
- [x] Calibration-aware: edges only computed when respective model is calibrated
- [x] `MispricingScannerPanel` — standalone panel showing strikes with |consensusEdge| above threshold, ranked by mispricing magnitude
- [x] Adjustable threshold control, summary stats (N cheap / N expensive)
- [x] Action buttons: BUY/SELL click adds leg to basket via `addLegFromChain()`
- [x] Registered as `mispricing-scanner` panel in mosaic layout

### Paper Trading Module
- [x] **Hard safety guarantee: order placement physically detached from live trading.** The paper path imports zero broker code (no `neo_api_client`, no `shared.live_session`, no `routers/orders.py`) — a unit test enforces this via AST scan.
- [x] New DB tables `paper_positions` + `paper_trade_logs` (mirror `positions`/`trade_logs`) in `init.sql`; `ensure_paper_tables()` creates them on gateway startup for existing volumes
- [x] `shared/scrip_resolve.py` — broker-free symbol→trading_symbol/token/cache-symbol resolution (shared, mirrors `orders.py::_resolve_order_legs`)
- [x] `shared/paper_trading.py` — pure position accounting (`apply_paper_fill`, `load_paper_positions`, `reset_paper_book`); position dict shape identical to live so the frontend type/component are reused unchanged
- [x] `routers/paper_trading.py` — `POST /api/v1/paper/place-orders` (instant fill at live LTP from `cache:ltp` / `cache:lkgv`), `GET /api/v1/paper/positions`, `POST /api/v1/paper/reset`. Legs without a live price are rejected
- [x] Frontend `usePaperPositionStore` (separate from live store) + `placePaperOrders` / `fetchPaperPositions` API clients
- [x] **Positions component reused via injected `PositionDataSource`** — `PositionMonitor` takes a `dataSource` prop (live default); paper square-off / partial-exit / modify route through `placePaperOrders`, never the live broker. Paper polls every 4s + refetches after each order (no WS push)
- [x] New `paper-positions` mosaic panel ("Paper Positions") with amber PAPER badge in header
- [x] LIVE/PAPER toggle in the option-chain order drawer (state in basket store); PAPER button + amber "Paper Submit" make the mode unmistakable. LIVE is the default

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
| 7 | Heston/VG calibration to SVI surface (scipy DE + L-BFGS-B) | ✅ Done |
| 8 | FFT redundancy fix — `heston_chain_full` / `vg_chain_full` single-pass functions | ✅ Done |
| 9 | Risk-neutral density, CDF, PoP, VaR, ES via inverse FFT | ✅ Done |
| 10 | VRP indicator (ATM IV − realized vol) + frontend badge | ✅ Done |
| 11 | Strategy analytics: multi-leg RND PoP, density overlay, VaR/ES, market PoP edge | ✅ Done |

---

### Risk-Neutral Probability Distribution (Phase 9-11)
- [x] Rust `risk_neutral_density()` — inverse FFT of Heston/VG CF → PDF of S_T at requested grid
- [x] Rust `compute_pop()` — trapezoidal integration of density over profitable payoff region
- [x] Rust `compute_cdf()` — cumulative distribution from density
- [x] Rust `compute_var()` — Value-at-Risk at given confidence (sort by payoff, accumulate density)
- [x] Rust `compute_expected_shortfall()` — CVaR/ES, density-weighted average in worst α-fraction
- [x] 30 Rust tests passing (density integrates to 1, CDF monotonic, VaR/ES properties for long call)
- [x] `heston_chain_full()` / `vg_chain_full()` — single FFT pass returning (calls, puts, IVs), eliminating 3× redundant FFT per model
- [x] `ModelPricer` computes per-strike Heston/VG PoP + downsampled density (50 points) per snapshot
- [x] `ModelPricesResult` extended with `hestonPop`, `vgPop`, `hestonDensity`, `vgDensity`
- [x] `VrpCalculator` indicator — ATM IV from SVI, 10-day close-to-close RV from TimescaleDB, IV Rank percentile. Throttled 60s per underlying.
- [x] `VRP_COMPUTED` event + WebSocket fan-out + toolbar badge (4-tier color: green >5%, dim green 0-5%, yellow -2% to 0%, red <-2%)
- [x] Strategy analyze endpoint: Heston + VG density/PoP (with default param fallback), VaR(5%), ES(5%), market PoP via SVI ATM IV, edge
- [x] `td_core` wheel installed in api_gateway Docker image (Rust builder stage)
- [x] Payoff diagram: density area fill + line (blue, right axis), VaR vertical/horizontal markers (orange dashed), two-row legend (PoP variants + Edge/VaR/ES)
- [x] Strategy analytics guide: `docs/guides/strategy-analytics-guide.md`

---

### Expiry Switch Bug Fixes & Latency Tier 1
- [x] **Bug Fix: Greeks store never cleared on expiry switch** — Added `clearGreeks()` action to `greeks-store.ts`; called in `data-feed-orchestrator.ts` on expiry change and in `use-live-data.ts` before initial load. Old expiry Greeks no longer mix with new expiry data.
- [x] **Bug Fix: Time-to-expiry uses midnight UTC instead of IST market close** — Backend (`greeks.py`, `model_pricer.py`) and frontend (`option-chain-grid.tsx`) now parse expiry as 3:30 PM IST (10:00 AM UTC). Fixes ~10-hour `t` error that distorted Greeks, SVI total variance, and model prices.
- [x] **Bug Fix: SVI/model prices not cleared before new expiry load** — `use-live-data.ts` clears `optionChain`, `sviParams`, `modelPrices` immediately when expiry changes (before async fetch). `data-feed-orchestrator.ts` also clears SVI + model prices alongside ticks. No more stale SVI/fair-value flash during load.
- [x] **Tier 1A: Batch Greeks at source** — `ChainGreeksCalculator` now emits a single `GREEKS_BATCH_COMPUTED` event (not N individual `GREEKS_COMPUTED` events). New event type, publisher route (`greeks:batch:{u}:{e}`), fan-out pattern, and frontend handler. Eliminates ~79 redundant Redis publishes, fan-out cycles, and WS sends per chain snapshot.
- [x] **Tier 1C: orjson** — Replaced stdlib `json` with `orjson` in hot-path files: `fan_out.py`, `snapshot.py`, `kotak_neo.py` (on_message), `handlers.py`. Added `orjson>=3.10` to shared, api_gateway, and market_data_service dependencies.
- [x] **Tier 1D: Persistent Redis in quant publisher** — `ResultPublisher` now uses a persistent `aioredis.Redis` client from the shared connection pool instead of opening/closing per publish.

---

### Architecture Audit Fixes (2026-03-18)
- [x] **trade_logs table** — New TimescaleDB hypertable for persistent execution fill records. Schema in `init.sql` with unique index on `(fill_id, order_id)` for deduplication.
- [x] **Trade logger module** — `shared/trade_logger.py`: parses Kotak trade report fills, persists to `trade_logs` with dedup, provides FIFO realized P&L computation (`compute_fifo_pnl`, `compute_portfolio_fifo_pnl`).
- [x] **Execution price logging** — `place_orders` endpoint now triggers background trade-report fetch + persist after successful orders. Position cold-start fetch also persists fills on login.
- [x] **Periodic trade report poller** — `_poll_trade_report()` in API gateway runs every 60s during market hours (09:15–15:35 IST). Fetches Kotak `/quick/user/trades` and persists to `trade_logs` via dedup INSERT. Ensures fills are captured even when UI is closed (e.g. limit orders filling later). Sleeps outside market hours.
- [x] **LKGV (Last Known Good Value)** — Backend: `TickPublisher` writes `cache:lkgv:{symbol}` (24h TTL) only for non-zero LTP. Frontend: `updateTick()` ignores ticks where `ltp === 0`. REST `/positions` falls back to LKGV cache when live LTP expired.
- [x] **Strategy analysis endpoint fixed** — Replaced broken pub/sub pattern (missing EventType, no subscriber) with inline payoff computation. Calculates payoff curve, breakevens, max profit/loss, PoP directly in the endpoint.
- [x] **Daily scrip master CRON** — `_daily_scrip_master_refresh()` scheduled task in market_data_service downloads scrip master at 08:45 IST daily. Complements auth-event-driven download for multi-day uptime.
- [x] **Order events persistence** — `PositionTracker.persist()` implemented: buffers fills on `update_on_fill()`, writes to `order_events` hypertable. Fixed `fill.filled_price` → `fill.avg_fill_price` bug.

### Market Data Reliability Overhaul (2026-07-09)
Root-cause audit of connection drops + slow option-chain arrival, then fixes:
- [x] **Keepalive on the Kotak market socket** — SDK `run_forever` now uses `ping_interval=10, ping_timeout=8` (was `ping_interval=0`: silent half-open TCP was never detected and the feed died until re-login). TLS verification re-enabled (`CERT_NONE` removed; endpoint cert verifies).
- [x] **Subscription replay after socket reconnect** — `KotakNeoConnector.generation` counter bumped in `on_open`; new `_watch_feed_health()` in SessionWatcher (replaces `_watch_index_freshness`) detects reconnects (generation change), full stalls (no tick 30s while connected), and index-only stalls, then replays indices + all active chains (`SubscriptionManager.resubscribe_all()`) + position tokens (`PositionSubscriber.resubscribe()`). Previously the SDK's auto-reconnect re-authed but lost every subscription permanently.
- [x] **Phantom subscriptions fixed** — `subscribe_channel` returns send success; failed sends tracked in `_pending_send` and retried by the watchdog. Chains are no longer marked active when the frame was silently dropped while disconnected.
- [x] **Snapshot-on-subscribe** — gateway ws handler pushes cached `cache:chain:snapshot:*` immediately on subscribe; `SnapshotAggregator.register_chain_key` emits from accumulated ticks right away; re-subscribing an active chain re-sends `mws` so Kotak re-delivers SNAPs (instant full-chain paint instead of strike-by-strike fill).
- [x] **Reliable subscribe requests** — gateway republishes `subscribe:request` every 500ms (up to 3s) until the chain snapshot appears; REST warm-up raised 1.2s → 3s.
- [x] **Event loop unblocked** — connector connect-wait made async (was `threading.Event.wait(15)` freezing the loop during activation); scrip-master CSV parse moved to `run_in_executor`.
- [x] **Broker-side unsubscribe on eviction** — LRU eviction now sends `mwu` for evicted scrips (previously they streamed forever, accumulating toward Kotak's per-connection cap) and returns all freed channels to a free pool (multi-channel eviction leaked channels).
- [x] **Fan-out backpressure** — per-client bounded queue (200) + writer task with 10s send timeout, drop-oldest on overflow. One slow browser tab no longer head-of-line-blocks every client/topic; stalled clients get disconnected.
- [x] **Container memory caps** for the 2GB podman VM: redis 640m, timescaledb 512m, quant 512m, market_data 512m, api_gateway 384m. (Initially set market_data=256m — OOM-killed during a session rebuild on 2026-07-09, since scrip-master download+parse spikes memory while the old connector is still alive. Caps need headroom over idle for rebuilds.)
- [x] Dead code removed: `market_data_service/reconnect.py` (never imported), `greeks_batch_interval_ms` config / `GREEKS_BATCH_INTERVAL_MS` env (never read). `subscribe_indices` batched to ≤100 scrips per frame.
- Verify after next login: watch for `session_watcher.socket_reconnected_replaying` / `feed_stalled_replaying` in logs; chain should paint instantly on expiry switch.
- [x] **MIDCPNIFTY spot via put-call parity** — Kotak never disseminates MIDCPNIFTY index ticks (token 26074 valid but dead), so chain snapshots published `underlyingPrice=0` (no spot divider, no ITM shading, degraded Greeks/SVI). `SnapshotAggregator._resolve_underlying_price` now falls back to `_parity_spot_estimate` (S ≈ K + C − P at the strike with min |C−P|) for both chain and position snapshots.
- [x] **`POST /api/v1/auth/kotak/republish`** — re-broadcasts the gateway's in-memory Kotak credentials (auth event + session version bump). Backend service restarts (credentials are process-local) no longer force a fresh TOTP login — call this instead. Note: the dev gateway runs uvicorn `--reload`, so editing gateway source wipes its credentials too; republish only works while the gateway process has a live session.

### Container Engine Migration & Shutdown Fixes (2026-07-09)
- Engine migrated podman (2GB VM — root cause of hangs/OOM kills) → Docker Desktop (~7.65GB VM).
- [x] **`init: true`** on quant_service, session_broker, fmp_cron — Python as PID 1 ignores unhandled SIGTERM, so every `docker stop` waited the full 10s SIGKILL timeout ("containers refuse to go down"). Measured: 10.1s → 0.12s. market_data_service has its own handlers; uvicorn services already fine.
- [x] **pgrep healthchecks removed** (market_data, quant, session_broker) — pgrep isn't installed in the slim images, so under Docker they permanently reported unhealthy; they only asserted PID-1 existence, which Docker guarantees. Note: market_data keeps the stale unhealthy badge until its next recreate (not recreated to preserve in-process creds).
- Session watcher only rebuilds on actual credential change now (`version_change_same_credentials` skip) — session-broker degraded flips no longer destroy a healthy connector.
- **2026-07-16 (later): the common denominator — gRPC-FUSE file sharing.** Even after the NeoAPI fix, gateway AND market_data_service froze and became unkillable (`Error while Stopping` after SIGKILL = D-state, uninterruptible kernel I/O). Every symptom across the week — 0%-CPU freezes with free memory, unkillable containers, daemon wedges — matches file-sharing stalls: the install ran the legacy gRPC-FUSE backend (`UseVirtualizationFrameworkVirtioFS: False`, `grpcFile.Flush ENOSYS` in VM console), all services bind-mount host source, and both uvicorn services run `--reload` (constant stat storms over the share). Switched Docker Desktop to **VirtioFS** (settings-store.json) 2026-07-16. Verified after switch: virtiofs mounts in VM console, /health 7ms, container stop 0.07s. If freezes recur, check for D-state stops before blaming app code.
- **2026-07-16: real root cause of gateway freezes — sync NeoAPI() on the event loop.** Gateway froze again at 0% CPU with memory well under its cap, proving the memory-limit theory wrong (or at best secondary). `_get_neo_client` constructed `NeoAPI(...)` (sync Kotak SDK, network I/O in the constructor, `requests` with no timeout) directly on the event loop — called by every order-book poll/order action, so one Kotak stall froze the whole gateway (/health dead, ws dead). Fixes: construction moved to `asyncio.to_thread` with 15s `wait_for`; `place_order`/`cancel_order`/`modify_order` executor calls bounded at 30s. All compose `mem_limit`s removed (user decision — VM has 7.65GB; limits caused two incidents and prevented none).
- **2026-07-15: one-shot pub/sub watchers died on startup DNS blip → login event missed.** After the engine restart, market_data_service came up before Docker DNS resolved `redis`; `_watch_auth_events` (and the subscribe/unsubscribe/position watchers) were single-try — the exception killed them silently, so the user's login event had no listener and the service sat in `no_live_credentials` despite an authenticated gateway. All four watchers now retry forever with 5s backoff (`*_failed_retrying` log lines). Verified: MIDCPNIFTY parity spot live (`underlyingPrice: 14745.1`, real Kotak feed).
- **2026-07-15: gateway memory livelock.** The 384m gateway cap + 200-deep per-client ws send queues (full-chain snapshots, hundreds of KB each, held by throttled background tabs) pinned the gateway at its cgroup ceiling — event loop livelocked in reclaim (not OOM-killed): /health frozen, docker exec hung, container unkillable ("did not receive an exit event") and the kill attempt took the whole daemon down. Fixes: `_QUEUE_MAX` 200→50 in `websockets/manager.py`, gateway `mem_limit` → 1024m, healthcheck timeouts 5s→10s (the python-spawn probe false-fails under engine load). Lesson: an undersized mem_limit on an async service produces a frozen-not-dead process — worse than the OOM kill it was meant to prevent.
- **2026-07-14: recurring Docker Desktop VM wedges = disk pressure.** Docker.raw hit 82GB real usage (host data volume 80% full); VM log showed "no free space on device to extend partition". Cause: ~73GB of accumulated build cache (383 entries) + unused images from rebuilds across all projects on this engine. Pruned 44.5GB (`docker builder prune -af` + `docker image prune -f`). Prevention: re-run the prune when `docker system df` shows multi-GB reclaimable, and set a disk usage limit in Docker Desktop → Settings → Resources so a runaway build fails fast instead of wedging the VM. Every VM restart wipes all process-local Kotak creds → one TOTP login required after.

### Positions Monitor Redesign (2026-03-18)
- [x] **`positions` table** — New PostgreSQL table (not hypertable) in TimescaleDB for current position state. Keyed on `trading_symbol`. UPSERT on save, DELETE stale rows on snapshot overwrite.
- [x] **`save_positions()` / `load_positions()`** — New functions in `shared/positions.py`. Full snapshot upsert: inserts/updates all positions, deletes rows no longer in broker response.
- [x] **`reconcile_positions()`** — Compares fresh REST snapshot against DB state, logs diffs (NEW/QTY change/GONE), then overwrites DB. Used on WS reconnect to catch missed events.
- [x] **Bootup: REST → DB** — `GET /api/v1/positions` now saves positions to DB after Kotak fetch (fire-and-forget `save_positions()`).
- [x] **Live: WS → DB** — `kotak_realtime.py` saves positions to DB on every WebSocket position delta (via `save_positions()`).
- [x] **Reconnect: Reconciliation** — On Kotak WS `on_open` (connect/reconnect), calls `reconcile_positions()` which does REST fetch → DB diff → DB overwrite → Redis publish. Logs any position changes missed during socket downtime.
- [x] **Trade fills on WS path** — `kotak_realtime.py` now also persists trade fills to `trade_logs` on every position update (catches fills from other apps).
- [x] **No frontend polling** — Frontend uses single REST fetch on mount (cold start) + WS streaming thereafter. No `setInterval` polling. Backend WS reconnection + reconciliation handles all gap recovery.

### Targeted Position LTP Subscriptions (2026-03-18)
- [x] **PositionSubscriber** — New `position_subscriber.py` in market_data_service. Watches `subscribe:positions` Redis channel, resolves position symbols to Kotak instrument tokens via scrip master cache, subscribes on dedicated WS channel 16. Only 5-20 tokens instead of 500+ for full chain.
- [x] **Channel 16 reserved** — `subscription_manager.py` `_MAX_CHANNEL = 15` (was 16). Option chains use channels 3-15, position tokens use channel 16.
- [x] **Position symbols published** — `kotak_realtime.py` publishes open position symbols to `subscribe:positions` after every position update so PositionSubscriber can resolve and subscribe tokens.
- [x] **Passive WS subscribe** — Frontend `ws-client.ts` passes `passive` flag. Backend `handlers.py` skips `request_market_subscription` for passive subscriptions (tokens already handled by PositionSubscriber).
- [x] **Position expiry topic sync** — `data-feed-orchestrator.ts` subscribes to `ticks:option:{u}:{e}` for all open position expiries (passive). Diffs on position change, unsubs removed expiries.
- [x] **Ticks Map LTP source** — `position-monitor.tsx` reads LTP from ticks Map first (works for ALL expiries), falls back to option chain. Fixed in PositionRow, useLiveTotalUnrealized, and square-off dialog.
- [x] **Selective tick clearing** — `clearTicksForExpiry()` in market-data-store only clears ticks for the old chain selection, preserving position ticks from other expiries.

### Durable Session-Broker Service (2026-03-21)
- [x] **SessionBundle schema** — `SessionState` (UNAUTHENTICATED→ACTIVE→DEGRADED→EXPIRED) + `SessionBundle` Pydantic model with version, access_token, sid, base_url, health check fields. Added to `shared/schemas/auth.py`.
- [x] **Session client** — New `shared/session_client.py`: `get_session()`, `get_session_or_raise()`, `store_session()`, `watch_session_version()`, `publish_session_status()`. Replaces all `cache_get("cache:auth:kotak") + json.loads()` patterns.
- [x] **Redis hash storage** — Session stored in `session:kotak:current` hash with auto-incrementing version. Legacy `cache:auth:kotak` string key written for backward compat. Version changes published to `session:kotak:version_changed`.
- [x] **Session broker service** — New `backend/session_broker/` microservice. Asyncio health check loop every 5 min via `GET /quick/user/limits`. 3 consecutive failures → DEGRADED state (version bump notifies downstream). Auto-recovery on success.
- [x] **Auth endpoint upgrade** — `totp-validate` writes versioned `SessionBundle` via `store_session()`. New `GET /session` endpoint returns `{state, version, lastHealthCheck, healthCheckOk, authenticatedAt}`.
- [x] **SessionWatcher** — New `session_watcher.py` in market_data_service. Bootstraps from Redis hash on startup (no pub/sub needed). On version change: saves subscriptions → teardown connectors → rebuild with fresh creds → replay subscriptions. Replaces fragile `_watch_kotak_auth`.
- [x] **Connector lifecycle** — `KotakNeoConnector.disconnect()` improved: closes HSWebSocket, drains tick queue. `KotakRealtimeConnector.stop()` added: sets stop flag, closes WebSocketApp, cancels debounce timer.
- [x] **SnapshotAggregator.reset()** — Clears all accumulated state on connector rebuild.
- [x] **Per-request migration** — All 6 `cache_get("cache:auth:kotak")` sites in orders.py replaced with `get_session_or_raise()`. Trade poller, scrip master cron also migrated.
- [x] **Frontend session awareness** — `session:*` added to fan-out channel patterns. `data-feed-orchestrator.ts` handles `session:status` topic: sets `sessionStatus` in market-data-store, triggers data reconciliation on recovery.
- [x] **Docker Compose** — `session_broker` service added with `restart: unless-stopped`, depends on redis.

### Full BSM Scenario Repricing (Gap 2 — Risk Audit, 2026-03-21)
- [x] **`ScenarioPnl` schema** — New Pydantic model with `spot_down`, `spot_up`, `pnl_down`, `pnl_up`, `worst_pnl`. Added to `StrategyTailRisk` as `scenario_1s`, `scenario_2s`, `scenario_3s`.
- [x] **`compute_scenario_pnl()`** — Full BSM repricing at ±1σ, ±2σ, ±3σ scenario spots using `td_core.bs_price()`. Log-normal scenario spots (`spot × exp(±n × σ√t)`). Each position repriced with its own IV from cached Greeks. Graceful degradation when `td_core` unavailable.
- [x] **`classify_tail_risk()` upgraded** — Risk flags now use full-reprice worst P&L instead of Taylor approximation. Taylor diagnostic fields (`one_sigma_delta_pnl`, `one_sigma_gamma_pnl`) kept for backward compat. New 2σ and 3σ stress flags with thresholds (2σ: 5%/10% of Net Liq, 3σ: 10%/20% of Net Liq).
- [x] **Wired into `build_portfolio_risk()`** — Per-expiry scenario P&L computed and passed to `classify_tail_risk`. Combined scenarios accumulated across expiries for underlying-level view.
- [x] **Frontend display** — `ScenarioPnl` type + `scenario1s/2s/3s` fields on `PortfolioRiskGroup`. Scenario P&L strip in portfolio risk panel showing worst-case P&L at each sigma level with scenario spot sub-labels.

### Price Chart — Live Candlestick Aggregation
- [x] **Spot tick pipeline** — Added `ticks:spot:{symbol}` Redis channel for non-option ticks in `publisher.py`. Added to fan-out patterns in `fan_out.py`. Frontend orchestrator subscribes independently of expiry.
- [x] **Client-side candle aggregation** — `PriceChartPanel` rewritten to aggregate 1m/5m candles from the live tick stream using `lightweight-charts`. Raw tick buffer (50k cap) enables interval re-aggregation. Resets on underlying change.

### Adjustment Panel — Smart Position Adjustment Recommendations
- [x] **Adjustment engine** (`shared/adjustment_engine.py`) — Structure-aware candidate generation for iron condors, strangles, verticals, naked shorts. Templates: roll tested side, add protective wings, roll to next expiry, close partial. Efficiency scoring (risk improvement / profit sacrifice) with hard filters (min efficiency 1.5, max loss increase capped at 15%, profit sacrifice capped at 40%).
- [x] **Schemas** — `AdjustmentLeg` and `AdjustmentRecommendation` added to `schemas/risk.py` with full before/after greek comparison, scoring, and warnings.
- [x] **API endpoint** — `GET /api/v1/adjustments/{underlying}` returns ranked recommendations with concrete legs, strikes, and estimated prices.
- [x] **Frontend panel** — `AdjustmentPanel` component with recommendation cards showing efficiency bar, greek deltas, credit/debit, POP change, expandable legs, and "Add to Basket" button. Auto-refreshes every 60s.

### Docker Build & Startup Optimization (2026-07-09)
- [x] **`.dockerignore`: exclude `**/target/`** — the 730MB Rust `target/` dir was entering every service's build context AND the rust-builder `COPY quant_service/rust_core/`, so any local cargo activity busted the Docker layer cache and forced a full Rust release recompile on the next `make start`. Also switched cache-dir patterns to `**/` so they match at any depth.
- [x] **Short healthcheck intervals** (redis/timescaledb 2s, order_service 3s, others 5–10s) — the first health probe only fires after `interval` elapses, so the `redis → timescaledb → order_service → api_gateway` chain wasted ~40s of pure waiting on every `compose up`. NOTE: compose's `start_interval` would be the cleaner fix but podman's compat API rejects it (gated on Docker Engine v25+); short plain intervals achieve the same and the probe commands are cheap. Measured: core stack start now ~7s, all services healthy.
- [x] **Fixed broken pgrep healthchecks** — installed `procps` in market_data/quant/session_broker base stages (see Recent Fixes).
- [x] **Cargo cache mounts** (`~/.cargo/registry`, `~/.cargo/git`, `target/`) added to the inline rust-builder stages in api_gateway and quant_service Dockerfiles — a real Rust source change now recompiles incrementally instead of cold. The two stages are byte-identical so buildx bake dedupes them into one build. `CARGO_BUILD_JOBS=2` caps rustc parallelism — the 2GB podman VM OOM-kills a full-parallel release build.
- [x] **`make start` no longer forces `--build`** — dev containers bind-mount source and hot-reload, so plain start is now `up -d` (compose still auto-builds missing images). `make start full` keeps `--build` as the rebuild-and-start path.
- [x] **fmp-cron** now uses a pip cache mount instead of `--no-cache-dir`.
- Note: the podman VM runs the whole stack in 2GB RAM / 5 CPUs — consider `podman machine set --memory 6144` (machine must be stopped) for headroom.

### Kotak Neo SDK v2 → v3 Migration (2026-10-06)
Migrated from `neo_api_client @ git+Kotak-neo-api-v2@v2.0.1` to the PyPI package `kotakneoapi` 3.0.8 (same `neo_api_client` import name). Plan and full findings: [docs/proposals/kotak-sdk-v3-migration.md](proposals/kotak-sdk-v3-migration.md).
- [x] **Deleted the vendored `connectors/kotak_sdk/`** (1,590 lines of v2 `HSWebSocketLib` binary decoder) — the market feed now runs on the SDK's async `SFeedWebSocket` (`wss://sfeed.kotaksecurities.com/apifeed`), with typed Pydantic ticks instead of 2-letter dict keys. Both decoders pre-scale by `multiplier × precision`, so the mapping was a field rename, not a rescale.
- [x] **`KotakNeoConnector`'s public surface deliberately unchanged** — `subscribe_channel(tokens, channel)` etc. still exist, with `channel` accepted and ignored (v3 addresses subscriptions by token). `subscription_manager.py` and `session_watcher.py` needed **zero changes**; the channel-count LRU still bounds how many scrips stay subscribed.
- [x] **Order/position feed on `OrderFeedWebSocket`** — daemon thread + `websocket-client` + `threading.Timer` replaced by an asyncio task on the service's own loop. `run_coroutine_threadsafe` → `create_task`; background publishes now held in a `_bg_tasks` set (asyncio only weakly references running tasks).
- [x] **Order API fixes** — dropped `market_protection`/`pf` from `place_order()` and `instrument_token`/`exchange_segment`/`product`/`trading_symbol`/`transaction_type` from `modify_order()`; removed the now-no-op `configuration.serverId` (v3 doesn't send `sId` at all).
- [x] **Boundary validation added** — v3 rejects alias values (`"NSE"`, `"Limit"`, `"CO"`, `"GTC"`) that v2 silently resolved, returning an opaque `{"Error": ...}` dict rather than raising. Allow-lists on `PlaceOrderLeg`/`ModifyOrderRequest` turn those into 422s, plus a `price > 0` guard for `L`/`SL` orders.
- [x] **`shared` now declares `sqlalchemy[asyncio]`** — `greenlet` was arriving transitively via the old SDK; without it the gateway crashed on boot. Latent packaging bug the old SDK was masking.
- [x] **Dropped `git` from the api_gateway image** (only needed for the GitHub pip install) and `websocket-client` from market_data_service.
- Note: the SDK's `migrate_from_v2.py` scanner found only 1 real issue in first-party code. It cannot see calls dispatched through `asyncio.to_thread`/`run_in_executor` — which is how this codebase calls the SDK almost everywhere — and it flags every `.subscribe(` including Redis pub/sub. Do not use it as a CI gate.
- Note: unauthenticated SFeed connections are accepted *and* ACK the subscribe frame before being dropped seconds later — a clean connect is not proof the feed works.

### Demand-Driven Chain Compute (2026-10-28)
The chain pipeline was already gated on `subscribe:request`/`unsubscribe:request`, but "demand" meant *an instrument is selected in the global toolbar* — a value set once at login and never cleared. With `snapshot_throttle_ms: 25` the full pipeline (snapshot build → IV/Greeks solve → SVI fit → fan-out → grid re-render) therefore ran at 40 Hz per chain from first instrument select until the browser closed, whether or not a chain panel was open, the tab visible, or anyone at the keyboard. Replaced with a demand signal derived from what the UI is actually doing, plus two independent backstops.

- [x] **Demand levels** — `active` (25 ms) / `background` (2000 ms) / `off` (chain released, nothing emitted). New `frontend/src/lib/chain-demand.ts` computes the level from ground truth — which chain-consuming panels are visible in the react-mosaic layout or floating, `document.hidden`, and time since the last pointer/key event (3 min idle threshold) — rather than accumulating it from events, so it cannot drift out of sync. Consumer panels: `option-chain`, `iv-skew`, `vol-surface`, `model-comparison`, `mispricing-scanner`, `greeks-exposure`.
- [x] **Demand protocol** — new WS action `{"action":"demand","chains":[{underlying,expiry,throttleMs}]}`. Always the **complete** set, never a delta, so a lost or reordered message can't leave a claim stuck pinning a chain at the active rate. `ConnectionManager` stores demand per connection and reduces with `min()`, so two tabs on one chain get the faster one's cadence and a disconnect takes only its own claim. Malformed messages are rejected outright — reading one as "demands nothing" would slow every chain the client is really watching.
- [x] **Per-chain cadence** — `SnapshotAggregator._chain_rates` replaces the single global throttle; new `set_chain_rate()` retunes a live chain via the `demand:request` Redis channel without re-sending broker subscribe frames. Rates are clamped to `[snapshot_throttle_ms, snapshot_max_throttle_ms]`. **Speeding a chain up emits immediately** instead of waiting out the slow interval the previous level had armed, so returning to the tab repaints at once.
- [x] **Unasserted chains run at the active rate** — a chain whose level was never asserted (gateway restart, dropped PUBLISH) is *not* throttled down. Stale-but-cheap is the wrong way to fail for a chain someone may be staring at.
- [x] **Self-healing re-assert** — the UI restates demand every 30 s and `ws-client` replays it on reconnect alongside `desiredTopics`. Demand is fire-and-forget and held in memory by market_data_service, so a restart on either side costs at most one interval at the wrong cadence instead of persisting until the next user action.
- [x] **`has_market_stream` no longer counts `ticks:option:`** — this was a real hole, not just a tuning issue. `ticks:option:` is the raw per-strike stream, published straight from the tick handler and unaffected by `release_view`, and it is **pinned** on the client for any expiry holding an open position. Counting it meant that for anyone with a position on, the chain could never be released: it stayed at the active rate for the life of the session regardless of the UI. Positions keep their LTP from `ticks:option:` and their Greeks from the independent 5 s position-snapshot pipeline, neither of which this gates.
- [x] **Greeks recompute guard (backstop)** — `ChainGreeksCalculator` fingerprints `(spot, strikes, prices, is_calls)` and skips the IV solve when nothing moved, with a 5 s staleness bound so theta/time-to-expiry drift still refreshes a frozen chain. Independent of the demand signal: if demand is mis-reported or never arrives, an idle chain still costs close to nothing.
- [x] **Demoted two 40 Hz `log.info` calls to `debug`** (`option chain snapshot emitted`, `greeks.pre_compute`) — structlog JSON rendering at the emit cadence was itself a measurable slice of both services' CPU.
- [x] **Tests** — `market_data_service/tests/test_snapshot_demand.py` (cadence, clamping, transitions, rate cleanup on unregister/reset), `api_gateway/tests/test_ws_demand.py` (multi-client `min()` aggregation, disconnect release, full-set-not-delta semantics, `has_market_stream` scoping, message validation), `quant_service/tests/test_greeks_dedupe.py` (fingerprint skip, staleness bound, per-chain and chain-vs-position isolation).
- [x] **Position prewarm no longer pins the chain pipeline** — *this was the dominant cost, a separate bug from the demand gating above.* `_release_view` only called `unregister_chain_key` when the key was in neither `_ui_views` **nor** `_prewarmed`, and `PositionSubscriber` marks every expiry holding an open position `prewarm=True`. So for any chain with a position on it, the UI releasing its view never stopped snapshot emission: full-rate chain snapshots — and the whole IV/Greeks/SVI/model pipeline behind them — ran for the life of the service **with zero clients connected**. Confirmed in logs: every client disconnected at 05:35:14 with `view_released` logged for all three chains, and at 05:36:26 NIFTY/CRUDEOIL/NATURALGAS were still dispatching every ~30 ms. `_mark_view`/`_release_view` now treat a prewarm as a reason to keep the *broker subscription and tick accumulation* warm only; the chain-snapshot pipeline is driven by `_ui_views` alone. Covered by `market_data_service/tests/test_subscription_views.py`.
- [x] **Mobile app asserts demand** — `mobile-app/src/lib/ws/stream-client.ts` had no `demand` action at all, so a connected phone fell through to the unasserted-chain fallback (the desktop active rate: 40 snapshots/s, each a full Greeks solve, for a phone screen). Added `setDemand()` with reconnect replay, and `use-chain-subscription.ts` now asserts 250 ms in the foreground / 2000 ms when `AppState` is backgrounded, re-asserts every 30 s, and drops its claim on unmount.
- **Measured** (market hours, no UI client connected, position prewarms active): `quant_service` 38.6% → 2.6% CPU; chain dispatches 900/30 s → 0; Greeks solves 770/30 s → 0. Whole td-desk stack ~73% → ~31%.
### Analytics Tiers — Compute Only What a Client Renders (2026-10-28)
The cadence work above decided *how often* the chain pipeline runs. This decides *which parts* run at all. Audit of the mobile app: it subscribes only `ticks:chain:{u}:{e}`, `orders:updates:default` and passive `ticks:option:{u}:{e}`; `OptionRow` renders strike/LTP/bid/ask; position P&L is derived client-side from the tick stream. It subscribes **no** `greeks:*`, `model:*`, `svi:*` or `vrp:*` topic and displays no Greek — so every indicator quant_service runs for a mobile-only session is waste.

- [x] **Two tiers, declared per indicator** — `greeks` (`ChainGreeksCalculator`: IV solve, Greeks strip, SVI fit, SVI alerts; `VrpCalculator`, which reads the SVI fit and renders in the always-visible desktop toolbar) and `models` (`ModelCalibrator`, `FastModelPricer`, `SlowModelPricer`). `register()` takes a `tier`; `TIER_ALWAYS` marks work not driven by chain demand (`HistoricalAggregator` on raw ticks, `StrategyAnalyzer` on order commands) so it is never filtered.
- [x] **Tier rides on the snapshot** — `OptionChainSnapshot.analytics` carries the union of connected clients' claims; `EventSubscriber._dispatch` filters indicators by it. No extra Redis state and no race: the tier arrives with the data it applies to. Carried on `position_chain_snapshot` too, so position Greeks are skipped for a client that doesn't render them.
- [x] **Union across clients, min on cadence** — `ConnectionManager` reduces tiers with `|` and cadence with `min()`. A phone can never starve a desktop of its Greeks. New `release_demand()` is called on disconnect *before* `disconnect()` so the remaining clients' union is republished at once — otherwise a quotes-only client dropping off would leave its narrow tier in force.
- [x] **Absent ≠ empty** — a missing `analytics` key means no client stated a need and **every tier runs** (fail toward the full pipeline, never silently starve a panel); an explicitly empty list is a real claim meaning quotes only. The same rule holds at every hop: `_parse_demand`, `_effective_demand`, `set_chain_analytics`, `get_indicators`.
- [x] **Demand can no longer start emission** — `set_view_rate` became `apply_demand`, which records the tier unconditionally but applies the cadence only to a chain the UI is actually viewing. The old "no view → `ensure_subscribed`" fallback was removed: with clients now claiming demand for expiries they merely hold *positions* in, it would have spun up the full chain feed for chains nobody has on screen.
- [x] **Desktop asks for less too** — `chain-demand.ts` maps each panel to its tiers, so a layout with no `model-comparison`/`mispricing-scanner` open skips Heston/VG calibration and FFT pricing entirely. Those two list `greeks` as well, since the model pricers calibrate against the SVI fit the Greeks tier produces.
- [x] **Mobile claims quotes-only** — new `mobile-app/src/lib/ws/demand.ts` merges claims from several screens by source (the wire format is a complete set, so the chain tab and the positions screen would otherwise overwrite each other) and takes the fastest cadence per chain, mirroring the gateway. `use-positions-subscription.ts` now claims quotes-only demand for every open-position expiry — those chains emit position snapshots whether or not anything views them, and without a claim the backend assumed the full pipeline and solved IV + Greeks over the whole strip for data the app never shows.
- **Verified end to end** by injecting snapshots on `ticks:chain:PROBE:2026-12-31` and counting quant log lines: `analytics: []` → 0 Greeks / 0 SVI / 0 model runs; `["greeks"]` → Greeks + SVI, no models; `["greeks","models"]` and the field absent → all of it.
- Note: `release_view` stops snapshot *emission* but deliberately keeps the broker subscription and `_accum`, so a returning viewer repaints from live accumulated ticks instead of waiting for the next tick on every strike.
- Next lever (not done, needs a product call): `PositionSubscriber` subscribes the specific position strikes on channel 16 **and** prewarms each position expiry's entire chain (470 NIFTY + 391 CRUDEOIL + 189 NATURALGAS tokens here). The full-chain prewarm is redundant for position LTP — it only buys instant first paint when opening that chain — and it is most of the remaining `market_data_service` ~16% / `api_gateway` ~13% idle CPU.
- Note: `quant_service/tests` can't be collected in the same pytest invocation as the other services' `tests` packages (`ModuleNotFoundError: No module named 'tests.*'`) — pre-existing, affects `make test-backend`; run each service's suite separately.

---

## Recent Fixes

- **Bare-int session message crashed WS fan-out → no option-chain data in UI.** `session_client.store_session` publishes a bare version int (`pipe.publish("session:kotak:version_changed", str(bundle.version))`). The gateway fan-out subscribes to the broad `session:*` pattern, so it received that int; `fan_out.py` then called `event_dict.get("payload", ...)` assuming a dict, raising `AttributeError: 'int' object has no attribute 'get'`. The exception broke the `async for` loop whose `finally` **unsubscribes every pattern** (including `ticks:chain:*`), so chain snapshots stopped reaching the browser even though `market_data_service` kept emitting them (`option chain snapshot emitted … strikes=105`). It crashed once per session version bump — notably at login (`authenticated_at`), exactly when the chain should first populate. **Fix:** in `backend/api_gateway/api_gateway/websockets/fan_out.py`, forward non-dict payloads as-is instead of calling `.get()` (`isinstance(event_dict, dict)` guard) so a scalar message can never tear down the subscription loop. Verified: `PUBLISH session:kotak:version_changed 99` now yields 0 `fan_out.error` (previously fatal).
- **redis-py 8.0 broke all pub/sub** (instrument select → no expiries, no option chain). redis-py 8.0.0 changed the default `socket_timeout` from `None` to `5s` (`redis/_defaults.py: DEFAULT_SOCKET_TIMEOUT = 5`). That 5s read timeout fires on blocking `pubsub.listen()` calls — which legitimately block until a message arrives — so every pub/sub consumer (`session_watcher`, `session_broker`, `quant_service.subscriber`, api_gateway fan-out) raised `TimeoutError: Timeout reading from redis:6379` every 5s. `quant_service` crash-looped; the market-data `session_watcher` died before recognizing the live Kotak session, so the scrip master never downloaded and `/expiries/{u}` returned `[]`. **Fix:** force `socket_timeout=None` (+ `socket_keepalive=True`) on the shared connection pool in `backend/shared/shared/redis_client.py:get_pool`. Single choke point — every service builds its pubsub via this pool. Note: the empty `access_token` in `session:kotak:current` is **by design** (tokens are process-local in-memory per `shared/live_session.py`, never persisted to Redis); a service restart requires a fresh TOTP login to repopulate them.
- **Healthcheck false-negative (fixed 2026-07-09):** market_data/quant/session_broker reported "unhealthy" because their Docker healthcheck calls `pgrep`, which wasn't installed in `python:3.12-slim` (`exit 127`). Fixed by installing `procps` in each service's base image stage.

## Known Issues

- Realized P&L differs from broker for carry-forward positions — Kotak `cfBuyAmt`/`cfSellAmt` use original trade prices (includes prior-day M2M), broker shows today's P&L only (post-settlement). Trade Report API (`/quick/user/trades`) now fetched for accurate intraday fills. FIFO P&L calculator now available in `shared/trade_logger.py` — needs frontend integration.
- OHLCV historical endpoint crashes (missing db_url argument) — **tracked in `docs/tracker/infra/INFRA.md`**
- TimescaleDB `ohlcv_1m` continuous aggregate column mismatch (`bucket` vs `ts`) — **tracked in `docs/tracker/infra/INFRA.md`**
- Ticks never written to TimescaleDB (`ticks` hypertable empty) — **tracked in `docs/tracker/infra/INFRA.md`**
- `open`/`high`/`low` fields empty for index static data (only `prevClose`/`change`/`pctChange` populate)
- `greeks` table unique index was missing for ON CONFLICT upsert — added in init.sql
- BSM put `charm` (`rust_core/src/bsm.rs`) adds `r·e^{-rT}`; with q=0 put charm should equal call charm. Left unchanged to keep NSE output stable — needs a deliberate fix
- `data/` (incl. `data/instruments.json`, the instrument source of truth) is gitignored — config changes aren't versioned
- `api_gateway/tests/test_place_orders.py` endpoint tests fail with 401 (auth dependency not overridden); `shared/tests/test_risk_analytics.py::test_build_regime_snapshot_event_tags` fails — both pre-existing

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
| Chain compute demand | `frontend/src/lib/chain-demand.ts` |
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
| Model calibrator | `backend/quant_service/.../indicators/calibrator.py` |
| Model pricer | `backend/quant_service/.../indicators/model_pricer.py` |
| Model comparison | `frontend/src/components/charts/model-comparison-panel.tsx` |
| Mispricing scanner | `frontend/src/components/charts/mispricing-scanner-panel.tsx` |
| Session client | `backend/shared/shared/session_client.py` |
| Session watcher | `backend/market_data_service/.../session_watcher.py` |
| Session broker | `backend/session_broker/session_broker/main.py` |
| Orders/Positions endpoint | `backend/api_gateway/.../routers/orders.py` |
| Market data endpoints | `backend/api_gateway/.../routers/market_data.py` |
| Analytics endpoints | `backend/api_gateway/.../routers/analytics.py` |
