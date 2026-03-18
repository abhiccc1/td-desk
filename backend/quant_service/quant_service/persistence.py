"""Data persister — batches and writes computed results to TimescaleDB."""

import asyncio
from datetime import date, datetime, timezone

import structlog
from sqlalchemy import text

from shared.db import get_engine
from shared.schemas.events import EventType, RedisEvent

log = structlog.get_logger()


def _parse_date(val: str | date) -> date:
    """Coerce expiry value to a date object for asyncpg."""
    if isinstance(val, date):
        return val
    if isinstance(val, str) and val:
        try:
            return date.fromisoformat(val[:10])
        except ValueError:
            pass
    return date.today()


class DataPersister:
    """Write computed events to TimescaleDB with batched inserts."""

    def __init__(self, db_url: str, batch_size: int = 50, flush_interval_s: float = 2.0) -> None:
        self._db_url = db_url
        self._batch_size = batch_size
        self._flush_interval_s = flush_interval_s
        self._buffer: list[dict] = []
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task | None = None  # type: ignore[type-arg]
        self._disabled: bool = False

    async def start(self) -> None:
        """Start the periodic flush loop."""
        self._flush_task = asyncio.create_task(self._periodic_flush())

    async def stop(self) -> None:
        """Flush remaining buffer and cancel periodic task."""
        if self._flush_task is not None:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        await self._flush()

    async def persist(self, event: RedisEvent) -> None:
        """Buffer a Greeks result for batched writing."""
        if self._disabled or event.event_type != EventType.GREEKS_COMPUTED:
            return

        payload = event.payload
        ts_raw = payload.get("timestamp", "")
        if isinstance(ts_raw, str) and ts_raw:
            try:
                ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            except ValueError:
                ts = datetime.now(timezone.utc)
        elif isinstance(ts_raw, datetime):
            ts = ts_raw
        else:
            ts = datetime.now(timezone.utc)
        record = {
            "time": ts,
            "symbol": payload.get("symbol", ""),
            "underlying": payload.get("underlying", ""),
            "expiry": _parse_date(payload.get("expiry", "")),
            "strike": payload.get("strike", 0.0),
            "option_type": payload.get("option_type", ""),
            "iv": payload.get("iv", 0.0),
            "delta": payload.get("delta", 0.0),
            "gamma": payload.get("gamma", 0.0),
            "theta": payload.get("theta", 0.0),
            "vega": payload.get("vega", 0.0),
            "underlying_price": payload.get("underlying_price", 0.0),
        }

        async with self._lock:
            self._buffer.append(record)

            if len(self._buffer) >= self._batch_size:
                await self._flush()

    async def _periodic_flush(self) -> None:
        """Flush the buffer at regular intervals."""
        while True:
            await asyncio.sleep(self._flush_interval_s)
            if self._disabled:
                return
            async with self._lock:
                await self._flush()

    async def _flush(self) -> None:
        """Write buffered records to TimescaleDB."""
        if not self._buffer:
            return

        records = self._buffer.copy()
        self._buffer.clear()

        engine = get_engine(self._db_url)

        insert_sql = text("""
            INSERT INTO greeks (
                time, symbol, underlying, expiry, strike, option_type,
                iv, delta, gamma, theta, vega, underlying_price
            )
            VALUES (
                :time, :symbol, :underlying, :expiry, :strike, :option_type,
                :iv, :delta, :gamma, :theta, :vega, :underlying_price
            )
            ON CONFLICT (time, symbol) DO UPDATE SET
                iv = EXCLUDED.iv,
                delta = EXCLUDED.delta,
                gamma = EXCLUDED.gamma,
                theta = EXCLUDED.theta,
                vega = EXCLUDED.vega,
                underlying_price = EXCLUDED.underlying_price
        """)

        try:
            async with engine.begin() as conn:
                await conn.execute(insert_sql, records)
            log.info("persister.flushed", records=len(records))
        except Exception as exc:
            exc_str = str(exc)
            if "does not exist" in exc_str or "UndefinedTableError" in exc_str:
                self._disabled = True
                log.warning("persister.disabled_missing_table",
                            hint="Create the greeks table to re-enable")
            else:
                log.warning("persister.flush_failed", records=len(records), error=exc_str[:200])
