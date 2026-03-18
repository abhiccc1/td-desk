"""Helpers for requesting market-data subscriptions from the API gateway."""

from __future__ import annotations

import json

import structlog

from api_gateway.config import settings
from shared.redis_client import get_redis

log = structlog.get_logger()


async def request_market_subscription(underlying: str, expiry: str) -> None:
    """Ask the market-data service to subscribe the requested chain."""
    payload = json.dumps({"underlying": underlying, "expiry": expiry})
    async with get_redis(settings.redis_url) as client:
        await client.publish("subscribe:request", payload)
    log.info("market_subscription.requested", underlying=underlying, expiry=expiry)
