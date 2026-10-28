"""Analytics routes – Greeks lookups and strategy analysis."""

from __future__ import annotations

import json
import math
from contextlib import suppress
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, HTTPException

from api_gateway.config import settings
from shared.redis_client import cache_hgetall
from shared.risk_analytics import (
    build_portfolio_risk,
    build_portfolio_risk_from_legs,
    build_strategy_result,
    parse_position_symbol,
)
from shared.schemas.strategy import StrategyLeg

_IST = ZoneInfo("Asia/Kolkata")

router = APIRouter(prefix="/api/v1", tags=["analytics"])
log = structlog.get_logger()


@router.get("/positions/greeks")
async def get_position_greeks():
    """Return server-computed Greeks for all position instruments."""
    import orjson
    import redis.asyncio as aioredis

    from shared.redis_client import get_pool

    client = aioredis.Redis(connection_pool=get_pool(settings.redis_url))

    results = []
    try:
        # Scan for all position greeks hash keys
        cursor = 0
        while True:
            cursor, keys = await client.scan(cursor, match="cache:position_greeks:*", count=20)
            for key in keys:
                raw_hash = await client.hgetall(key)
                for _sym, val in raw_hash.items():
                    with suppress(Exception):
                        results.append(orjson.loads(val))
            if cursor == 0:
                break
    finally:
        await client.aclose()

    return results


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
    from api_gateway.config import settings
    from shared.redis_client import cache_get

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
        return {
            "underlying": underlying,
            "currentIv": None,
            "ivRank": None,
            "ivPercentile": None,
            "samples": 0,
        }

    if not rows or len(rows) < 2:
        # Fallback: get latest single value if available
        current = rows[0][0] if rows else None
        return {
            "underlying": underlying,
            "currentIv": current,
            "ivRank": None,
            "ivPercentile": None,
            "samples": len(rows),
        }

    ivs = [float(r[0]) for r in rows]
    current_iv = ivs[-1]
    sorted_ivs = sorted(ivs)

    lower_count = sum(1 for v in ivs[:-1] if v < current_iv)
    iv_rank = round((lower_count / max(len(ivs) - 1, 1)) * 100, 1)

    position = sorted_ivs.index(current_iv)
    iv_percentile = round((position / max(len(sorted_ivs) - 1, 1)) * 100, 1)

    prev_close_iv = ivs[-2] if len(ivs) >= 2 else None

    return {
        "underlying": underlying,
        "currentIv": round(current_iv, 2),
        "prevCloseIv": round(prev_close_iv, 2) if prev_close_iv is not None else None,
        "ivRank": iv_rank,
        "ivPercentile": iv_percentile,
        "samples": len(ivs),
        "min": round(sorted_ivs[0], 2),
        "max": round(sorted_ivs[-1], 2),
    }


@router.get("/vrp/{underlying}")
async def get_vrp(underlying: str):
    """Return Volatility Risk Premium: ATM IV minus realized vol (close-to-close)."""
    from sqlalchemy import text

    from shared.db import get_engine

    null_response = {
        "underlying": underlying,
        "atmIv": None,
        "realizedVol": None,
        "vrp": None,
        "samples": 0,
        "window": 20,
    }

    try:
        engine = get_engine(settings.timescaledb_url)
        async with engine.begin() as conn:
            result = await conn.execute(
                text("""
                    SELECT DISTINCT ON (time_bucket('1 day', time))
                           atm_iv, spot_price
                    FROM iv_history
                    WHERE underlying = :underlying
                      AND time > now() - interval '45 days'
                      AND spot_price IS NOT NULL AND spot_price > 0
                    ORDER BY time_bucket('1 day', time), time DESC
                """),
                {"underlying": underlying},
            )
            rows = result.fetchall()
    except Exception:
        return null_response

    if not rows or len(rows) < 2:
        return null_response

    # Extract spot prices chronologically (rows are per-day, most-recent-per-bucket)
    spots = [float(r[1]) for r in rows]
    current_atm_iv = float(rows[-1][0])

    # Close-to-close log returns
    log_returns = [math.log(spots[i] / spots[i - 1]) for i in range(1, len(spots))]

    # Take last 20 returns (or fewer)
    window = 20
    tail = log_returns[-window:]
    n = len(tail)

    if n < 5:
        return {
            "underlying": underlying,
            "atmIv": round(current_atm_iv, 2),
            "realizedVol": None,
            "vrp": None,
            "samples": n,
            "window": window,
        }

    mean = sum(tail) / n
    variance = sum((r - mean) ** 2 for r in tail) / (n - 1)
    realized_vol = math.sqrt(variance) * math.sqrt(252) * 100  # annualized %

    vrp = current_atm_iv - realized_vol

    return {
        "underlying": underlying,
        "atmIv": round(current_atm_iv, 2),
        "realizedVol": round(realized_vol, 2),
        "vrp": round(vrp, 2),
        "samples": n,
        "window": window,
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
    from api_gateway.config import settings
    from shared.redis_client import cache_get, get_redis

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
    """Compute strategy payoff, breakevens, and probability of profit inline."""
    if not legs:
        raise HTTPException(status_code=400, detail="No legs provided")
    result = await build_strategy_result(legs, redis_url=settings.redis_url)
    if result is None:
        raise HTTPException(status_code=400, detail="Unable to analyze strategy")
    return result.model_dump(mode="json", by_alias=True)


@router.post("/strategy/risk-preview")
async def strategy_risk_preview(legs: list[StrategyLeg]):
    """Compute full portfolio-style risk for a hypothetical basket of legs.

    Accepts the same ``StrategyLeg`` payload as ``/strategy/analyze`` but
    returns a ``PortfolioRiskResult`` with Greek exposures, scenario P&L,
    regime snapshot, and adjustment suggestions.  No broker session or live
    positions are required — Greeks are computed inline via BSM IV solver.
    """
    if not legs:
        raise HTTPException(status_code=400, detail="No legs provided")
    result = await build_portfolio_risk_from_legs(legs, redis_url=settings.redis_url)
    return result.model_dump(mode="json", by_alias=True)


@router.get("/adjustments/{underlying}")
async def get_adjustments(underlying: str):
    """Generate ranked adjustment recommendations for open positions."""
    from shared.adjustment_engine import generate_adjustments

    results = await generate_adjustments(
        underlying=underlying.upper(),
        redis_url=settings.redis_url,
        db_url=settings.timescaledb_url,
    )
    return [r.model_dump(mode="json", by_alias=True) for r in results]


@router.get("/portfolio-risk")
async def get_portfolio_risk(underlying: str | None = None):
    """Return live risk summaries for open positions grouped by underlying."""
    from shared.positions import load_positions

    positions = await load_positions(settings.timescaledb_url)
    if underlying:
        target = underlying.upper()
        positions = [
            pos
            for pos in positions
            if parse_position_symbol(str(pos.get("symbol", ""))).get("underlying") == target
        ]

    open_positions = [
        pos
        for pos in positions
        if pos.get("isOpen", True)
        and (int(pos.get("quantity", 0) or 0) != 0 or int(pos.get("netQty", 0) or 0) != 0)
    ]

    result = await build_portfolio_risk(open_positions, redis_url=settings.redis_url)
    return result.model_dump(mode="json", by_alias=True)
