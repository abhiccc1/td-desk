"""Reconnect manager with exponential backoff for WebSocket connections."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import TypeVar

import structlog

logger = structlog.get_logger()

T = TypeVar("T")

_INITIAL_BACKOFF_S = 1.0
_MAX_BACKOFF_S = 60.0
_BACKOFF_MULTIPLIER = 2.0


class ReconnectManager:
    """Wraps a connect/consume cycle with exponential backoff reconnection."""

    def __init__(
        self,
        initial_backoff: float = _INITIAL_BACKOFF_S,
        max_backoff: float = _MAX_BACKOFF_S,
        multiplier: float = _BACKOFF_MULTIPLIER,
    ) -> None:
        self._initial_backoff = initial_backoff
        self._max_backoff = max_backoff
        self._multiplier = multiplier

    async def run_with_reconnect(
        self,
        connect_fn: Callable[[], Awaitable[None]],
        on_connected_fn: Callable[[], AsyncGenerator[T, None]],
    ) -> AsyncGenerator[T, None]:
        """Loop: connect, consume from the generator, reconnect on failure.

        Resets backoff after the first successful yield from the generator,
        indicating that the connection is healthy and producing data.
        """
        backoff = self._initial_backoff

        while True:
            try:
                await connect_fn()
                backoff_reset = False

                async for item in on_connected_fn():
                    if not backoff_reset:
                        backoff = self._initial_backoff
                        backoff_reset = True
                    yield item

                # Generator exhausted normally — reconnect
                logger.warning("stream ended; reconnecting")

            except Exception as exc:
                logger.error(
                    "connection error; will retry",
                    error=str(exc),
                    backoff_s=backoff,
                )

            await asyncio.sleep(backoff)
            backoff = min(backoff * self._multiplier, self._max_backoff)
