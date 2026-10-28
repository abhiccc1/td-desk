"""Market-data routes – serve option chains and quotes from Redis cache."""

from __future__ import annotations

import asyncio
from fastapi import APIRouter

import json as _json

from api_gateway.config import settings
from api_gateway.market_subscriptions import request_market_subscription
from shared.instruments import (
    REDIS_KEY_CONTRACT_META,
    REDIS_KEY_LOT_SIZES,
    REDIS_KEY_UNDERLYING_FUTURE,
    REDIS_KEY_UNDERLYINGS,
    get_instrument_master,
)
from shared.redis_client import cache_get, get_redis

router = APIRouter(prefix="/api/v1", tags=["market_data"])

_CHAIN_WARMUP_TIMEOUT_S = 3.0
_CHAIN_WARMUP_POLL_INTERVAL_S = 0.05


@router.get("/option-chain/{underlying}/{expiry}")
async def get_option_chain(underlying: str, expiry: str):
    """Return the cached option-chain snapshot for *underlying* / *expiry*."""
    snapshot_key = f"cache:chain:snapshot:{underlying}:{expiry}"
    snapshot_json = await cache_get(settings.redis_url, snapshot_key)
    if snapshot_json:
        return _json.loads(snapshot_json)

    await request_market_subscription(underlying, expiry)

    deadline = asyncio.get_running_loop().time() + _CHAIN_WARMUP_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(_CHAIN_WARMUP_POLL_INTERVAL_S)
        snapshot_json = await cache_get(settings.redis_url, snapshot_key)
        if snapshot_json:
            return _json.loads(snapshot_json)

    # Return empty snapshot instead of 404 while the live feed warms up.
    cfg = get_instrument_master().get(underlying)
    exchange = cfg.exchange if cfg else "NSE"
    return {"underlying": underlying, "underlyingPrice": 0, "expiry": expiry, "exchange": exchange, "strikes": [], "timestamp": ""}


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


@router.get("/contract-meta/{underlying}")
async def get_contract_meta(underlying: str):
    """Per-expiry contract specs from today's scrip master (options on futures).

    ``{"underlying", "expiries": {expiry: {lotSize, pnlMultiplier, maxOrderQty,
    tickSize, underlyingFuture: {symbol, tradingSymbol, token, expiry}}}}``.
    Empty for index underlyings and while MCX_ENABLED is off.
    """
    name = underlying.upper()
    cfg = get_instrument_master().get(name)
    if cfg is None or not cfg.active:
        return {"underlying": name, "expiries": {}}
    async with get_redis(settings.redis_url) as client:
        meta = await client.hgetall(f"{REDIS_KEY_CONTRACT_META}:{name}")
        futures = await client.hgetall(f"{REDIS_KEY_UNDERLYING_FUTURE}:{name}")
    expiries: dict[str, dict] = {}
    for expiry in sorted(meta):
        entry = _json.loads(meta[expiry])
        if expiry in futures:
            entry["underlyingFuture"] = _json.loads(futures[expiry])
        expiries[expiry] = entry
    return {"underlying": name, "expiries": expiries}


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


@router.get("/expiries")
async def get_all_expiries():
    """Return all cached expiries plus the date they were last refreshed."""
    raw = await cache_get(settings.redis_url, "cache:expiries:all")
    if raw:
        return _json.loads(raw)

    async with get_redis(settings.redis_url) as client:
        underlyings_raw = await cache_get(settings.redis_url, REDIS_KEY_UNDERLYINGS)
        underlyings = _json.loads(underlyings_raw) if underlyings_raw else []
        expiries_by_underlying: dict[str, list[str]] = {}
        for item in underlyings:
            name = item.get("name") if isinstance(item, dict) else None
            if not isinstance(name, str) or not name:
                continue
            expiries = await client.smembers(f"cache:expiries:{name}")
            expiries_by_underlying[name] = sorted(expiries) if expiries else []

    return {
        "lastUpdated": None,
        "expiriesByUnderlying": expiries_by_underlying,
    }
