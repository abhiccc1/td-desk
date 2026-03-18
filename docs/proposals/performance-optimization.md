# Performance Optimization Plan: Absolute Latency Reduction

## Context

The trading dashboard currently has an estimated **150-300ms tick-to-pixel latency**, dominated by:
- Snapshot throttle floor (75-200ms)
- Per-strike Greeks fan-out (N individual Redis publishes + N WS sends per chain update)
- JSON serialization overhead (5+ ser/deser hops through the pipeline)
- Full-grid rebuilds on every store update (including `JSON.stringify` row comparison)

An existing proposal (`docs/proposals/option-chain-latency-reduction.md`) covers incremental pipeline fixes (throttle tuning, event-driven connector, raw-tick overlay, incremental grid). The gRPC proposal (`docs/proposals/grpc.md`) explores architectural shifts: Tauri IPC, gRPC streaming, Python sidecar, and thick-client.

This plan synthesizes both proposals into a unified, prioritized roadmap for **maximum latency reduction** — from quick wins to architectural changes — with clear guidance on what's worth doing.

---

## Tier 1: Quick Wins (No Architecture Change)

### 1A. Batch Greeks at Source (Highest ROI Single Change)

**Problem:** `ChainGreeksCalculator.compute()` returns N individual `RedisEvent` objects (one per strike/side). For a NIFTY chain with ~80 valid options, this means 80 sequential Redis PUBLISHes, 80 fan-out deserializations, 80 WebSocket sends, and 80 frontend store updates.

**Change:** Return a single `GREEKS_BATCH_COMPUTED` event containing all Greeks for one chain snapshot.

**Expected gain: ~75-155ms off the critical path.**

**Files:**
- `backend/quant_service/quant_service/indicators/greeks.py` — wrap all `GreeksResult` into one batch event
- `backend/shared/shared/schemas/events.py` — add `GREEKS_BATCH_COMPUTED` to EventType
- `backend/quant_service/quant_service/publisher.py` — route new event type to `greeks:batch:{underlying}:{expiry}`
- `backend/api_gateway/api_gateway/websockets/fan_out.py` — add `greeks:batch:*` to `_CHANNEL_PATTERNS`
- `frontend/src/lib/data-feed-orchestrator.ts` — handle `greeks:batch:` topic prefix
- `frontend/src/stores/greeks-store.ts` — already has batch support, verify compatibility

**Note:** The frontend already batches incoming Greeks via `requestAnimationFrame` — but that's a band-aid. Batching at the source eliminates 79 out of 80 Redis publishes, fan-out cycles, and WS sends.

### 1B. Fix AG Grid Row Comparison

**Problem:** `rowChanged()` at `option-chain-grid.tsx:214` uses `JSON.stringify(prev) !== JSON.stringify(next)` — ~500+ stringify calls/sec at 10Hz for 50+ rows.

**Change:** Replace with shallow field comparison on the ~16 numeric fields that actually change.

**Expected gain: ~2-5ms main-thread CPU per update cycle.**

**Files:**
- `frontend/src/components/option-chain/option-chain-grid.tsx` — replace `rowChanged` function

### 1C. Switch to orjson

**Problem:** Standard `json.dumps`/`json.loads` used throughout backend. Chain snapshot JSON (~15KB for 50 strikes) takes ~1.5ms to serialize with stdlib.

**Change:** Replace with `orjson` (Rust-backed, 3-10x faster). Key call sites:
- `snapshot.py` — snapshot serialization
- `fan_out.py:52` — `json.dumps({"topic": ..., "payload": ...})`
- `kotak_neo.py` — `json.loads` in `on_message`
- `handlers.py` — WS message parsing

**Expected gain: ~8-15ms cumulative across the pipeline.**

**Files:**
- `backend/shared/pyproject.toml` — add `orjson>=3.10`
- `backend/market_data_service/market_data_service/snapshot.py`
- `backend/api_gateway/api_gateway/websockets/fan_out.py`
- `backend/market_data_service/market_data_service/connectors/kotak_neo.py`
- `backend/api_gateway/api_gateway/websockets/handlers.py`

### 1D. Persistent Redis Client in Quant Publisher

**Problem:** `publish_event()` opens/closes a Redis client per call. With batched Greeks (1A) this matters less, but still applies to model prices and SVI alerts.

