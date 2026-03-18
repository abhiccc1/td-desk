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

_indicators: dict[EventType, list[IndicatorBase]] = defaultdict(list)


def register(event_types: list[EventType]) -> Callable[[type[T]], type[T]]:
    """Class decorator that instantiates an indicator and registers it for
    the given event types.

    Usage::

        @register([EventType.TICK])
        class MyIndicator(IndicatorBase):
            async def compute(self, event):
                ...
    """

    def decorator(cls: type[T]) -> type[T]:
        instance = cls()
        for et in event_types:
            _indicators[et].append(instance)
        return cls

    return decorator


def get_indicators(event_type: EventType) -> list[IndicatorBase]:
    """Return all indicators registered for *event_type*."""
    return _indicators.get(event_type, [])
