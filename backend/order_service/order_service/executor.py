"""Order executor – takes a basket and fans out legs to broker executors."""

from __future__ import annotations

import asyncio

import structlog

from shared.schemas.order import OrderFill, OrderRequest, OrderStatus

from order_service.basket import OrderBasket
from order_service.brokers.base import BrokerExecutor
from order_service.brokers.mcx_broker import MCXBrokerExecutor
from order_service.brokers.nse_broker import NSEBrokerExecutor
from order_service.brokers.registry import get_broker, register_broker

log = structlog.get_logger()


class OrderExecutor:
    """Iterate basket legs, dispatch to the appropriate broker, and collect fills."""

    def __init__(self) -> None:
        # Register default brokers
        register_broker("NSE", NSEBrokerExecutor())
        register_broker("MCX", MCXBrokerExecutor())

    def _get_broker(self, order: OrderRequest) -> BrokerExecutor:
        """Select broker from registry based on exchange field (defaults to NSE)."""
        exchange = getattr(order, "exchange", "NSE").upper()
        broker = get_broker(exchange)
        if broker is None:
            broker = get_broker("NSE")
        return broker

    async def execute_basket(self, basket: OrderBasket) -> list[OrderFill]:
        """Submit all legs of *basket* in parallel and return collected fills."""
        basket.mark_submitted()
        log.info(
            "executor.execute_basket",
            basket_id=basket.basket_id,
            num_legs=len(basket.legs),
        )

        tasks = [
            self._execute_leg(order) for order in basket.legs.values()
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        fills: list[OrderFill] = []
        errors: list[Exception] = []
        for result in results:
            if isinstance(result, Exception):
                errors.append(result)
                log.error("executor.leg_failed", error=str(result))
            else:
                fills.append(result)

        # Update basket state based on results
        if errors and not fills:
            basket.mark_rejected()
        elif errors:
            basket.mark_partial_fill()
        else:
            basket.mark_filled()

        log.info(
            "executor.basket_done",
            basket_id=basket.basket_id,
            filled=len(fills),
            errors=len(errors),
            state=basket.state,
        )
        return fills

    async def _execute_leg(self, order: OrderRequest) -> OrderFill:
        broker = self._get_broker(order)
        return await broker.place_order(order)