**Change:** Maintain a persistent Redis client in the quant service publisher (same pattern `TickPublisher` already uses).

**Files:**
- `backend/quant_service/quant_service/publisher.py`

---

## Tier 2: Existing Latency Reduction Proposal (Execute As-Written)

The `docs/proposals/option-chain-latency-reduction.md` phases should be executed in order. They complement Tier 1:

| Phase | Summary | Effort | Key Files |
|-------|---------|--------|-----------|
| Phase 1 | Lower snapshot throttle to 50-100ms, event-driven connector, add timestamps | 1-2d | `config.py`, `snapshot.py`, `kotak_neo.py` |
| Phase 2 | Move Redis work off tick hot path, internal buffering | 1-2d | `main.py`, `publisher.py` |
| Phase 3 | Incremental AG Grid (stop full-grid rebuilds, narrow store subscriptions) | 2-3d | `option-chain-grid.tsx`, stores |
| Phase 4 | Batch Greeks (overlaps with our Tier 1A — do 1A first, this phase becomes trivial) | 1d | `greeks.py`, orchestrator |
| Phase 5 | Raw-tick price overlay (LTP/bid/ask from direct ticks, snapshots for structure only) | 2-4d | `publisher.py`, `fan_out.py`, orchestrator, stores |

**Phase 5 is the strongest functional fix** — it decouples price columns from the snapshot throttle entirely. After Phase 5, LTP updates are near-instant while analytics columns update at ~50-100ms.

---

## Tier 3: Tauri IPC — Move Computation to Client

### 3A. Embed td_core in Tauri Rust Core

**Problem:** Currently: chain snapshot → Redis → quant service (td_core via PyO3) → Redis → fan-out → WS → frontend. This round-trip adds ~50-100ms for Greeks computation delivery.

**Change:** Refactor td_core into a Cargo workspace:
```
td-core/              (pure Rust lib, no PyO3)
  src/bsm.rs, svi.rs, heston.rs, vg.rs, fft.rs, lib.rs

td-core-pyo3/         (thin PyO3 wrapper, imports td-core)
  src/lib.rs

frontend/src-tauri/   (depends on td-core, registers IPC commands)
  src/lib.rs           #[tauri::command] for greeks, svi, etc.
```

Frontend receives chain snapshot via WS, then calls `invoke('compute_chain_greeks', {...})` → Tauri Rust core computes locally → IPC response in ~5-15ms.

**Expected gain: ~35-85ms (eliminates quant service round-trip for active view).**

**What stays on the server:**
- Market data ingestion + Kotak SDK: stays (needs broker WS connection)
- IV history persistence to TimescaleDB: stays (needs DB)
- SVI alert detection: could move to client, low priority

**What moves to client:**
- Greeks/IV computation for active chain
- SVI surface fitting for active chain
- Heston/VG model pricing for active chain

**Files:**
- `backend/quant_service/rust_core/Cargo.toml` — extract into workspace
- `backend/quant_service/rust_core/src/lib.rs` — split PyO3 wrappers from core
- `frontend/src-tauri/Cargo.toml` — add `td-core` dependency + serde
- `frontend/src-tauri/src/lib.rs` — add `#[tauri::command]` functions
- `frontend/src/lib/data-feed-orchestrator.ts` — invoke local Greeks on chain snapshot

**Risk:** Medium. The td_core Rust code is already cleanly separated from PyO3 bindings — each `.rs` module exports pure Rust functions, and `lib.rs` wraps them with `#[pyfunction]`. Extraction is straightforward.

---

## Tier 4: gRPC / MessagePack (NOT Recommended Now)

### Analysis

Replacing Redis pub/sub with gRPC streaming between backend services would save ~2-5ms per message (faster protobuf serialization + direct TCP vs Redis hop). However:

- Requires `.proto` definitions for all message types
- Adds gRPC server/client complexity to each service
- Loses Redis's built-in pattern matching and multi-subscriber fan-out
- The 2-5ms saving is negligible compared to Tier 1+2+3 gains

**MessagePack** as an intermediate step (replace JSON in Redis channels) saves ~1-3ms but adds protocol complexity for marginal gain once orjson is in place.

**Verdict:** Skip. Combined Tier 1+2+3 already delivers ~160-330ms improvement. The remaining 2-5ms from gRPC is not perceptible for manual trading.

