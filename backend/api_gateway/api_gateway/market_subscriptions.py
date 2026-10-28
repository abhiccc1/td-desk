"""Helpers for requesting market-data subscription state from the API gateway."""

from __future__ import annotations

import asyncio
import json

import structlog

from api_gateway.config import settings
from shared.redis_client import cache_get, get_redis

log = structlog.get_logger()

_RETRY_INTERVAL_S = 0.5
_RETRY_TIMEOUT_S = 3.0

# Keep strong references to retry tasks so they aren't garbage-collected mid-flight
_retry_tasks: set[asyncio.Task] = set()


async def _publish(channel: str, payload: str) -> None:
    async with get_redis(settings.redis_url) as client:
        await client.publish(channel, payload)


async def request_market_subscription(
    underlying: str, expiry: str, throttle_ms: int | None = None
) -> None:
    """Ask the market-data service to subscribe the requested chain.

    Redis PUBLISH is fire-and-forget: if the market-data service's listener is
    momentarily down (restart, reconnect) the request vanishes. Re-publish in
    the background until the chain snapshot appears in cache or we time out.

    `throttle_ms` carries the current UI demand level so a chain that comes up
    while the tab is hidden starts slow instead of at the active rate.
    """
    body: dict[str, object] = {"underlying": underlying, "expiry": expiry}
    if throttle_ms is not None:
        body["throttleMs"] = throttle_ms
    payload = json.dumps(body)
    await _publish("subscribe:request", payload)
    log.info("market_subscription.requested", underlying=underlying, expiry=expiry)

    task = asyncio.create_task(_retry_until_snapshot(underlying, expiry, payload))
    _retry_tasks.add(task)
    task.add_done_callback(_retry_tasks.discard)


async def _retry_until_snapshot(underlying: str, expiry: str, payload: str) -> None:
    snapshot_key = f"cache:chain:snapshot:{underlying}:{expiry}"
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _RETRY_TIMEOUT_S
    while loop.time() < deadline:
        await asyncio.sleep(_RETRY_INTERVAL_S)
        try:
            if await cache_get(settings.redis_url, snapshot_key):
                return
            await _publish("subscribe:request", payload)
        except Exception:
            log.exception("market_subscription.retry_failed", underlying=underlying, expiry=expiry)
            return
    # Off-hours a cold chain has no ticks to build a snapshot from, so this
    # is expected then; during market hours it means the feed isn't emitting.
    log.warning("market_subscription.unconfirmed", underlying=underlying, expiry=expiry)


async def request_market_demand(
    underlying: str,
    expiry: str,
    throttle_ms: int,
    analytics: list[str] | None = None,
) -> None:
    """Tell the market-data service how fast this chain needs recomputing, and
    which analytics tiers its consumers will actually render.

    `analytics=None` states no preference and every tier runs; `[]` says the
    connected clients render quotes only, which skips the IV solve, SVI fit and
    model pricing entirely.

    Fire-and-forget by design: demand is re-asserted by the UI on a timer, so a
    lost message costs one re-assert interval rather than correctness.
    """
    body: dict[str, object] = {
        "underlying": underlying,
        "expiry": expiry,
        "throttleMs": throttle_ms,
    }
    if analytics is not None:
        body["analytics"] = analytics
    await _publish("demand:request", json.dumps(body))
    log.info(
        "market_subscription.demand",
        underlying=underlying,
        expiry=expiry,
        throttle_ms=throttle_ms,
        analytics=analytics,
    )


async def request_market_unsubscription(underlying: str, expiry: str) -> None:
    """Ask the market-data service to stop emitting chain snapshots for a chain."""
    payload = json.dumps({"underlying": underlying, "expiry": expiry})
    await _publish("unsubscribe:request", payload)
    log.info("market_subscription.released", underlying=underlying, expiry=expiry)
