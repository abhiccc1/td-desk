"""Analytics routes – Greeks lookups and strategy analysis."""

from __future__ import annotations

import asyncio
import json
import uuid

import structlog
from fastapi import APIRouter, HTTPException

from api_gateway.config import settings
from shared.redis_client import cache_hgetall, publish_event, subscribe
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.strategy import StrategyLeg

router = APIRouter(prefix="/api/v1", tags=["analytics"])
log = structlog.get_logger()


@router.get("/greeks/{underlying}/{expiry}")
async def get_greeks(underlying: str, expiry: str):
    """Return cached Greeks for *underlying* / *expiry* as a flat array."""
    key = f"cache:greeks:{underlying}:{expiry}"
    data = await cache_hgetall(settings.redis_url, key)
    if not data:
        return []
    # Values are already camelCase JSON (serialized with by_alias=True)
    results = []
    for _sym, greeks_json in data.items():
        try:
            results.append(json.loads(greeks_json))
        except (json.JSONDecodeError, TypeError):
            continue
    return results


@router.get("/svi/{underlying}/{expiry}")
async def get_svi(underlying: str, expiry: str):
    """Return cached SVI params for *underlying* / *expiry*."""
    from shared.redis_client import cache_get
    from api_gateway.config import settings

    key = f"cache:svi:{underlying}:{expiry}"
    data = await cache_get(settings.redis_url, key)
    if not data:
        return None
    return json.loads(data)


@router.get("/iv-rank/{underlying}")
async def get_iv_rank(underlying: str):
    """Return IV Rank and IV Percentile from persistent TimescaleDB IV history."""
    from sqlalchemy import text
    from shared.db import get_engine

    try:
        engine = get_engine(settings.timescaledb_url)
        async with engine.begin() as conn:
            # Get one ATM IV per day for the last 365 days (deduplicated)
            result = await conn.execute(
                text("""
                    SELECT DISTINCT ON (time_bucket('1 day', time))
                           atm_iv
                    FROM iv_history
                    WHERE underlying = :underlying
                      AND time > now() - interval '365 days'
                    ORDER BY time_bucket('1 day', time), time DESC
                """),
                {"underlying": underlying},
            )
            rows = result.fetchall()
    except Exception:
        return {"underlying": underlying, "currentIv": None, "ivRank": None, "ivPercentile": None, "samples": 0}

    if not rows or len(rows) < 2:
        # Fallback: get latest single value if available
        current = rows[0][0] if rows else None
        return {"underlying": underlying, "currentIv": current, "ivRank": None, "ivPercentile": None, "samples": len(rows)}

    ivs = [float(r[0]) for r in rows]
    current_iv = ivs[-1]
    sorted_ivs = sorted(ivs)

    lower_count = sum(1 for v in ivs[:-1] if v < current_iv)
    iv_rank = round((lower_count / max(len(ivs) - 1, 1)) * 100, 1)

    position = sorted_ivs.index(current_iv)
    iv_percentile = round((position / max(len(sorted_ivs) - 1, 1)) * 100, 1)

    return {
        "underlying": underlying,
        "currentIv": round(current_iv, 2),
        "ivRank": iv_rank,
        "ivPercentile": iv_percentile,
        "samples": len(ivs),
        "min": round(sorted_ivs[0], 2),
        "max": round(sorted_ivs[-1], 2),
    }


@router.get("/model-prices/{underlying}/{expiry}")
async def get_model_prices(underlying: str, expiry: str):
    """Return cached Heston + VG model prices/IVs for *underlying* / *expiry*."""
    from shared.redis_client import cache_get

    key = f"cache:model-prices:{underlying}:{expiry}"
    data = await cache_get(settings.redis_url, key)
    if not data:
        return None
    return json.loads(data)


@router.get("/svi-surface/{underlying}")
async def get_svi_surface(underlying: str):
    """Return SVI params for all available expiries of an underlying."""
    from shared.redis_client import cache_get, get_redis
    from api_gateway.config import settings

    # Get all expiries
    async with get_redis(settings.redis_url) as client:
        expiries = await client.smembers(f"cache:expiries:{underlying}")

    if not expiries:
        return []

    # Fetch SVI params for each expiry
    surface = []
    for expiry in sorted(expiries):
        raw = await cache_get(settings.redis_url, f"cache:svi:{underlying}:{expiry}")
        if raw:
            params = json.loads(raw)
            surface.append(params)

    return surface


@router.post("/strategy/analyze")
async def analyze_strategy(legs: list[StrategyLeg]):
    """Publish strategy legs for analysis, await and return the result."""
    request_id = str(uuid.uuid4())
    event = RedisEvent(
        event_type=EventType.STRATEGY_ANALYSIS,
        payload={
            "request_id": request_id,
            "legs": [leg.model_dump(mode="json") for leg in legs],
        },
    )
    await publish_event(settings.redis_url, "strategy:requests", event)
    log.info("analytics.strategy_submitted", request_id=request_id)

    # Wait for the result on a dedicated response channel (with timeout)
    response_channel = f"strategy:responses:{request_id}"
    try:
        async for message in subscribe(settings.redis_url, [response_channel]):
            # First message on the channel is our result
            result = json.loads(message) if isinstance(message, str) else message
            return {"request_id": request_id, "result": result}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Strategy analysis timed out")
