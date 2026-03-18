"""Event subscriber — listens on Redis channels and dispatches to indicators."""

import asyncio

import structlog

from shared.redis_client import subscribe
from shared.schemas.events import RedisEvent

from quant_service.indicators.registry import get_indicators
from quant_service.publisher import ResultPublisher
from quant_service.persistence import DataPersister

log = structlog.get_logger()

# Channels to subscribe to (pattern-based)
SUBSCRIBE_PATTERNS: list[str] = [
    "ticks:raw:*",
    "ticks:chain:*",
    "orders:commands",
]


class EventSubscriber:
    """Subscribe to Redis channels and fan-out events to registered indicators."""

    def __init__(
        self,
        redis_url: str,
        publisher: ResultPublisher,
        persister: DataPersister,
    ) -> None:
        self._redis_url = redis_url
        self._publisher = publisher
        self._persister = persister

    async def run(self) -> None:
        """Main subscription loop — runs forever."""
        log.info("subscriber.starting", patterns=SUBSCRIBE_PATTERNS)

        async for channel, event in subscribe(
            self._redis_url, SUBSCRIBE_PATTERNS, pattern=True
        ):
            log.debug(
                "subscriber.received",
                channel=channel,
                event_type=event.event_type,
            )
            await self._dispatch(event)

    async def _dispatch(self, event: RedisEvent) -> None:
        """Look up matching indicators and run them concurrently."""
        indicators = get_indicators(event.event_type)

        if not indicators:
            log.debug("subscriber.no_indicators", event_type=event.event_type)
            return

        log.debug(
            "subscriber.dispatching",
            event_type=event.event_type,
            indicator_count=len(indicators),
        )

        # Run all matching indicators concurrently
        tasks = [indicator.compute(event) for indicator in indicators]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, result in enumerate(results):
            if isinstance(result, BaseException):
                log.error(
                    "subscriber.indicator_error",
                    indicator=type(indicators[i]).__name__,
                    error=str(result),
                )
                continue

            # result is list[RedisEvent]
            for result_event in result:
                await self._publisher.publish(result_event)
                await self._persister.persist(result_event)
