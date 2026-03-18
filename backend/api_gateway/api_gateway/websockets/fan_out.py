"""Fan-out background task – bridges Redis pub/sub channels to WebSocket topics.

Subscribes to Redis pattern channels and broadcasts messages to WebSocket
clients wrapped as {"topic": ..., "payload": ...} so the frontend can route
them to the correct store handler.
"""

from __future__ import annotations

import asyncio

import orjson
import structlog

from shared.redis_client import subscribe

from api_gateway.websockets.manager import ConnectionManager

log = structlog.get_logger()

# Redis channel patterns to subscribe to
_CHANNEL_PATTERNS: list[str] = [
    "ticks:option:*",
    "ticks:chain:*",
    "greeks:computed:*",
    "greeks:batch:*",
    "model:prices:*",
    "risk:exposure",
    "orders:updates:*",
    "svi:alerts:*",
]


async def start_fan_out(manager: ConnectionManager, redis_url: str) -> None:
    """Subscribe to Redis pattern channels and broadcast to WebSocket clients.

    Messages are wrapped as {"topic": <channel>, "payload": <event_payload>}
    so the frontend WSClient can route them by topic.
    """
    log.info("fan_out.starting", patterns=_CHANNEL_PATTERNS)

    while True:
        try:
            # subscribe() yields (channel_name, RedisEvent) tuples
            async for channel_name, event in subscribe(
                redis_url, _CHANNEL_PATTERNS, pattern=True
            ):
                # Use the full Redis channel name as the WS topic
                # e.g. "ticks:chain:NIFTY:2026-03-19"
                topic = channel_name

                # Wrap in {topic, payload} so frontend can route by topic
                wrapped = orjson.dumps({
                    "topic": topic,
                    "payload": event.payload,
                }).decode()
                await manager.broadcast(topic, wrapped)

        except asyncio.CancelledError:
            log.info("fan_out.cancelled")
            return
        except Exception:
            log.exception("fan_out.error")
            await asyncio.sleep(1)
