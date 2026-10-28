"""Compute-demand aggregation across WebSocket clients."""

from __future__ import annotations

import pytest

from api_gateway.websockets.handlers import _parse_demand
from api_gateway.websockets.manager import ConnectionManager

NIFTY = ("NIFTY", "2026-12-31")
BANK = ("BANKNIFTY", "2026-12-31")

GREEKS = frozenset({"greeks"})
MODELS = frozenset({"greeks", "models"})
QUOTES_ONLY: frozenset[str] = frozenset()


def claim(throttle_ms: int, tiers: frozenset[str] = GREEKS):
    return (throttle_ms, tiers)


class _FakeWS:
    """Stands in for a WebSocket — the manager only uses it as a dict key."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.client = name


@pytest.fixture
def manager() -> ConnectionManager:
    return ConnectionManager()


# ── Aggregation ───────────────────────────────────────────────────────


async def test_single_client_demand(manager: ConnectionManager):
    ws = _FakeWS("a")
    effective = await manager.set_demand(ws, {NIFTY: claim(2000)})
    assert effective == {NIFTY: (2000, GREEKS)}


async def test_fastest_client_wins(manager: ConnectionManager):
    """One tab in the background must not slow the chain for a tab in the
    foreground."""
    slow, fast = _FakeWS("slow"), _FakeWS("fast")
    await manager.set_demand(slow, {NIFTY: claim(2000)})
    effective = await manager.set_demand(fast, {NIFTY: claim(25)})

    assert effective[NIFTY][0] == 25


async def test_dropping_fast_client_falls_back_to_slow(manager: ConnectionManager):
    slow, fast = _FakeWS("slow"), _FakeWS("fast")
    await manager.set_demand(slow, {NIFTY: claim(2000)})
    await manager.set_demand(fast, {NIFTY: claim(25)})

    # The fast tab closes its chain panel: it states its new (empty) demand.
    effective = await manager.set_demand(fast, {})

    assert effective[NIFTY] == (2000, GREEKS)


async def test_disconnect_releases_demand(manager: ConnectionManager):
    slow, fast = _FakeWS("slow"), _FakeWS("fast")
    await manager.set_demand(slow, {NIFTY: claim(2000)})
    await manager.set_demand(fast, {NIFTY: claim(25)})

    await manager.disconnect(fast)

    assert await manager.effective_demand(NIFTY) == (2000, GREEKS)


async def test_no_claims_reports_zero(manager: ConnectionManager):
    """(0, None) means 'nobody asserted anything' — the market-data service
    then uses the active rate and every tier rather than inventing one."""
    assert await manager.effective_demand(NIFTY) == (0, None)


async def test_demand_is_stated_in_full_not_as_a_delta(manager: ConnectionManager):
    """Chains omitted from a demand message are released, so a lost claim can
    never pin a chain at the active rate indefinitely."""
    ws = _FakeWS("a")
    await manager.set_demand(ws, {NIFTY: claim(25), BANK: claim(25)})
    effective = await manager.set_demand(ws, {NIFTY: claim(25)})

    assert effective[BANK] == (0, None)
    assert effective[NIFTY] == (25, GREEKS)


async def test_released_chain_is_reported_so_it_can_be_retuned(
    manager: ConnectionManager,
):
    ws = _FakeWS("a")
    await manager.set_demand(ws, {NIFTY: claim(25)})
    effective = await manager.set_demand(ws, {BANK: claim(25)})

    assert set(effective) == {NIFTY, BANK}


# ── Analytics tiers ───────────────────────────────────────────────────


async def test_quotes_only_client_asks_for_no_tiers(manager: ConnectionManager):
    """The mobile app renders strike/LTP/bid/ask and nothing else, so it claims
    no tiers and the whole quant chain pipeline is skipped for it."""
    ws = _FakeWS("mobile")
    effective = await manager.set_demand(ws, {NIFTY: claim(250, QUOTES_ONLY)})
    assert effective[NIFTY] == (250, QUOTES_ONLY)


async def test_tiers_union_across_clients(manager: ConnectionManager):
    """A phone must never be able to starve a desktop of its Greeks."""
    mobile, desktop = _FakeWS("mobile"), _FakeWS("desktop")
    await manager.set_demand(mobile, {NIFTY: claim(250, QUOTES_ONLY)})
    effective = await manager.set_demand(desktop, {NIFTY: claim(25, MODELS)})

    assert effective[NIFTY] == (25, MODELS)


async def test_desktop_leaving_narrows_tiers_back(manager: ConnectionManager):
    mobile, desktop = _FakeWS("mobile"), _FakeWS("desktop")
    await manager.set_demand(mobile, {NIFTY: claim(250, QUOTES_ONLY)})
    await manager.set_demand(desktop, {NIFTY: claim(25, MODELS)})

    released = await manager.release_demand(desktop)

    assert released[NIFTY] == (250, QUOTES_ONLY)


async def test_release_demand_reports_chains_for_republish(
    manager: ConnectionManager,
):
    """Disconnect must report what it released, or a quotes-only client leaving
    would leave its narrow tier in force for whoever remains."""
    mobile = _FakeWS("mobile")
    await manager.set_demand(mobile, {NIFTY: claim(250, QUOTES_ONLY)})

    released = await manager.release_demand(mobile)

    assert set(released) == {NIFTY}
    assert released[NIFTY] == (0, None)


def test_missing_analytics_key_means_every_tier():
    """A client predating the field must keep getting the full pipeline."""
    parsed = _parse_demand(
        [{"underlying": "NIFTY", "expiry": "2026-12-31", "throttleMs": 25}]
    )
    assert parsed is not None
    assert parsed[NIFTY][1] == frozenset({"greeks", "models"})


def test_empty_analytics_list_is_a_real_claim():
    """Distinct from the key being absent: it means quotes only."""
    parsed = _parse_demand(
        [{
            "underlying": "NIFTY",
            "expiry": "2026-12-31",
            "throttleMs": 25,
            "analytics": [],
        }]
    )
    assert parsed == {NIFTY: (25, QUOTES_ONLY)}


@pytest.mark.parametrize("bad", ["greeks", 5, [1, 2], [None]])
def test_parse_rejects_malformed_analytics(bad: object):
    assert (
        _parse_demand(
            [{
                "underlying": "NIFTY",
                "expiry": "2026-12-31",
                "throttleMs": 25,
                "analytics": bad,
            }]
        )
        is None
    )


# ── Chain release ─────────────────────────────────────────────────────


async def test_chain_topic_holds_the_pipeline_open(manager: ConnectionManager):
    ws = _FakeWS("a")
    await manager.subscribe(ws, [f"ticks:chain:{NIFTY[0]}:{NIFTY[1]}"])
    assert await manager.has_market_stream(*NIFTY) is True


async def test_option_tick_topic_does_not_hold_the_pipeline_open(
    manager: ConnectionManager,
):
    """ticks:option is pinned for any expiry with an open position. If it
    counted, holding a position would pin that chain's snapshot + Greeks
    pipeline at the active rate for the whole session."""
    ws = _FakeWS("a")
    await manager.subscribe(ws, [f"ticks:option:{NIFTY[0]}:{NIFTY[1]}"])
    assert await manager.has_market_stream(*NIFTY) is False


async def test_releasing_chain_topic_releases_pipeline(manager: ConnectionManager):
    ws = _FakeWS("a")
    chain = f"ticks:chain:{NIFTY[0]}:{NIFTY[1]}"
    option = f"ticks:option:{NIFTY[0]}:{NIFTY[1]}"
    await manager.subscribe(ws, [chain, option])

    await manager.unsubscribe(ws, [chain])

    assert await manager.has_market_stream(*NIFTY) is False


# ── Message parsing ───────────────────────────────────────────────────


def test_parse_valid_demand():
    parsed = _parse_demand(
        [{
            "underlying": "NIFTY",
            "expiry": "2026-12-31",
            "throttleMs": 25,
            "analytics": ["greeks"],
        }]
    )
    assert parsed == {NIFTY: (25, GREEKS)}


def test_parse_empty_demand_is_valid():
    """An empty list is a real statement — 'I need nothing computed' — and must
    be distinguishable from a malformed message."""
    assert _parse_demand([]) == {}


@pytest.mark.parametrize(
    "body",
    [
        None,
        "nonsense",
        [{"underlying": "NIFTY", "expiry": "2026-12-31"}],          # no throttle
        [{"underlying": "NIFTY", "throttleMs": 25}],                 # no expiry
        [{"underlying": 1, "expiry": "2026-12-31", "throttleMs": 25}],
        [{"underlying": "NIFTY", "expiry": "2026-12-31", "throttleMs": 0}],
        [{"underlying": "NIFTY", "expiry": "2026-12-31", "throttleMs": -5}],
        [{"underlying": "NIFTY", "expiry": "2026-12-31", "throttleMs": "25"}],
        [{"underlying": "NIFTY", "expiry": "2026-12-31", "throttleMs": True}],
    ],
)
def test_parse_rejects_malformed_demand(body: object):
    """A bad message must be rejected outright. Reading it as 'demands
    nothing' would slow every chain the client is actually watching."""
    assert _parse_demand(body) is None
