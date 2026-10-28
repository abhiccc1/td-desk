"""Tick publisher — pushes normalised ticks to Redis Pub/Sub and cache."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime

import orjson
import structlog

from shared.redis_client import get_redis
from shared.schemas.tick import TickData

from market_data_service.config import MarketDataSettings

logger = structlog.get_logger()

_OPTION_RE = re.compile(
    r"^(?P<underlying>[A-Z]+)\s*(?P<expiry>\d{6})\s*(?P<strike>[\d.]+)\s*(?P<side>CE|PE)$"
)
# Pattern: UNDERLYING YYMMDD FUT  (e.g. "CRUDEOIL 261119 FUT", MCX option underlyings)
_FUTURE_RE = re.compile(r"^(?P<underlying>[A-Z]+) (?P<expiry>\d{6}) FUT$")


class TickPublisher:
    """Publishes individual ticks to Redis channels and caches latest LTP."""

    def __init__(self, settings: MarketDataSettings) -> None:
        self._redis_url = settings.redis_url
        self._service_name = settings.service_name
        self._queue: asyncio.Queue[TickData] = asyncio.Queue(maxsize=50000)
        self._worker_count = 2
        self._workers: list[asyncio.Task[None]] = []
        self._option_channel_cache: dict[str, str | None] = {}

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
        """Serialize tick once, publish to Redis channels, and cache."""
        # Single serialization: tick dict → JSON bytes (used for both pub and cache)
        tick_dict = tick.model_dump(mode="json")
        tick_json = orjson.dumps(tick_dict).decode()

        # Lightweight event envelope — skip Pydantic RedisEvent construction
        # (no uuid4, no datetime.now, no model validation)
        event_json = orjson.dumps({
            "event_type": "tick",
            "source_service": self._service_name,
            "payload": tick_dict,
        }).decode()

        channel = f"ticks:raw:{tick.exchange}"
        cache_key = f"cache:ltp:{tick.symbol}"

        pipe = client.pipeline(transaction=False)
        pipe.publish(channel, event_json)

        option_channel = self._resolve_option_channel(tick.symbol)
        if option_channel is not None:
            pipe.publish(option_channel, event_json)
        elif (fm := _FUTURE_RE.match(tick.symbol)) is not None:
            # Underlying future of an options-on-futures chain (MCX)
            pipe.publish(f"ticks:future:{fm.group('underlying')}:{fm.group('expiry')}", event_json)
        else:
            # Index/spot tick — publish on dedicated channel for price chart
            pipe.publish(f"ticks:spot:{tick.symbol}", event_json)

        pipe.set(cache_key, tick_json, ex=30)

        # LKGV: persist last known good value (non-zero LTP) with 24h TTL
        # so off-hours cold-start fetches show valid prices instead of 0
        if tick.ltp > 0:
            lkgv_key = f"cache:lkgv:{tick.symbol}"
            pipe.set(lkgv_key, tick_json, ex=86400)

        await pipe.execute()

        logger.debug(
            "tick published",
            symbol=tick.symbol,
            exchange=tick.exchange,
            ltp=tick.ltp,
        )

    def _resolve_option_channel(self, symbol: str) -> str | None:
        """Route option ticks to a chain-specific topic for direct UI price updates."""
        cached = self._option_channel_cache.get(symbol)
        if cached is not None:
            return cached if cached else None

        match = _OPTION_RE.match(symbol)
        if match is None:
            self._option_channel_cache[symbol] = ""
            return None

        expiry_raw = match.group("expiry")
        try:
            expiry = datetime.strptime(expiry_raw, "%y%m%d").strftime("%Y-%m-%d")
        except ValueError:
            self._option_channel_cache[symbol] = ""
            return None

        underlying = match.group("underlying")
        channel = f"ticks:option:{underlying}:{expiry}"
        self._option_channel_cache[symbol] = channel
        return channel
