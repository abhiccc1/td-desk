"""RedisEvent envelope — the universal inter-service message format."""

from datetime import datetime, timezone
from enum import StrEnum
from uuid import uuid4

from pydantic import BaseModel, Field


class EventType(StrEnum):
    TICK = "tick"
    CHAIN_SNAPSHOT = "chain_snapshot"
    GREEKS_COMPUTED = "greeks_computed"
    GREEKS_BATCH_COMPUTED = "greeks_batch_computed"
    ORDER_UPDATE = "order_update"
    ORDER_EVENT = "order_event"
    ORDER_COMMAND = "order_command"
    SVI_ALERT = "svi_alert"
    MODEL_PRICES_COMPUTED = "model_prices_computed"
    MODEL_PRICES_SLOW_COMPUTED = "model_prices_slow_computed"
    CALIBRATION_COMPLETED = "calibration_completed"
    VRP_COMPUTED = "vrp_computed"
    STRATEGY_RESULT = "strategy_result"
    RISK_EXPOSURE = "risk_exposure"
    POSITION_CHAIN_SNAPSHOT = "position_chain_snapshot"
    POSITION_GREEKS_BATCH_COMPUTED = "position_greeks_batch_computed"


class RedisEvent(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid4()))
    event_type: EventType
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source_service: str
    payload: dict
