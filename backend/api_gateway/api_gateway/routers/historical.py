"""Historical data routes – OHLCV queries against TimescaleDB."""

from __future__ import annotations

from datetime import datetime

import structlog
from fastapi import APIRouter, HTTPException, Query

from shared.db import get_engine

router = APIRouter(prefix="/api/v1", tags=["historical"])
log = structlog.get_logger()


@router.get("/ohlcv/{symbol}")
async def get_ohlcv(
    symbol: str,
    from_ts: datetime = Query(..., alias="from", description="Start timestamp (ISO-8601)"),
    to_ts: datetime = Query(..., alias="to", description="End timestamp (ISO-8601)"),
    interval: str = Query("1m", description="Aggregation interval, e.g. 1m, 5m, 1h"),
):
    """Query OHLCV data from the TimescaleDB ``ohlcv_1m`` continuous aggregate."""
    engine = get_engine()

    # Map interval string to TimescaleDB time_bucket width
    interval_map = {
        "1m": "1 minute",
        "5m": "5 minutes",
        "15m": "15 minutes",
        "1h": "1 hour",
        "1d": "1 day",
    }
    bucket = interval_map.get(interval)
    if bucket is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported interval '{interval}'. Use one of: {list(interval_map)}",
        )

    query = f"""
        SELECT
            time_bucket('{bucket}', ts) AS bucket,
            first(open, ts)  AS open,
            max(high)        AS high,
            min(low)         AS low,
            last(close, ts)  AS close,
            sum(volume)      AS volume
        FROM ohlcv_1m
        WHERE symbol = :symbol
          AND ts >= :from_ts
          AND ts <  :to_ts
        GROUP BY bucket
        ORDER BY bucket
    """

    try:
        async with engine.connect() as conn:
            result = await conn.execute(
                query,
                {"symbol": symbol, "from_ts": from_ts, "to_ts": to_ts},
            )
            rows = [dict(r._mapping) for r in result]
    except Exception as exc:
        log.error("historical.query_error", symbol=symbol, error=str(exc))
        raise HTTPException(status_code=500, detail="Failed to query historical data")

    return {"symbol": symbol, "interval": interval, "data": rows}
