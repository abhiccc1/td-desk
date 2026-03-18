"""Broker executor protocol – every broker adapter must satisfy this interface."""

from __future__ import annotations

from typing import Protocol

from shared.schemas.order import OrderFill, OrderRequest


class BrokerExecutor(Protocol):
    """Protocol that all broker executors must implement."""

    async def place_order(self, order: OrderRequest) -> OrderFill:
        """Submit *order* to the broker and return the resulting fill."""
        ...

    async def cancel_order(self, broker_order_id: str) -> bool:
        """Cancel an outstanding order. Return True on success."""
        ...
