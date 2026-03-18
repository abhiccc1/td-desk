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
- [x] `infra/docker/timescaledb/init.sql` — hypertables for `ticks`, `greeks`, `order_events`, `portfolio_snapshots`
- [x] Continuous aggregate `ohlcv_1m` (1-minute OHLCV from ticks)
- [ ] Continuous aggregate `ohlcv_5m` (5-minute, cascading from 1m)
- [ ] Compression policy on `ticks` (older than 1 day)
- [ ] Retention policy on `ticks` (30-day drop)
- [~] Alembic migrations — directory exists, **no migration files created yet**

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
| Done | 12 |
| Partial/Stub | 2 |
| Not Started | 5 |
