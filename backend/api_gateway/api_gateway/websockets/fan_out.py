"""Fan-out background task – bridges Redis pub/sub channels to WebSocket topics.

Subscribes to Redis pattern channels and broadcasts messages to WebSocket
clients wrapped as {"topic": ..., "payload": ...} so the frontend can route
them to the correct store handler.
"""

from __future__ import annotations

import asyncio

import orjson
import structlog

from shared.redis_client import subscribe_raw

from api_gateway.websockets.manager import ConnectionManager

log = structlog.get_logger()

# Redis channel patterns to subscribe to
_CHANNEL_PATTERNS: list[str] = [
    "ticks:option:*",
    "ticks:chain:*",
    "ticks:spot:*",
    "greeks:computed:*",
    "greeks:batch:*",
    "greeks:position_batch:*",
    "model:prices:*",
    "model:analytics:*",
    "orders:updates:*",
    "orders:events:*",
    "strategy:result:*",
    "risk:exposure",
    "svi:alerts:*",
    "vrp:computed:*",
    "calibration:completed:*",
    "session:*",
]


async def start_fan_out(manager: ConnectionManager, redis_url: str) -> None:
    """Subscribe to Redis pattern channels and broadcast to WebSocket clients.

    Messages are wrapped as {"topic": <channel>, "payload": <event_payload>}
    so the frontend WSClient can route them by topic.
    """

    while True:
        try:
            # subscribe_raw() yields (channel_name, dict) — no Pydantic overhead
            async for channel_name, event_dict in subscribe_raw(
                redis_url, _CHANNEL_PATTERNS, pattern=True
            ):
                topic = channel_name
                # Most channels carry a dict ({"payload": ...} or a bare event
                # dict), but some publish scalars — e.g. session:kotak:version_changed
                # emits a bare int version. Forward non-dicts as-is instead of
                # calling .get(), which would raise and tear down every
                # subscription (including ticks:chain:*) in this loop.
                payload = (
                    event_dict.get("payload", event_dict)
                    if isinstance(event_dict, dict)
                    else event_dict
                )
                wrapped = orjson.dumps({
                    "topic": topic,
                    "payload": payload,
                }).decode()
                await manager.broadcast(topic, wrapped)

        except asyncio.CancelledError:
            log.info("fan_out.cancelled")
            return
        except Exception:
            log.exception("fan_out.error")
            await asyncio.sleep(1)
