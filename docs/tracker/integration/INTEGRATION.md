# Integration & End-to-End

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## WebSocket → Store Wiring
- [x] WebSocket client (`ws-client.ts`) with reconnect — **implemented but not wired to stores**
- [ ] Wire WS `onMessage` handler to dispatch ticks → `market-data-store.getState().updateTick()`
- [ ] Wire WS `onMessage` handler to dispatch Greeks → `greeks-store.getState().updateGreeks()`
- [ ] Wire WS `onMessage` handler to dispatch order updates → `position-store`
- [ ] Wire WS `onMessage` handler to dispatch risk exposure → `greeks-store.getState().setNetGreeks()`
- [ ] Auto-subscribe to relevant WS topics on underlying/expiry change

## End-to-End Data Flows
- [ ] Tick flow: Broker WS → Market Data Service → Redis → API Gateway WS → Frontend AG Grid
- [ ] Greeks flow: Tick → Quant Service → Redis → API Gateway WS → Frontend Greeks panel
- [ ] Order flow: Frontend basket → API Gateway → Order Service → Broker → Fill → Position update

## Summary
| Status | Count |
|--------|-------|
| Done | 1 |
| Not Started | 8 |
