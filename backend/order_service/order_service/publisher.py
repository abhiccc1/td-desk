"""Publish order events to Redis channels."""

from __future__ import annotations

import structlog

from shared.redis_client import publish_event
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.order import OrderFill
from order_service.config import settings

log = structlog.get_logger()


async def publish_order_update(user_id: str, fill: OrderFill) -> None:
    """Publish a fill event to ``orders:updates:{user_id}``."""
    channel = f"orders:updates:{user_id}"
    event = RedisEvent(
        event_type=EventType.ORDER_UPDATE,
        source_service=settings.service_name,
        payload=fill.model_dump(mode="json"),
    )
    await publish_event(settings.redis_url, channel, event)
    log.info("publisher.order_update", channel=channel, order_id=fill.order_id)


async def publish_basket_status(user_id: str, basket_id: str, status: str) -> None:
    """Publish a basket status change to ``orders:updates:{user_id}``."""
    channel = f"orders:updates:{user_id}"
    event = RedisEvent(
        event_type=EventType.ORDER_UPDATE,
        source_service=settings.service_name,
        payload={"basket_id": basket_id, "status": status},
    )
    await publish_event(settings.redis_url, channel, event)
    log.info(
        "publisher.basket_status",
        channel=channel,
        basket_id=basket_id,
        status=status,
    )
