"""Historical aggregator — aggregates ticks into OHLCV candles using Polars."""

from datetime import datetime, timezone

import polars as pl
import structlog
from sqlalchemy import text

from shared.db import get_engine
from shared.schemas.events import EventType, RedisEvent

from quant_service.indicators.registry import TIER_ALWAYS, IndicatorBase, register

log = structlog.get_logger()

# Module-level buffer and DB URL (set by main at startup)
_db_url: str = ""


def set_db_url(url: str) -> None:
    """Allow the main module to inject the database URL."""
    global _db_url
    _db_url = url


@register([EventType.TICK], tier=TIER_ALWAYS)
class HistoricalAggregator(IndicatorBase):
    """Collect ticks and flush OHLCV candles to TimescaleDB periodically."""

    def __init__(self) -> None:
        self._tick_buffer: list[dict] = []
        self._flush_threshold: int = 500
        self._disabled: bool = False

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        if self._disabled:
            return []

        payload = event.payload

        self._tick_buffer.append({
            "symbol": payload.get("symbol", ""),
            "price": payload.get("ltp", 0.0),
            "volume": payload.get("volume", 0),
            "timestamp": payload.get("timestamp", datetime.now(timezone.utc).isoformat()),
        })

        # Flush when buffer reaches threshold
        if len(self._tick_buffer) >= self._flush_threshold:
            await self._flush_candles()

        # This indicator does not produce Redis events
        return []

    async def _flush_candles(self) -> None:
        """Aggregate buffered ticks into 1-minute OHLCV candles and write to TimescaleDB."""
        if not self._tick_buffer:
            return

        buf_len = len(self._tick_buffer)
        try:
            df = pl.DataFrame(self._tick_buffer)

            # Parse timestamps and truncate to 1-minute intervals
            df = df.with_columns(
                pl.col("timestamp")
                .cast(pl.Utf8)
                .str.to_datetime(time_zone="UTC", strict=False)
                .alias("ts")
            )

            df = df.with_columns(
                pl.col("ts").dt.truncate("1m").alias("candle_ts")
            )

            # Group by symbol and candle timestamp
            candles = df.group_by(["symbol", "candle_ts"]).agg(
                pl.col("price").first().alias("open"),
                pl.col("price").max().alias("high"),
                pl.col("price").min().alias("low"),
                pl.col("price").last().alias("close"),
                pl.col("volume").sum().alias("volume"),
            )

            if candles.height == 0:
                return

            await self._write_candles(candles)

            log.info("historical.flushed", candles=candles.height, ticks=buf_len)

        except Exception as exc:
            exc_str = str(exc)
            if "does not exist" in exc_str or "UndefinedTableError" in exc_str:
                self._disabled = True
                log.warning("historical.disabled_missing_table",
                            hint="Create the ohlcv table to re-enable")
            else:
                log.exception("historical.flush_failed")
        finally:
            self._tick_buffer.clear()

    async def _write_candles(self, candles: pl.DataFrame) -> None:
        """Insert OHLCV candles into TimescaleDB."""
        if not _db_url:
            log.warning("historical.no_db_url")
            return

        engine = get_engine(_db_url)

        insert_sql = text("""
            INSERT INTO ohlcv (time, symbol, open, high, low, close, volume)
            VALUES (:time, :symbol, :open, :high, :low, :close, :volume)
            ON CONFLICT (time, symbol) DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close = EXCLUDED.close,
                volume = EXCLUDED.volume
        """)

        rows = candles.to_dicts()

        async with engine.begin() as conn:
            for row in rows:
                await conn.execute(insert_sql, {
                    "time": row["candle_ts"],
                    "symbol": row["symbol"],
                    "open": row["open"],
                    "high": row["high"],
                    "low": row["low"],
                    "close": row["close"],
                    "volume": row["volume"],
                })

        log.debug("historical.written", rows=len(rows))
