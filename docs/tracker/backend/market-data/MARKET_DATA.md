# Backend — Market Data Service (`backend/market_data_service/`)

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Core
- [x] `pyproject.toml` — deps: td-desk-shared, websockets, redis
- [x] `config.py` — `MarketDataSettings` (NSE/MCX URLs, broker creds, snapshot throttle)
- [x] `main.py` — runs NSE+MCX connectors concurrently, signal handlers

## Connectors
- [x] `connectors/base.py` — `BrokerConnector` Protocol (connect, subscribe, stream, disconnect)
- [x] `connectors/nse.py` — `NSEConnector` with WebSocket logic, header auth, JSON parsing → TickData
- [x] `connectors/mcx.py` — `MCXConnector` (same pattern as NSE)

## Publishing & Caching
- [x] `publisher.py` — `TickPublisher`: publishes to `ticks:raw:{exchange}`, caches LTP
- [x] `snapshot.py` — `SnapshotAggregator`: throttled chain snapshots, regex symbol parser, Redis HSET

## Resilience
- [x] `reconnect.py` — `ReconnectManager`: exponential backoff 1s→60s, reset on success

## Remaining
- [ ] Real broker API integration (currently expects generic WebSocket JSON — needs actual NSE/MCX feed format adapters)
- [ ] Unit tests

## Summary
| Status | Count |
|--------|-------|
| Done | 9 |
| Not Started | 2 |
