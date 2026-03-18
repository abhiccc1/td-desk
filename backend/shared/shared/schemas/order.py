"""Order, fill, and position schemas."""

from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from pydantic import BaseModel, Field


class OrderSide(StrEnum):
    BUY = "BUY"
    SELL = "SELL"


class OrderType(StrEnum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"
    SL = "SL"
    SL_M = "SL_M"


class ProductType(StrEnum):
    """Kotak API product types for F&O orders.
    NRML = Normal/carry-forward (overnight positions allowed)
    MIS  = Margin Intraday Square-off (auto-closed before market end)
    """
    NRML = "NRML"
    MIS = "MIS"


class OrderStatus(StrEnum):
    DRAFT = "DRAFT"
    VALIDATED = "VALIDATED"
    SUBMITTED = "SUBMITTED"
    PARTIAL_FILL = "PARTIAL_FILL"
    FILLED = "FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class OrderRequest(BaseModel):
    order_id: str = Field(default_factory=lambda: str(uuid4()))
    basket_id: str | None = None
    user_id: str
    symbol: str
    exchange: str
    side: OrderSide
    order_type: OrderType
    product_type: ProductType = ProductType.NRML
    quantity: int
    price: float | None = None
    trigger_price: float | None = None


class OrderFill(BaseModel):
    order_id: str
    basket_id: str | None = None
    symbol: str
    side: OrderSide
    filled_qty: int
    avg_fill_price: float
    status: OrderStatus
    broker_order_id: str | None = None
    timestamp: datetime


class Position(BaseModel):
    symbol: str
    exchange: str
    quantity: int
    avg_price: float
    ltp: float = 0.0
    pnl: float = 0.0
    side: OrderSide
