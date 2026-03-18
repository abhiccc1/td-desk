# Frontend — Inline Order UI (Option Chain Integration)

> Resizable order drawer pinned to bottom of the option chain panel. Draggable divider
> to allocate space between grid and basket. Click bid/ask cells to add legs.
> Strategy template chips for presets. Inline-editable legs.

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

---

## 1. Type Changes
- [x] `types/market-data.ts` — `OptionType = "CE" | "PE"`, `Side = "BUY" | "SELL"` type aliases
- [x] `types/market-data.ts` — Tightened `StrategyLeg.optionType` and `.side` to use new types
- [x] `order-basket/leg-editor.tsx` — Option values updated from `"C"/"P"` → `"CE"/"PE"`
- [x] `order-basket/basket-panel.tsx` — Default leg `optionType` updated to `"CE"`

## 2. Basket Store Enhancements
- [x] `stores/basket-store.ts` — `addLegFromChain()` action: builds symbol string (`NIFTY2026031922500CE`), deduplicates by strike/type/side
- [x] `stores/basket-store.ts` — `buildActiveLegSet(legs) → Set<string>` keyed `{strike}-{CE|PE}-{BUY|SELL}`
- [x] `stores/basket-store.ts` — `computeNetCredit()` unchanged, works with new types

## 3. Option Chain Grid — Click-to-Trade
- [x] `option-chain/option-chain-grid.tsx` — Exported `OptionChainRow` type
- [x] `option-chain/option-chain-grid.tsx` — Accepts `onCellClicked` + `activeLegSet` props
- [x] `option-chain/option-chain-grid.tsx` — `cellClass` rules: `cell-clickable`, `cell-leg-sell` (red), `cell-leg-buy` (green) on bid/ask columns
- [x] `option-chain/option-chain-grid.tsx` — `rowClassRules`: `row-has-leg` (blue tint) on rows with any active leg
- [x] `option-chain/option-chain-grid.tsx` — `context` passes `activeLegSet` to AG Grid; `refreshCells()` on change
- [x] `option-chain/use-cell-click-handler.ts` — Hook mapping `callBid→SELL CE`, `callAsk→BUY CE`, `putBid→SELL PE`, `putAsk→BUY PE`

## 4. Option Chain Panel — Wiring & Resizable Split
- [x] `option-chain/option-chain-panel.tsx` — Computes `activeLegSet` via `useMemo(buildActiveLegSet(legs))`
- [x] `option-chain/option-chain-panel.tsx` — Wires `useCellClickHandler` and passes to grid
- [x] `option-chain/option-chain-panel.tsx` — Renders `InlineOrderDrawer` below grid
- [x] `option-chain/option-chain-panel.tsx` — Draggable vertical resize handle between grid and drawer (mousedown → mousemove tracking)
- [x] `option-chain/option-chain-panel.tsx` — Drawer height clamped: min 600px when open, max = container − 100px (grid min) − 6px (handle)
- [x] `option-chain/option-chain-panel.tsx` — Auto-expands to 600px on first leg, collapses to 32px on clear
- [x] `option-chain/option-chain-panel.tsx` — Click collapsed bar to manually expand (shows full order UI with templates even with 0 legs)
- [x] `option-chain/option-chain-panel.tsx` — Toggle: `isCollapsed` + `onToggle` props passed to drawer

## 5. Inline Order Drawer
- [x] `option-chain/inline-order-drawer.tsx` — Collapsed bar: clickable, shows leg count + net credit or "Click bid/ask to add legs" hint
- [x] `option-chain/inline-order-drawer.tsx` — Expanded empty state: template chips + empty-state hint + action bar (+ Leg, Analyze, Submit, Clear, Collapse)
- [x] `option-chain/inline-order-drawer.tsx` — Expanded with legs: template chips, scrollable leg rows, action bar — fills parent height
- [x] `option-chain/inline-order-drawer.tsx` — Collapse button in action bar to return to 32px bar

## 6. Strategy Templates
- [x] `option-chain/strategy-templates.ts` — `StrategyTemplate` type with `legs[]{strikeOffset, optionType, side}`
- [x] `option-chain/strategy-templates.ts` — 5 templates: Short Straddle, Short Strangle, Bull Put Spread, Bear Call Spread, Iron Condor
- [x] `option-chain/strategy-templates.ts` — `applyTemplate()` resolves offsets to ATM-relative strikes, looks up premiums from chain snapshot

## 7. Compact Leg Row
- [x] `option-chain/compact-leg-row.tsx` — Single-line 28px display: `[SELL] [CE] 22600 @ 145.50 x1 [X]`
- [x] `option-chain/compact-leg-row.tsx` — Side pill colored red/green
- [x] `option-chain/compact-leg-row.tsx` — Inline-editable premium and quantity (click to edit)

## 8. CSS / Styling
- [x] `dashboard/trading-dashboard.tsx` — `.cell-clickable` (cursor-pointer + blue hover)
- [x] `dashboard/trading-dashboard.tsx` — `.cell-leg-sell` (red tint), `.cell-leg-buy` (green tint)
- [x] `dashboard/trading-dashboard.tsx` — `.row-has-leg` (subtle blue tint)

## 9. Remaining / Follow-up
- [ ] Keyboard shortcut support (e.g., Esc to collapse drawer, Enter to submit)
- [ ] Lot size awareness (NIFTY=65) — auto-set quantity to lot multiples
- [ ] Premium auto-refresh from live market data ticks
- [ ] Margin requirement display inline in drawer (needs quant service wiring)
- [ ] Undo last leg action
- [ ] Visual feedback on leg add

---

## Summary
| Status | Count |
|--------|-------|
| Done | 29 |
| Not Started | 6 |

**Build verification:** `npx tsc --noEmit` — clean, zero errors.
