# Frontend — UI Panels

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Dashboard & Windowing (react-mosaic)
- [x] `dashboard/trading-dashboard.tsx` — `<Mosaic<PanelId>>` with controlled state, dark theme CSS
- [x] `dashboard/panel-registry.tsx` — exhaustive `renderPanelContent()` switch

## Option Chain (AG Grid)
- [x] `option-chain/option-chain-panel.tsx` — underlying/expiry selectors + grid wrapper
- [x] `option-chain/option-chain-grid.tsx` — 13-column grid (Call OI/Delta/IV/LTP/Ask/Bid | Strike | Put Bid/Ask/LTP/IV/Delta/OI)
- [x] High-frequency update: `applyTransactionAsync()` via Zustand `subscribe()` (bypasses React renders)
- [x] **Inline Order UI** — click bid/ask to add legs, collapsible drawer, strategy templates → [ORDER_UI.md](../order-ui/ORDER_UI.md)
- [ ] Greeks columns populated from greeks-store (currently `null` — needs wiring to `greeks:computed` WS topic)
- [ ] ATM strike highlighting (highlight row nearest to underlying price)
- [ ] Expiry selector fetches available expiries from API

## Price Chart (TradingView Lightweight Charts)
- [x] `charts/price-chart-panel.tsx` — `createChart()` with `CandlestickSeries`, dark theme
- [x] Direct `series.update()` via Zustand subscription (no React re-renders)
- [x] `ResizeObserver` for responsive sizing
- [ ] Load historical OHLCV candles on mount (currently only shows live tick updates)
- [ ] Multiple timeframe support (1m, 5m, 15m, 1h)
- [ ] Volume bars overlay

## Payoff Diagram (Visx)
- [x] `charts/payoff-diagram.tsx` — LinePath payoff curve, colored profit/loss regions, breakeven dots
- [x] Responsive sizing via `ParentSize`
- [ ] Update payoff dynamically as underlying price changes (currently static from basket legs)
- [ ] Show current underlying price marker on X axis
- [ ] Max profit / max loss / PoP labels on the chart

## Position Monitor (AG Grid)
- [x] `positions/position-monitor.tsx` — Symbol, Side, Qty, Avg Price, LTP, P&L, P&L% columns
- [x] Conditional P&L coloring (green/red)
- [x] Total P&L summary footer
- [ ] Wire live LTP updates from market-data-store
- [ ] Close position / partial exit actions

## Order Basket
- [x] `order-basket/basket-panel.tsx` — Add leg, Analyze (API call), Submit (API call)
- [x] `order-basket/leg-editor.tsx` — symbol, strike, optionType (`CE`/`PE`), side, quantity, premium inputs
- [x] Net credit/debit display
- [x] Strategy templates (Short Straddle, Short Strangle, Bull Put Spread, Bear Call Spread, Iron Condor) → via inline drawer [ORDER_UI.md](../order-ui/ORDER_UI.md)
- [ ] Real-time premium refresh from market data
- [ ] Margin requirement display from strategy analysis

## Greeks Exposure
- [x] `greeks/greeks-exposure.tsx` — Net Delta, Gamma, Theta, Vega cards with color coding
- [ ] Per-position Greeks breakdown table
- [ ] Theta decay curve (time series of daily theta)
- [ ] ETF collateral utilization gauge

## Summary
| Status | Count |
|--------|-------|
| Done | 18 |
| Not Started | 12 |
