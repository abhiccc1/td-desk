# Infrastructure & Scaffolding

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Project Scaffolding
- [x] Monorepo structure with `frontend/` and `backend/` separation
- [x] `docker-compose.yml` — 7 services (Redis, TimescaleDB, 4 backend, frontend)
- [~] `docker-compose.override.yml` — dev overrides with hot-reload volume mounts *(not yet created)*
- [x] `.env.example` with all service variables
- [x] `.gitignore`
- [x] `Makefile` — `make up/down/test/lint/migrate/seed`
- [x] `scripts/setup.sh` — one-command local setup
- [x] `scripts/db-migrate.sh`
- [x] `scripts/seed-data.py` — sample NIFTY option chain seed

## Redis
- [x] `infra/docker/redis/redis.conf` — appendonly, maxmemory 512mb, LRU eviction
- [x] Pub/Sub channel design: `ticks:raw:*`, `ticks:chain:*`, `greeks:computed:*`, `orders:*`, `risk:exposure`
- [x] Cache key design: `cache:ltp:*`, `cache:chain:*`, `cache:greeks:*`

## TimescaleDB
- [x] `infra/docker/timescaledb/init.sql` — hypertables for `ticks`, `greeks`, `order_events`, `portfolio_snapshots`, `trade_logs`
- [~] Continuous aggregate `ohlcv_1m` (1-minute OHLCV from ticks) — **BROKEN**: column mismatch (`bucket` vs `ts` in query), no refresh policy, historical endpoint crashes (missing `db_url` arg in `historical.py` line 24)
- [ ] Continuous aggregate `ohlcv_5m` (5-minute, cascading from 1m)
- [ ] Compression policy on `ticks` (older than 1 day)
- [ ] Retention policy on `ticks` (30-day drop)
- [~] Alembic migrations — directory exists, **no migration files created yet**
- [ ] **Ticks never written to TimescaleDB** — `ticks` hypertable is empty. `publisher.py` in market_data_service only publishes to Redis, never INSERTs to DB. Need `TickPersister` with batched async writes (buffer ~500, flush every 1-2s). Blocks all historical data, OHLCV aggregation, and charting.

## Docker
- [x] Dockerfile for `market_data_service` (multi-stage: base/dev/prod)
- [x] Dockerfile for `quant_service`
- [x] Dockerfile for `order_service`
- [x] Dockerfile for `api_gateway`
- [x] `frontend/Dockerfile` (multi-stage: deps → build → nginx)
- [x] `frontend/Dockerfile.dev` (Node alpine with hot-reload)
- [ ] Verify full `docker compose up` boots cleanly end-to-end
- [ ] Health check chain verified (infra → backend → frontend)

## Summary
| Status | Count |
|--------|-------|
| Done | 13 |
| Partial/Stub | 2 |
| Not Started | 6 |
