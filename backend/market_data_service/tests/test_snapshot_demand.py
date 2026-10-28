"""Per-chain snapshot cadence driven by the UI's demand level."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from market_data_service.config import MarketDataSettings
from market_data_service.snapshot import SnapshotAggregator
from shared.schemas.tick import TickData


@pytest.fixture
def agg(monkeypatch: pytest.MonkeyPatch) -> SnapshotAggregator:
    """Aggregator with the Redis publish stubbed out, counting emits."""
    a = SnapshotAggregator(MarketDataSettings())
    a.emitted = []  # type: ignore[attr-defined]

    async def _fake_emit(underlying: str, expiry: str) -> None:
        a.emitted.append((underlying, expiry))  # type: ignore[attr-defined]

    monkeypatch.setattr(a, "_emit_snapshot", _fake_emit)
    return a


def _tick(strike: float, side: str, ltp: float) -> TickData:
    return TickData(
        symbol=f"NIFTY 261231 {int(strike)} {side}",
        exchange="NSE",
        ltp=ltp,
        timestamp=datetime.now(timezone.utc),
    )


KEY = ("NIFTY", "2026-12-31")


async def _drain() -> None:
    """Let tasks created by register/set_chain_rate run."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


# ── Cadence ───────────────────────────────────────────────────────────


async def test_unasserted_chain_uses_active_rate(agg: SnapshotAggregator):
    """A chain whose level was never asserted must not be throttled down —
    silently showing a stale chain is worse than burning CPU."""
    assert agg._chain_throttle_s(KEY) == agg._throttle_s


async def test_background_rate_suppresses_intermediate_emits(agg: SnapshotAggregator):
    agg.register_chain_key(*KEY, throttle_ms=2000)
    await _drain()
    agg.emitted.clear()  # type: ignore[attr-defined]

    for i in range(20):
        await agg.process_tick(_tick(25000, "CE", 100.0 + i))

    # 20 ticks in well under 2s: only the first may emit.
    assert len(agg.emitted) <= 1  # type: ignore[attr-defined]


async def test_active_rate_emits_per_tick(agg: SnapshotAggregator):
    agg.register_chain_key(*KEY, throttle_ms=25)
    await _drain()
    agg.emitted.clear()  # type: ignore[attr-defined]

    # Force the throttle window open between each tick.
    for i in range(3):
        agg._last_emit[KEY] = 0.0
        await agg.process_tick(_tick(25000, "CE", 100.0 + i))

    assert len(agg.emitted) == 3  # type: ignore[attr-defined]


async def test_unregistered_chain_never_emits(agg: SnapshotAggregator):
    """Ticks still accumulate when nobody is viewing, so a returning viewer
    repaints instantly — but no snapshot is built or published."""
    await agg.process_tick(_tick(25000, "CE", 100.0))

    assert agg.emitted == []  # type: ignore[attr-defined]
    assert agg._accum[KEY][25000.0]["CE"].ltp == 100.0


# ── Clamping ──────────────────────────────────────────────────────────


async def test_throttle_clamped_to_active_floor(agg: SnapshotAggregator):
    """A client cannot ask for a cadence faster than the configured active rate."""
    agg.register_chain_key(*KEY, throttle_ms=1)
    await _drain()
    assert agg._chain_throttle_s(KEY) == agg._throttle_s


async def test_throttle_clamped_to_max(agg: SnapshotAggregator):
    """Nor can it freeze a chain indefinitely."""
    agg.register_chain_key(*KEY, throttle_ms=10_000_000)
    await _drain()
    assert agg._chain_throttle_s(KEY) == agg._max_throttle_s


# ── Transitions ───────────────────────────────────────────────────────


async def test_speeding_up_emits_immediately(agg: SnapshotAggregator):
    """Returning to the tab must repaint now, not after the slow interval the
    background level had already armed."""
    agg.register_chain_key(*KEY, throttle_ms=2000)
    await _drain()
    await agg.process_tick(_tick(25000, "CE", 100.0))
    agg.emitted.clear()  # type: ignore[attr-defined]

    agg.set_chain_rate(*KEY, 25)
    await _drain()

    assert agg.emitted == [KEY]  # type: ignore[attr-defined]
    assert agg._chain_throttle_s(KEY) == agg._throttle_s


async def test_slowing_down_does_not_emit(agg: SnapshotAggregator):
    agg.register_chain_key(*KEY, throttle_ms=25)
    await _drain()
    await agg.process_tick(_tick(25000, "CE", 100.0))
    agg.emitted.clear()  # type: ignore[attr-defined]

    agg.set_chain_rate(*KEY, 2000)
    await _drain()

    assert agg.emitted == []  # type: ignore[attr-defined]
    assert agg._chain_throttle_s(KEY) == 2.0


async def test_unregister_drops_rate(agg: SnapshotAggregator):
    """A released chain must not carry its old level into a later re-subscribe,
    or a chain reopened in the foreground would come back at the slow rate."""
    agg.register_chain_key(*KEY, throttle_ms=2000)
    await _drain()
    agg.unregister_chain_key(*KEY)

    assert KEY not in agg._chain_rates
    assert agg._chain_throttle_s(KEY) == agg._throttle_s


async def test_reset_clears_rates(agg: SnapshotAggregator):
    agg.register_chain_key(*KEY, throttle_ms=2000)
    await _drain()
    agg.reset()

    assert agg._chain_rates == {}
