# Risk Management Implementation Plan

This plan turns the risk-management roadmap into concrete implementation tasks across backend analytics and frontend UI.

## Objectives

- Keep the existing trading workflow fast and uncluttered.
- Replace single-underlying assumptions in the current Greeks risk view.
- Reuse the existing strategy analytics engine instead of building parallel math stacks.
- Add a dedicated portfolio-risk surface for live positions.
- Make future adjustment logic policy-driven instead of heuristic-only.

## Track A: Phase 1 Frontend Corrections

Goal: make the current Greeks/positions risk summary truthful for multi-underlying books.

Tasks:

1. Refactor `frontend/src/components/greeks/greeks-exposure.tsx`
- Group portfolio Greeks by underlying in addition to aggregate totals.
- Stop using a single `spot` to derive rupee metrics for mixed-underlying positions.
- Show per-underlying scenario analysis when the book spans multiple underlyings.
- Keep aggregate Greek totals visible, but avoid presenting them as rupee P&L when dimensional assumptions break.

2. Refactor `frontend/src/components/greeks/greeks-risk-info-bar.tsx`
- Accept grouped risk inputs by underlying instead of one global spot/VRP context.
- Preserve the current detailed 7-Greek view for single-underlying books.
- Add a compact multi-underlying summary mode with one card per underlying and top risk drivers.
- Use IV-regime commentary only when VRP/IV Rank matches the same underlying.

3. Cleanup
- Remove current lint warnings in the Greeks components.
- Add explanatory copy when aggregate numbers are raw sensitivities instead of normalized rupee risk.

## Track B: Phase 2 Shared Analytics Extraction

Goal: move risk math out of API handlers and create one reusable analytics core.

Tasks:

1. Extract reusable helpers from `backend/api_gateway/api_gateway/routers/analytics.py`
- Payoff curve generation
- Breakeven detection
- Position/leg normalization
- Density / PoP / VaR / ES orchestration
- Expected-move and scenario helpers

2. Create reusable backend models
- Add portfolio-risk response schemas
- Add per-underlying risk schemas
- Keep `strategy/analyze` response stable

3. Refactor `/api/v1/strategy/analyze`
- Continue serving basket/position analysis
- Route shared computations through the new helper layer

## Track C: Phase 3 Portfolio Risk Engine

Goal: add a live backend portfolio-risk endpoint for open positions.

Tasks:

1. Add `/api/v1/portfolio-risk`
- Read open positions and position Greeks
- Group risk by underlying
- Return aggregate sensitivities and structured risk flags
- Compute expected-move-based spot stress using IV/VRP data when available
- Include scenario losses and delta-shift context

2. Add tail and operational overlays
- VaR/ES when the underlying grouping is compatible with existing strategy analytics
- Margin headroom/account net normalization when limits data is available
- Concentration and liquidity placeholders with explicit nullable fields if inputs are not yet available

3. Response design
- Top-level portfolio summary
- Per-underlying blocks
- Structured risk flags for UI consumption
- Adjustment-ready fields such as projected delta after a 1-sigma move

## Track D: Phase 3 Frontend Risk Workspace

Goal: add a dedicated risk panel without disrupting the trading workflow.

Tasks:

1. Add client support
- Add frontend API client for `/api/v1/portfolio-risk`
- Add response types to frontend models
- Add fetch-on-demand or refresh-on-position-change behavior

2. Add a dedicated panel
- `Portfolio Risk` panel in the mosaic dashboard
- Per-underlying cards
- Expected move, VaR/ES, margin headroom, and top flags
- Keep the panel readable on both dense and sparse portfolios

3. Dashboard integration
- Register the new panel in `panel-registry`
- Add it to panel visibility/layout plumbing
- Keep the current trading layout intact

## Track E: Phase 4 Policy-Driven Adjustment Engine

Goal: turn diagnostics into constrained, explainable actions.

Tasks:

1. Add rule-based suggestions
- Delta hedge suggestion
- Near-expiry short gamma reduction
- Short-vega plus negative-vomma mitigation
- Concentration reduction

2. Suggestion contract
- Rule id
- Trigger reason
- Suggested action
- Estimated impact if taken
- Confidence / prerequisites

3. UI
- Dedicated `Adjustment Suggestions` panel or section in `Portfolio Risk`
- Separate “why” from “what to do”

## Future Phase: Enforcement and Controls

Not part of the current implementation block, but required for a full risk-management loop:

- soft and hard risk limits
- pre-trade blocks
- override workflow
- audit trail for threshold changes

## Track F: Regime Snapshot And Trade Quality

Goal: separate "this book is dangerous" from "this setup fits the current vol regime."

Implementation tasks:

1. Add shared backend schemas
- `RegimeSnapshot`
- `TradeQualityAssessment`
- Attach them to `StrategyResult`
- Attach them to per-underlying `PortfolioRisk` summaries

2. Build regime inputs from existing data
- Use live/cached spot
- Use ATM IV, IV Rank, and VRP
- Use expected daily move from current IV
- Derive front/back term-structure slope from SVI across expiries
- Derive event premium from front expiry vs next expiry
- Derive skew and convexity indicators from the SVI surface
- Keep fields nullable when surface inputs are unavailable

3. Add trade-style inference
- `short_vol_carry`
- `long_convexity`
- `calendar_term_structure`
- `directional_bull`
- `directional_bear`
- `neutral`

4. Add quality scoring
- Compute a regime-fit score
- Compute an edge score from model-vs-market PoP when available
- Produce an overall label: `poor`, `mixed`, `favorable`, `strong`
- Return structured rationale and headwinds

5. Wire the contract into existing APIs
- `/api/v1/strategy/analyze` should return `regimeSnapshot` and `tradeQuality`
- `/api/v1/portfolio-risk` should return them per underlying

6. Follow-on tasks after the contract ships
- persist historical term-structure/skew percentiles instead of using only current-state levels
- add explicit event-calendar tagging
- use trade quality in adjustment suggestion ranking
- surface `Risk | Quality | Action` in the UI