---

## Tier 5: Sidecar / Thick Client (NOT Recommended Now)

### Python Sidecar
- Bundles market data service + Kotak SDK as PyInstaller binary inside Tauri
- Single-click desktop app, no Docker
- Adds ~100-200MB to bundle, macOS signing pain, harder debugging
- **No latency benefit** (just deployment convenience)

### Full Rust Rewrite
- Eliminates all Python, Redis, API gateway
- Requires reverse-engineering Kotak's binary WS protocol (~2-4 weeks)
- Saves ~10-20ms additional over Tier 3
- Locks you into one broker forever

**Verdict:** Not worth it unless distributing the app commercially or permanently committed to Kotak as sole broker.

---

## Recommended Execution Order

### Week 1: Immediate Wins
1. **Tier 1A** — Batch Greeks at source (~75-155ms saved, ~4h effort)
2. **Tier 1B** — Fix AG Grid row comparison (~2-5ms CPU, ~30min)
3. **Tier 1C** — orjson switch (~8-15ms saved, ~2h)
4. **Tier 1D** — Persistent Redis in quant (~1h)
5. **Tier 2 Phase 1** — Throttle tuning + event-driven connector + timestamps (1-2d)

### Week 2: Pipeline & Frontend
6. **Tier 2 Phase 2** — Remove backend backlog pressure (1-2d)
7. **Tier 2 Phase 3** — Incremental AG Grid (2-3d)

### Week 3: Raw-Tick Overlay
8. **Tier 2 Phase 5** — Raw-tick price overlay for LTP/bid/ask (2-4d)

### Week 4+: Tauri IPC (Optional, High Impact)
9. **Tier 3A** — Embed td_core in Tauri, compute Greeks locally (2-3d)

---

## Expected End State

| Metric | Current | After Tier 1+2 | After Tier 3 |
|--------|---------|----------------|--------------|
| LTP tick-to-pixel | 150-300ms | ~20-40ms (raw-tick overlay) | ~20-40ms |
| Greeks tick-to-pixel | 200-400ms | ~80-120ms | ~30-60ms |
| Grid CPU per update | High (full rebuild) | Low (incremental) | Low |
| Ser/deser overhead | ~15-25ms cumulative | ~3-5ms (orjson) | ~1-2ms (IPC) |

For a manual trading dashboard, **Tier 1+2 alone achieves terminal-grade pricing** (~20-40ms LTP). Tier 3 is valuable if you want near-instant Greeks/analytics columns.

---

## Verification

- **Before starting:** Instrument end-to-end latency (broker tick timestamp → UI paint timestamp) as Phase 1 of the existing proposal
- **After each tier:** Compare measured latency against baseline
- **AG Grid:** Profile with Chrome DevTools Performance tab during live NIFTY chain updates
- **Greeks batch:** Verify via Redis MONITOR that chain snapshot produces 1 `greeks:batch:*` publish (not N individual publishes)
- **Tauri IPC:** Verify via `console.time`/`console.timeEnd` around `invoke('compute_chain_greeks')` calls

---

## Key Files Reference

| Component | Path |
|-----------|------|
| Greeks calculator (batch fix) | `backend/quant_service/quant_service/indicators/greeks.py` |
| Event types | `backend/shared/shared/schemas/events.py` |
| Fan-out bridge | `backend/api_gateway/api_gateway/websockets/fan_out.py` |
| Snapshot aggregator | `backend/market_data_service/market_data_service/snapshot.py` |
| Tick publisher | `backend/market_data_service/market_data_service/publisher.py` |
| Kotak connector | `backend/market_data_service/market_data_service/connectors/kotak_neo.py` |
| AG Grid (row comparison) | `frontend/src/components/option-chain/option-chain-grid.tsx` |
| Data feed orchestrator | `frontend/src/lib/data-feed-orchestrator.ts` |
| Market data store | `frontend/src/stores/market-data-store.ts` |
| Greeks store | `frontend/src/stores/greeks-store.ts` |
| Rust core (td_core) | `backend/quant_service/rust_core/src/` |
| Tauri app | `frontend/src-tauri/` |
| Existing latency proposal | `docs/proposals/option-chain-latency-reduction.md` |
| gRPC proposal | `docs/proposals/grpc.md` |
