# Backend — Order Service (`backend/order_service/`)

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Core
- [x] `pyproject.toml` — deps: td-desk-shared, fastapi, uvicorn, redis
- [x] `config.py` — `OrderSettings` (broker creds)
- [x] `main.py` — FastAPI app with lifespan, Redis command listener, health router

## Broker Integration
- [x] `brokers/base.py` — `BrokerExecutor` Protocol (place_order, cancel_order)
- [~] `brokers/nse_broker.py` — `NSEBrokerExecutor` **stub returning mock fills**
- [~] `brokers/mcx_broker.py` — `MCXBrokerExecutor` **stub returning mock fills**

## Order Management
- [x] `basket.py` — State machine: DRAFT→VALIDATED→SUBMITTED→PARTIAL_FILL→FILLED|REJECTED|CANCELLED
- [x] `executor.py` — Multi-leg parallel execution via `asyncio.gather()`
- [x] `router.py` — FastAPI: basket CRUD, submit, positions, P&L

## Position Tracking
- [x] `position_tracker.py` — In-memory position tracking + P&L calc
- [~] `position_tracker.py` — **DB persistence is TODO** (only logs, no TimescaleDB write)

## Events
- [x] `publisher.py` — publishes order events to `orders:updates:{user_id}`

## Remaining
- [ ] Real broker API integration (NSE/MCX order placement)
- [ ] Order cancellation flow
- [ ] Margin pre-trade checks (validate margin before submission)
- [ ] Unit tests

## Summary
| Status | Count |
|--------|-------|
| Done | 9 |
| Partial/Stub | 3 |
| Not Started | 4 |
