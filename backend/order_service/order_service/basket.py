"""Order-basket state machine for multi-leg basket orders."""

from __future__ import annotations

import uuid
from enum import StrEnum

import structlog

from shared.schemas.order import OrderRequest, OrderSide, OrderStatus

log = structlog.get_logger()


class BasketState(StrEnum):
    DRAFT = "DRAFT"
    VALIDATED = "VALIDATED"
    SUBMITTED = "SUBMITTED"
    PARTIAL_FILL = "PARTIAL_FILL"
    FILLED = "FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class OrderBasket:
    """Manages multi-leg basket state machine.

    States: DRAFT -> VALIDATED -> SUBMITTED -> PARTIAL_FILL -> FILLED | REJECTED | CANCELLED
    """

    def __init__(self, basket_id: str | None = None) -> None:
        self.basket_id: str = basket_id or str(uuid.uuid4())
        self.state: BasketState = BasketState.DRAFT
        self.legs: dict[str, OrderRequest] = {}
        self.fills: dict[str, object] = {}

    # -- mutators --------------------------------------------------------

    def add_leg(self, order: OrderRequest) -> None:
        """Add a leg to the basket. Only allowed in DRAFT state."""
        if self.state != BasketState.DRAFT:
            raise ValueError(f"Cannot add legs in state {self.state}")
        self.legs[order.order_id] = order
        log.info("basket.add_leg", basket_id=self.basket_id, order_id=order.order_id)

    def remove_leg(self, order_id: str) -> None:
        """Remove a leg from the basket. Only allowed in DRAFT state."""
        if self.state != BasketState.DRAFT:
            raise ValueError(f"Cannot remove legs in state {self.state}")
        if order_id not in self.legs:
            raise KeyError(f"Order {order_id} not found in basket")
        del self.legs[order_id]
        log.info("basket.remove_leg", basket_id=self.basket_id, order_id=order_id)

    def validate(self) -> bool:
        """Validate the basket and transition to VALIDATED state."""
        if self.state != BasketState.DRAFT:
            raise ValueError(f"Cannot validate in state {self.state}")
        if not self.legs:
            raise ValueError("Cannot validate an empty basket")
        self.state = BasketState.VALIDATED
        log.info("basket.validated", basket_id=self.basket_id, num_legs=len(self.legs))
        return True

    def mark_submitted(self) -> None:
        if self.state != BasketState.VALIDATED:
            raise ValueError(f"Cannot submit in state {self.state}")
        self.state = BasketState.SUBMITTED
        log.info("basket.submitted", basket_id=self.basket_id)

    def mark_partial_fill(self) -> None:
        self.state = BasketState.PARTIAL_FILL

    def mark_filled(self) -> None:
        self.state = BasketState.FILLED

    def mark_rejected(self) -> None:
        self.state = BasketState.REJECTED

    def mark_cancelled(self) -> None:
        self.state = BasketState.CANCELLED

    # -- queries ---------------------------------------------------------

    def get_net_credit(self) -> float:
        """Calculate net credit/debit for the basket.

        Positive = net credit, negative = net debit.
        """
        total = 0.0
        for leg in self.legs.values():
            price = leg.price or 0.0
            qty = leg.quantity
            if leg.side == OrderSide.SELL:
                total += price * qty
            else:
                total -= price * qty
        return total

    def get_status(self) -> OrderStatus:
        """Map internal basket state to the public OrderStatus enum."""
        mapping: dict[BasketState, OrderStatus] = {
            BasketState.DRAFT: OrderStatus.PENDING,
            BasketState.VALIDATED: OrderStatus.PENDING,
            BasketState.SUBMITTED: OrderStatus.PENDING,
            BasketState.PARTIAL_FILL: OrderStatus.PARTIAL,
            BasketState.FILLED: OrderStatus.FILLED,
            BasketState.REJECTED: OrderStatus.REJECTED,
            BasketState.CANCELLED: OrderStatus.CANCELLED,
        }
        return mapping[self.state]


# In-memory basket store (keyed by basket_id)
_baskets: dict[str, OrderBasket] = {}


def get_basket(basket_id: str) -> OrderBasket:
    if basket_id not in _baskets:
        raise KeyError(f"Basket {basket_id} not found")
    return _baskets[basket_id]


def create_basket() -> OrderBasket:
    basket = OrderBasket()
    _baskets[basket.basket_id] = basket
    return basket


def list_baskets() -> list[OrderBasket]:
    return list(_baskets.values())
