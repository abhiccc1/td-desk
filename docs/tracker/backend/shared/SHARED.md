# Backend — Shared Library (`backend/shared/`)

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Package & Config
- [x] `pyproject.toml` — `td-desk-shared` package (pydantic, redis, sqlalchemy, asyncpg, structlog, fastapi)
- [x] `config.py` — `BaseServiceSettings` (pydantic-settings, .env support)
- [x] `logging.py` — structlog setup with service-name context binding

## Schemas
- [x] `schemas/events.py` — `RedisEvent` envelope + `EventType` enum (9 event types)
- [x] `schemas/tick.py` — `TickData`, `OptionStrike`, `OptionChainSnapshot`
- [x] `schemas/greeks.py` — `GreeksResult`, `IVSurface`
- [x] `schemas/order.py` — `OrderRequest`, `OrderFill`, `Position`, `OrderSide/Type/Status` enums
- [x] `schemas/strategy.py` — `StrategyLeg`, `StrategyResult`, `MarginInfo`

## Infrastructure Clients
- [x] `redis_client.py` — async pool, `publish_event`, `subscribe` (with pattern), `cache_set/get`, `cache_hset/hgetall`
- [x] `db.py` — async SQLAlchemy engine factory with singleton + `close_engine()`
- [x] `health.py` — `/health` router + `check_redis()` + `check_db()`

## Summary
| Status | Count |
|--------|-------|
| Done | 11 |
| Partial/Stub | 0 |
| Not Started | 0 |
