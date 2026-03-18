# Backend — Quant Service (`backend/quant_service/`)

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

## Core
- [x] `pyproject.toml` — deps: td-desk-shared, py_vollib, optionlab, riskfolio-lib, polars, numpy
- [x] `config.py` — `QuantSettings` (risk_free_rate, greeks_batch_interval_ms)
- [x] `main.py` — entry point, imports indicators to trigger registration, runs subscriber loop

## Indicator Plugin System
- [x] `indicators/registry.py` — `@register` decorator plugin system, `IndicatorBase` ABC, `get_indicators()`

## Indicators
- [x] `indicators/greeks.py` — py_vollib BSM: IV, Delta, Gamma, Theta, Vega (registered for TICK events)
- [x] `indicators/strategy_analyzer.py` — OptionLab: margin, breakeven (zero-crossing), PoP (registered for ORDER_COMMAND)
- [x] `indicators/risk_exposure.py` — Riskfolio-Lib: portfolio beta, net Greeks aggregation (registered for GREEKS_COMPUTED)
- [x] `indicators/historical.py` — Polars: tick buffer → 1-min OHLCV candles, TimescaleDB upsert (registered for TICK)

## Event Pipeline
- [x] `subscriber.py` — Redis pattern subscriber dispatching to indicators concurrently
- [x] `publisher.py` — routes computed events to `greeks:computed:*`, `strategy:result:*`, `risk:exposure`
- [x] `persistence.py` — batched Greeks writes to TimescaleDB (batch=50, flush=2s)

## Remaining
- [ ] Tick batching for vectorized Greeks (batch ticks over 100ms window before computing — currently per-tick)
- [ ] IV surface calculation and caching
- [ ] Unit tests

## Summary
| Status | Count |
|--------|-------|
| Done | 10 |
| Not Started | 3 |
