"""Result publisher — routes computed events to appropriate Redis channels.

Uses a persistent Redis client to avoid per-publish connection overhead.
"""

import redis.asyncio as aioredis
import structlog

from shared.redis_client import get_pool
from shared.schemas.events import EventType, RedisEvent

log = structlog.get_logger()


class ResultPublisher:
    """Publish computed events to Redis channels based on event type."""

    def __init__(self, redis_url: str) -> None:
        self._redis_url = redis_url
        self._client: aioredis.Redis | None = None

    async def _get_client(self) -> aioredis.Redis:
        if self._client is None:
            pool = get_pool(self._redis_url)
            self._client = aioredis.Redis(connection_pool=pool)
        return self._client

    async def publish(self, event: RedisEvent) -> None:
        """Route an event to its destination Redis channel."""
        channel = self._resolve_channel(event)

        if channel is None:
            log.debug("publisher.no_channel", event_type=event.event_type)
            return

        client = await self._get_client()
        await client.publish(channel, event.model_dump_json())
        log.debug("publisher.published", channel=channel, event_type=event.event_type)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _resolve_channel(self, event: RedisEvent) -> str | None:
        """Determine the Redis channel for a given event."""
        payload = event.payload

        match event.event_type:
            case EventType.GREEKS_COMPUTED:
                underlying = payload.get("underlying", "unknown")
                expiry = payload.get("expiry", "unknown")
                return f"greeks:computed:{underlying}:{expiry}"

            case EventType.GREEKS_BATCH_COMPUTED:
                underlying = payload.get("underlying", "unknown")
                expiry = payload.get("expiry", "unknown")
                return f"greeks:batch:{underlying}:{expiry}"

            case EventType.CALIBRATION_COMPLETED:
                underlying = payload.get("underlying", "unknown")
                expiry = payload.get("expiry", "unknown")
                return f"calibration:completed:{underlying}:{expiry}"

            case EventType.MODEL_PRICES_COMPUTED:
                underlying = payload.get("underlying", "unknown")
                expiry = payload.get("expiry", "unknown")
                return f"model:prices:{underlying}:{expiry}"

            case EventType.MODEL_PRICES_SLOW_COMPUTED:
                underlying = payload.get("underlying", "unknown")
                expiry = payload.get("expiry", "unknown")
                return f"model:analytics:{underlying}:{expiry}"

            case EventType.POSITION_GREEKS_BATCH_COMPUTED:
                underlying = payload.get("underlying", "unknown")
                expiry = payload.get("expiry", "unknown")
                return f"greeks:position_batch:{underlying}:{expiry}"

            case EventType.VRP_COMPUTED:
                underlying = payload.get("underlying", "unknown")
                return f"vrp:computed:{underlying}"

            case EventType.STRATEGY_RESULT:
                legs = payload.get("legs")
                if isinstance(legs, list):
                    first_leg = next(
                        (leg for leg in legs if isinstance(leg, dict)),
                        {},
                    )
                else:
                    first_leg = {}
                underlying = first_leg.get("underlying", "unknown")
                expiry = first_leg.get("expiry", "unknown")
                return f"strategy:result:{underlying}:{expiry}"

            case EventType.RISK_EXPOSURE:
                return "risk:exposure"

            case _:
                return None
