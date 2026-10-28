"""Analytics-tier filtering — which indicators a snapshot actually triggers."""

from __future__ import annotations

import pytest

from shared.schemas.events import EventType, RedisEvent

from quant_service.indicators.registry import (
    TIER_ALWAYS,
    TIER_GREEKS,
    TIER_MODELS,
    IndicatorBase,
    _indicators,
    get_indicators,
    register,
)
from quant_service.subscriber import EventSubscriber

EVENT = EventType.STRATEGY_RESULT  # unused by real indicators


@pytest.fixture(autouse=True)
def _clean_registry():
    """Register throwaway indicators against an event type nothing else uses."""
    _indicators.pop(EVENT, None)
    yield
    _indicators.pop(EVENT, None)


def _make(tier: str) -> type[IndicatorBase]:
    @register([EVENT], tier=tier)
    class _Indicator(IndicatorBase):
        async def compute(self, event):
            return []

    return _Indicator


def _snapshot(analytics) -> RedisEvent:
    payload = {"underlying": "NIFTY", "expiry": "2026-12-31"}
    if analytics is not _ABSENT:
        payload["analytics"] = analytics
    return RedisEvent(
        event_type=EventType.CHAIN_SNAPSHOT,
        source_service="market_data_service",
        payload=payload,
    )


_ABSENT = object()


# ── Registry filtering ────────────────────────────────────────────────


def test_no_tiers_requested_runs_nothing_but_always():
    _make(TIER_GREEKS)
    _make(TIER_MODELS)
    always = _make(TIER_ALWAYS)

    selected = get_indicators(EVENT, frozenset())

    assert [type(i) for i in selected] == [always]


def test_greeks_tier_excludes_models():
    greeks = _make(TIER_GREEKS)
    _make(TIER_MODELS)

    selected = get_indicators(EVENT, frozenset({TIER_GREEKS}))

    assert [type(i) for i in selected] == [greeks]


def test_both_tiers_run_everything():
    _make(TIER_GREEKS)
    _make(TIER_MODELS)

    selected = get_indicators(EVENT, frozenset({TIER_GREEKS, TIER_MODELS}))

    assert len(selected) == 2


def test_unstated_tiers_run_everything():
    """None means no client said anything, so fail toward the full pipeline
    rather than silently starving a panel."""
    _make(TIER_GREEKS)
    _make(TIER_MODELS)

    assert len(get_indicators(EVENT, None)) == 2


def test_always_tier_is_never_filtered_out():
    always = _make(TIER_ALWAYS)
    assert [type(i) for i in get_indicators(EVENT, frozenset())] == [always]


# ── Reading the tier off a snapshot ───────────────────────────────────


def test_absent_analytics_field_means_no_preference():
    assert EventSubscriber._requested_tiers(_snapshot(_ABSENT)) is None


def test_empty_analytics_list_means_quotes_only():
    """Distinct from absent: an empty list is a client stating it renders no
    analytics, which is what makes the mobile saving possible."""
    assert EventSubscriber._requested_tiers(_snapshot([])) == frozenset()


def test_analytics_list_is_read_through():
    assert EventSubscriber._requested_tiers(_snapshot(["greeks"])) == frozenset(
        {"greeks"}
    )


def test_null_analytics_means_no_preference():
    assert EventSubscriber._requested_tiers(_snapshot(None)) is None


def test_malformed_analytics_falls_back_to_no_preference():
    """A garbled field must not be read as 'compute nothing'."""
    assert EventSubscriber._requested_tiers(_snapshot("greeks")) is None


def test_non_string_entries_are_dropped():
    assert EventSubscriber._requested_tiers(
        _snapshot(["greeks", 7, None])
    ) == frozenset({"greeks"})
