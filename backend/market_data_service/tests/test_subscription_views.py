"""UI views vs. position prewarms as drivers of the chain-snapshot pipeline."""

from __future__ import annotations

import pytest

from market_data_service.subscription_manager import SubscriptionManager

KEY = ("NIFTY", "2026-11-03")


class _FakeAggregator:
    def __init__(self) -> None:
        self.registered: list[tuple[str, str]] = []
        self.unregistered: list[tuple[str, str]] = []
        self.rates: list[tuple[str, str, int]] = []
        self.analytics: list[tuple[str, str, list[str] | None]] = []

    def register_chain_key(self, underlying, expiry, throttle_ms=None):
        self.registered.append((underlying, expiry))

    def unregister_chain_key(self, underlying, expiry):
        self.unregistered.append((underlying, expiry))

    def set_chain_rate(self, underlying, expiry, throttle_ms):
        self.rates.append((underlying, expiry, throttle_ms))

    def set_chain_analytics(self, underlying, expiry, analytics):
        self.analytics.append((underlying, expiry, analytics))


class _FakeConnector:
    async def subscribe_channel(self, tokens, channel):
        return True

    async def subscribe_index_channel(self, tokens, channel):
        return True

    async def unsubscribe_channel(self, tokens, channel):
        return True


class _FakeScrip:
    tokens = {"NIFTY": {"2026-11-03": [f"nse_fo|{i}" for i in range(10)]}}


@pytest.fixture
def agg() -> _FakeAggregator:
    return _FakeAggregator()


@pytest.fixture
def mgr(agg: _FakeAggregator) -> SubscriptionManager:
    return SubscriptionManager(_FakeConnector(), _FakeScrip(), aggregator=agg)


# ── Who drives the snapshot pipeline ──────────────────────────────────


async def test_ui_view_registers_chain(mgr: SubscriptionManager, agg: _FakeAggregator):
    await mgr.ensure_subscribed(*KEY)
    assert agg.registered == [KEY]


async def test_prewarm_alone_never_registers_chain(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    """A position prewarm keeps the broker subscription warm but must not start
    the full-rate chain pipeline — positions are served by ticks:option and the
    independent 5s position-snapshot pipeline."""
    await mgr.ensure_subscribed(*KEY, prewarm=True)
    assert agg.registered == []


async def test_releasing_ui_view_stops_chain_despite_prewarm(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    """The regression that kept CPU pinned: any expiry holding an open position
    was prewarmed, and the prewarm gated unregistration, so chain snapshots ran
    at full rate for the life of the service with no clients connected."""
    await mgr.ensure_subscribed(*KEY, prewarm=True)
    await mgr.ensure_subscribed(*KEY)
    agg.unregistered.clear()

    mgr.release_view(*KEY)

    assert agg.unregistered == [KEY]


async def test_releasing_prewarm_leaves_ui_view_running(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    """Closing a position must not blank the chain the user is looking at."""
    await mgr.ensure_subscribed(*KEY)
    await mgr.ensure_subscribed(*KEY, prewarm=True)
    agg.unregistered.clear()

    mgr.release_prewarm(*KEY)

    assert agg.unregistered == []


async def test_prewarm_keeps_broker_subscription_after_view_released(
    mgr: SubscriptionManager,
):
    """Releasing the view stops snapshots but keeps the tokens subscribed, so a
    returning viewer repaints from live accumulated ticks."""
    await mgr.ensure_subscribed(*KEY, prewarm=True)
    await mgr.ensure_subscribed(*KEY)

    mgr.release_view(*KEY)

    assert KEY in mgr._active


# ── Demand level plumbing ─────────────────────────────────────────────


async def test_resubscribe_applies_current_demand(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    """A re-asserted subscribe carries the current level; dropping it would
    leave a chain at whatever rate it first came up with."""
    await mgr.ensure_subscribed(*KEY, throttle_ms=25)
    await mgr.ensure_subscribed(*KEY, throttle_ms=2000)

    assert agg.rates == [(*KEY, 2000)]


async def test_demand_never_starts_emission_for_an_unviewed_chain(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    """A client can hold positions in an expiry nobody is viewing. Its demand
    claim must record the analytics tier without applying a cadence, or it
    would spin up the full chain feed for a chain nobody has on screen."""
    mgr.apply_demand(*KEY, 250, [])

    assert agg.analytics == [(*KEY, [])]
    assert agg.rates == []
    assert agg.registered == []


async def test_demand_applies_cadence_once_the_chain_is_viewed(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    await mgr.ensure_subscribed(*KEY)
    agg.rates.clear()

    mgr.apply_demand(*KEY, 2000, ["greeks"])

    assert agg.rates == [(*KEY, 2000)]
    assert agg.analytics[-1] == (*KEY, ["greeks"])


async def test_analytics_survive_the_ui_view_being_released(
    mgr: SubscriptionManager, agg: _FakeAggregator
):
    """Position snapshots outlive the chain view and carry the tier too, so
    releasing the view must not drop the claim."""
    await mgr.ensure_subscribed(*KEY)
    mgr.apply_demand(*KEY, 250, [])
    agg.analytics.clear()

    mgr.release_view(*KEY)

    assert agg.analytics == []
