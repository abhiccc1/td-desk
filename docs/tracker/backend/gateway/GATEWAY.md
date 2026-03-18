# Backend — API Gateway (`backend/api_gateway/`)

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Core
- [x] `pyproject.toml` — deps: td-desk-shared, fastapi, uvicorn, redis, httpx
- [x] `config.py` — `GatewaySettings` (order_service_url, jwt_secret, cors_origins)
- [x] `main.py` — FastAPI app with CORS, lifespan (httpx + fan_out), all routers + health + WS

## REST Routers
- [x] `routers/market_data.py` — GET `/option-chain/{underlying}/{expiry}`, GET `/quotes/{symbol}` (Redis cache reads)
- [x] `routers/analytics.py` — GET `/greeks/{underlying}/{expiry}`, POST `/strategy/analyze` (pub/sub with callback)
- [x] `routers/orders.py` — HTTP proxy to order_service via httpx
- [x] `routers/historical.py` — GET `/ohlcv/{symbol}` with time_bucket aggregation (1m/5m/15m/1h/1d)

## WebSocket
- [x] `websockets/manager.py` — `ConnectionManager` (topic→[ws], subscribe, broadcast, dead connection cleanup)
- [x] `websockets/handlers.py` — `/ws/stream` endpoint with JSON subscribe/unsubscribe protocol
- [~] `websockets/fan_out.py` — **BROKEN**: `subscribe()` called with wrong signature (missing `redis_url` param). Will crash at runtime.

## Middleware
- [~] `middleware/auth.py` — **Pass-through stub**: no JWT/API-key validation implemented
- [x] `middleware/rate_limit.py` — Token bucket: 100 req/60s per IP, 429 response

## Remaining
- [ ] Fix `fan_out.py` Redis subscriber integration
- [ ] Implement JWT authentication
- [ ] API key management
- [ ] Unit tests

## Summary
| Status | Count |
|--------|-------|
| Done | 9 |
| Partial/Stub | 2 |
| Not Started | 4 |
