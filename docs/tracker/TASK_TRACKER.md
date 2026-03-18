# TD-Desk: Implementation Task Tracker

> Real-time options trading dashboard for NSE & MCX.
> Non-directional strategies (short strangles, iron condors), theta decay tracking, multi-leg Greek exposure, margin/collateral monitoring.

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

---

## Tracker Index

| Module | File | Done | Partial | Remaining |
|--------|------|------|---------|-----------|
| Infrastructure | [infra/INFRA.md](infra/INFRA.md) | 12 | 2 | 5 |
| **Backend** | | | | |
| Shared Library | [backend/shared/SHARED.md](backend/shared/SHARED.md) | 11 | 0 | 0 |
| Market Data Svc | [backend/market-data/MARKET_DATA.md](backend/market-data/MARKET_DATA.md) | 9 | 0 | 2 |
| Quant Service | [backend/quant/QUANT.md](backend/quant/QUANT.md) | 10 | 0 | 3 |
| Order Service | [backend/orders/ORDERS.md](backend/orders/ORDERS.md) | 9 | 3 | 4 |
| API Gateway | [backend/gateway/GATEWAY.md](backend/gateway/GATEWAY.md) | 9 | 2 | 4 |
| **Frontend** | | | | |
| Core (types, stores, lib) | [frontend/core/CORE.md](frontend/core/CORE.md) | 17 | 0 | 0 |
| Mock Data Module | [frontend/mocks/MOCKS.md](frontend/mocks/MOCKS.md) | 15 | 0 | 0 |
| UI Panels | [frontend/panels/PANELS.md](frontend/panels/PANELS.md) | 18 | 0 | 12 |
| Inline Order UI | [frontend/order-ui/ORDER_UI.md](frontend/order-ui/ORDER_UI.md) | 26 | 0 | 6 |
| **Cross-Cutting** | | | | |
| Integration & E2E | [integration/INTEGRATION.md](integration/INTEGRATION.md) | 1 | 0 | 8 |
| **Backlog** | | | | |
| Testing | [backlog/TESTING.md](backlog/TESTING.md) | 0 | 0 | 4 |
| Advanced Biz Logic | [backlog/ADVANCED_BIZ_LOGIC.md](backlog/ADVANCED_BIZ_LOGIC.md) | 0 | 0 | 6 |
| DevOps & Production | [backlog/DEVOPS.md](backlog/DEVOPS.md) | 0 | 0 | 6 |
| UX Polish | [backlog/UX_POLISH.md](backlog/UX_POLISH.md) | 0 | 0 | 6 |
| **Total** | | **137** | **7** | **66** |

**Overall: ~65% complete — 35% remaining (integration, testing, advanced features, polish)**

---

## Directory Structure

```
docs/tracker/
├── TASK_TRACKER.md              ← you are here (index)
├── infra/
│   └── INFRA.md                 # Docker, Redis, TimescaleDB, scaffolding
├── backend/
│   ├── shared/
│   │   └── SHARED.md            # Schemas, redis_client, db, config
│   ├── market-data/
│   │   └── MARKET_DATA.md       # Connectors, publisher, snapshot
│   ├── quant/
│   │   └── QUANT.md             # Indicators, registry, persistence
│   ├── orders/
│   │   └── ORDERS.md            # Basket, executor, position tracker
│   └── gateway/
│       └── GATEWAY.md           # Routers, WebSocket, middleware
├── frontend/
│   ├── core/
│   │   └── CORE.md              # Types, stores, lib, build config
│   ├── panels/
│   │   └── PANELS.md            # Option chain, charts, positions, basket, greeks
│   └── order-ui/
│       └── ORDER_UI.md          # Inline order drawer, click-to-trade, strategy templates
├── integration/
│   └── INTEGRATION.md           # WS→store wiring, E2E data flows
└── backlog/
    ├── TESTING.md
    ├── ADVANCED_BIZ_LOGIC.md
    ├── DEVOPS.md
    └── UX_POLISH.md
```

---

## Priority Next Steps

1. **Fix `fan_out.py`** — broken Redis→WS bridge blocks all real-time data delivery → [GATEWAY.md](backend/gateway/GATEWAY.md)
2. **Wire WS→Store integration** — connect WebSocket messages to Zustand stores → [INTEGRATION.md](integration/INTEGRATION.md)
3. **Historical data on chart mount** — load OHLCV candles so price chart isn't empty → [PANELS.md](frontend/panels/PANELS.md)
4. **Greeks columns in option chain** — wire `greeks:computed` topic to AG Grid → [PANELS.md](frontend/panels/PANELS.md)
5. **Alembic migrations** — proper schema versioning instead of relying on init.sql → [INFRA.md](infra/INFRA.md)
6. **Docker Compose smoke test** — verify full stack boots cleanly → [INFRA.md](infra/INFRA.md)
