"""Market-data routes – serve option chains and quotes from Redis cache."""

from __future__ import annotations

from fastapi import APIRouter

import json as _json

from api_gateway.config import settings
from api_gateway.market_subscriptions import request_market_subscription
from shared.instruments import REDIS_KEY_LOT_SIZES, REDIS_KEY_UNDERLYINGS
from shared.redis_client import cache_get, get_redis

router = APIRouter(prefix="/api/v1", tags=["market_data"])


@router.get("/option-chain/{underlying}/{expiry}")
async def get_option_chain(underlying: str, expiry: str):
    """Return the cached option-chain snapshot for *underlying* / *expiry*."""
    snapshot_key = f"cache:chain:snapshot:{underlying}:{expiry}"
    snapshot_json = await cache_get(settings.redis_url, snapshot_key)
    if snapshot_json:
        return _json.loads(snapshot_json)

    await request_market_subscription(underlying, expiry)

    # Return empty snapshot instead of 404 while the live feed warms up.
    return {"underlying": underlying, "underlyingPrice": 0, "expiry": expiry, "exchange": "NSE", "strikes": [], "timestamp": ""}


@router.get("/quotes/{symbol}")
async def get_quote(symbol: str):
    """Return the latest tick for *symbol* from Redis cache."""
    key = f"cache:ltp:{symbol}"
    raw = await cache_get(settings.redis_url, key)
    if raw is None:
        return {"symbol": symbol, "ltp": 0}
    # Cached value is full TickData JSON
    return _json.loads(raw)


@router.get("/static/{symbol}")
async def get_static_data(symbol: str):
    """Return static OHLC data (open, prev close, high, low) for a symbol."""
    from datetime import datetime, timezone
    key = f"cache:static:{symbol}"
    raw = await cache_get(settings.redis_url, key)
    if not raw:
        return None
    data = _json.loads(raw)
    # Invalidate if cached date doesn't match today
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if data.get("date") != today:
        return None
    return data


@router.get("/lot-sizes")
async def get_lot_sizes():
    """Return lot sizes for all underlyings from Redis cache."""
    async with get_redis(settings.redis_url) as client:
        data = await client.hgetall(REDIS_KEY_LOT_SIZES)
    if not data:
        return {}
    return {k: int(v) for k, v in data.items()}


@router.get("/underlyings")
async def get_underlyings():
    """Return the list of configured underlyings from Redis cache."""
    raw = await cache_get(settings.redis_url, REDIS_KEY_UNDERLYINGS)
    if not raw:
        return []
    return _json.loads(raw)


@router.get("/expiries/{underlying}")
async def get_expiries(underlying: str):
    """Return available expiry dates for *underlying* from the scrip master cache."""
    key = f"cache:expiries:{underlying}"
    async with get_redis(settings.redis_url) as client:
        expiries = await client.smembers(key)
    if not expiries:
        return {"underlying": underlying, "expiries": []}
    return {"underlying": underlying, "expiries": sorted(expiries)}
