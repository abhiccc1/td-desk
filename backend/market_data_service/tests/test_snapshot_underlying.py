"""Underlying price resolution for index vs options-on-futures chains."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from market_data_service.config import MarketDataSettings
from market_data_service.snapshot import SnapshotAggregator
from shared.schemas.tick import TickData


def _tick(symbol: str, ltp: float) -> TickData:
    return TickData(symbol=symbol, exchange="MCX", ltp=ltp, timestamp=datetime.now(timezone.utc))


def _chain(strike: float, call: float, put: float) -> dict:
    return {strike: {"CE": _tick("C", call), "PE": _tick("P", put)}}


@pytest.fixture
def agg() -> SnapshotAggregator:
    a = SnapshotAggregator(MarketDataSettings())
    a.set_underlying_futures({
        "GOLD": {
            "2026-10-30": {"symbol": "GOLD 261204 FUT", "token": "495213",
                           "tradingSymbol": "GOLD04DEC26FUT", "expiry": "2026-12-04"},
            "2026-11-27": {"symbol": "GOLD 261204 FUT", "token": "495213",
                           "tradingSymbol": "GOLD04DEC26FUT", "expiry": "2026-12-04"},
        },
    })
    return a


async def test_mcx_uses_mapped_future(agg: SnapshotAggregator):
    await agg.process_tick(_tick("GOLD 261005 FUT", 150000.0))  # other contract month
    await agg.process_tick(_tick("GOLD 261204 FUT", 152345.0))
    chain = _chain(152000, 3000, 2600)
    assert agg._resolve_underlying_price("GOLD", "2026-10-30", chain) == 152345.0
    assert agg._resolve_underlying_price("GOLD", "2026-11-27", chain) == 152345.0


async def test_mcx_ignores_bare_underlying_tick(agg: SnapshotAggregator):
    # A stray tick keyed by the bare name must not become the futures price
    await agg.process_tick(_tick("GOLD", 999.0))
    assert agg._resolve_underlying_price("GOLD", "2026-10-30", _chain(152000, 3000, 2600)) == 152400


async def test_mcx_parity_fallback_without_future_tick(agg: SnapshotAggregator):
    assert agg._resolve_underlying_price("GOLD", "2026-10-30", _chain(152000, 3000, 2600)) == 152400


async def test_index_uses_spot(agg: SnapshotAggregator):
    await agg.process_tick(_tick("NIFTY", 25000.0))
    assert agg._resolve_underlying_price("NIFTY", "2026-10-06", _chain(25000, 100, 90)) == 25000.0
