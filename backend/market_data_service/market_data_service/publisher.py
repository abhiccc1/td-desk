"""Tick publisher — pushes normalised ticks to Redis Pub/Sub and cache."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime

import structlog

from shared.redis_client import get_redis
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.tick import TickData

from market_data_service.config import MarketDataSettings

logger = structlog.get_logger()

_OPTION_RE = re.compile(
    r"^(?P<underlying>[A-Z]+)\s*(?P<expiry>\d{6})\s*(?P<strike>[\d.]+)\s*(?P<side>CE|PE)$"
)


class TickPublisher:
    """Publishes individual ticks to Redis channels and caches latest LTP."""

    def __init__(self, settings: MarketDataSettings) -> None:
        self._redis_url = settings.redis_url
        self._service_name = settings.service_name
        self._queue: asyncio.Queue[TickData] = asyncio.Queue(maxsize=50000)
        self._worker_count = 2
        self._workers: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        """Start background workers that publish ticks off the ingestion hot path."""
        if self._workers:
            return
        for idx in range(self._worker_count):
            self._workers.append(asyncio.create_task(self._worker(idx)))

    async def publish_tick(self, tick: TickData) -> None:
        """Queue a tick for async publish/cache work without blocking ingestion."""
        try:
            self._queue.put_nowait(tick)
        except asyncio.QueueFull:
            logger.warning("tick_publish_queue_full", symbol=tick.symbol, exchange=tick.exchange)

    async def _worker(self, worker_id: int) -> None:
        """Publish queued ticks using a persistent Redis client per worker."""
        async with get_redis(self._redis_url) as client:
            while True:
                tick = await self._queue.get()
                try:
                    await self._publish_tick(client, tick)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("tick_publisher.worker_error", worker_id=worker_id, symbol=tick.symbol)
                finally:
                    self._queue.task_done()

    async def _publish_tick(self, client, tick: TickData) -> None:
        """Wrap a tick in a RedisEvent, publish it, and cache the latest price."""
        event = RedisEvent(
            event_type=EventType.TICK,
            source_service=self._service_name,
            payload=tick.model_dump(mode="json"),
        )

        channel = f"ticks:raw:{tick.exchange}"
        cache_key = f"cache:ltp:{tick.symbol}"
        event_json = event.model_dump_json()
        tick_json = tick.model_dump_json()

        pipe = client.pipeline(transaction=False)
        pipe.publish(channel, event_json)

        option_channel = self._resolve_option_channel(tick.symbol)
        if option_channel is not None:
            pipe.publish(option_channel, event_json)

        pipe.set(cache_key, tick_json, ex=30)
        await pipe.execute()

        logger.debug(
            "tick published",
            symbol=tick.symbol,
            exchange=tick.exchange,
            ltp=tick.ltp,
        )

    def _resolve_option_channel(self, symbol: str) -> str | None:
        """Route option ticks to a chain-specific topic for direct UI price updates."""
        match = _OPTION_RE.match(symbol)
        if match is None:
            return None

        expiry_raw = match.group("expiry")
        try:
            expiry = datetime.strptime(expiry_raw, "%y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            return None

        underlying = match.group("underlying")
        return f"ticks:option:{underlying}:{expiry}"
