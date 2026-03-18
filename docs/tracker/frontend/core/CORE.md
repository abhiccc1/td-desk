# Frontend — Core (`frontend/`)

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Configuration & Build
- [x] Next.js 15 + React 19 + TypeScript
- [x] Tailwind CSS configured
- [x] shadcn/ui initialized (button component)
- [x] `next.config.ts` — static export (`output: "export"`)
- [x] `app/layout.tsx` — dark theme root (`#0f0f1a` bg, monospace font)
- [x] `app/page.tsx` — dynamic import of TradingDashboard (SSR disabled)
- [x] `Dockerfile` + `Dockerfile.dev`
- [x] `.env.local.example`
- [x] Build passes (`next build` succeeds, `tsc --noEmit` clean)

## Type Definitions
- [x] `types/panels.ts` — `PanelId` union (6 panels) + `PANEL_TITLES`
- [x] `types/market-data.ts` — `TickData`, `OptionStrike`, `OptionChainSnapshot`, `GreeksResult`, `StrategyLeg`, `MarginInfo`, `StrategyResult`
- [x] `types/orders.ts` — `OrderSide`, `OrderType`, `OrderStatus`, `OrderRequest`, `OrderFill`, `Position`

## State Management (Zustand)
- [x] `stores/market-data-store.ts` — ticks Map + optionChain + `getState()` pattern for render bypass
- [x] `stores/basket-store.ts` — legs array + auto-calculated `netCredit`
- [x] `stores/position-store.ts` — positions + `totalPnl`
- [x] `stores/greeks-store.ts` — greeks Map + net aggregates (delta, gamma, theta, vega)
- [x] `stores/layout-store.ts` — Mosaic layout tree + `persist` middleware (localStorage `"td-desk-layout"`)

## Client Libraries
- [x] `lib/ws-client.ts` — `WSClient` with connect, subscribe, unsubscribe, disconnect, exponential backoff reconnect (1s→30s)
- [x] `lib/api-client.ts` — REST client: `fetchOptionChain`, `fetchQuote`, `fetchGreeks`, `fetchOHLCV`, `createBasket`, `addLeg`, `submitBasket`, `fetchPositions`, `analyzeStrategy`

## Summary
| Status | Count |
|--------|-------|
| Done | 17 |
| Not Started | 0 |
