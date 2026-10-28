"""Indicator plugin registry.

Provides a decorator-based registration system so that each indicator module
self-registers the event types it cares about at import time.
"""

from abc import ABC, abstractmethod
from collections import defaultdict
from collections.abc import Callable
from typing import TypeVar

from shared.schemas.events import EventType, RedisEvent

T = TypeVar("T", bound="IndicatorBase")

# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class IndicatorBase(ABC):
    """Base class every indicator must subclass."""

    @abstractmethod
    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        """Process an incoming event and return zero or more result events."""
        ...


# ---------------------------------------------------------------------------
# Registry internals
# ---------------------------------------------------------------------------

# Analytics tiers. An indicator belongs to exactly one; a snapshot carries the
# set of tiers its consumers asked for, and only those indicators run.
#
#   greeks — IV solve, the Greeks strip, the SVI fit and its alerts, and VRP
#            (which reads the SVI fit and shows in the always-visible toolbar).
#   models — Heston/VG calibration, FFT chain pricing, densities and PoP.
#
# TIER_ALWAYS marks work that isn't driven by chain demand at all (OHLCV
# aggregation off raw ticks), so it never gets filtered out.
TIER_GREEKS = "greeks"
TIER_MODELS = "models"
TIER_ALWAYS = "always"

ALL_TIERS: frozenset[str] = frozenset({TIER_GREEKS, TIER_MODELS})

_indicators: dict[EventType, list[tuple[IndicatorBase, str]]] = defaultdict(list)


def register(
    event_types: list[EventType], tier: str = TIER_GREEKS
) -> Callable[[type[T]], type[T]]:
    """Class decorator that instantiates an indicator and registers it for
    the given event types under an analytics *tier*.

    Usage::

        @register([EventType.TICK], tier=TIER_ALWAYS)
        class MyIndicator(IndicatorBase):
            async def compute(self, event):
                ...
    """

    def decorator(cls: type[T]) -> type[T]:
        instance = cls()
        for et in event_types:
            _indicators[et].append((instance, tier))
        return cls

    return decorator


def get_indicators(
    event_type: EventType, tiers: frozenset[str] | None = None
) -> list[IndicatorBase]:
    """Indicators registered for *event_type*, limited to the given tiers.

    `tiers=None` means the event stated no preference, so everything runs —
    the same fail-toward-full rule the rest of the demand path uses. TIER_ALWAYS
    indicators are never filtered.
    """
    registered = _indicators.get(event_type, [])
    if tiers is None:
        return [indicator for indicator, _ in registered]
    return [
        indicator
        for indicator, tier in registered
        if tier == TIER_ALWAYS or tier in tiers
    ]
