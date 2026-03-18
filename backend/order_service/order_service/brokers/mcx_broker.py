"""MCX broker executor stub – returns mock fills for development."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import structlog

from shared.schemas.order import OrderFill, OrderRequest, OrderStatus

log = structlog.get_logger()


class MCXBrokerExecutor:
    """Stub implementation of :class:`BrokerExecutor` for MCX."""

    async def place_order(self, order: OrderRequest) -> OrderFill:
        log.info("mcx_broker.place_order", symbol=order.symbol, qty=order.quantity)
        return OrderFill(
            order_id=order.order_id,
            broker_order_id=str(uuid.uuid4()),
            symbol=order.symbol,
            filled_qty=order.quantity,
            filled_price=order.price or 0.0,
            status=OrderStatus.FILLED,
            filled_at=datetime.now(timezone.utc),
        )

    async def cancel_order(self, broker_order_id: str) -> bool:
        log.info("mcx_broker.cancel_order", broker_order_id=broker_order_id)
        return True
