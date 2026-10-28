from datetime import datetime, timezone
import sys
import types

import pytest

sys.modules.setdefault(
    "orjson",
    types.SimpleNamespace(
        loads=lambda value: value,
        dumps=lambda value: b"{}",
    ),
)

if "sqlalchemy" not in sys.modules:
    sqlalchemy_module = types.ModuleType("sqlalchemy")
    sqlalchemy_module.text = lambda value: value
    sys.modules["sqlalchemy"] = sqlalchemy_module

if "sqlalchemy.ext" not in sys.modules:
    sys.modules["sqlalchemy.ext"] = types.ModuleType("sqlalchemy.ext")

if "sqlalchemy.ext.asyncio" not in sys.modules:
    asyncio_module = types.ModuleType("sqlalchemy.ext.asyncio")

    class AsyncEngine:  # pragma: no cover - import shim for local tests
        pass

    asyncio_module.AsyncEngine = AsyncEngine
    sys.modules["sqlalchemy.ext.asyncio"] = asyncio_module

from shared.schemas.events import EventType
from shared.schemas.order import OrderFill, OrderSide, OrderStatus

from order_service.main import _command_listener
from order_service.publisher import publish_basket_status, publish_order_update


@pytest.mark.asyncio
async def test_publish_order_update_uses_full_event_contract(monkeypatch) -> None:
    captured = {}

    async def fake_publish_event(redis_url, channel, event):
        captured["redis_url"] = redis_url
        captured["channel"] = channel
        captured["event"] = event

    monkeypatch.setattr("order_service.publisher.publish_event", fake_publish_event)

    fill = OrderFill(
        order_id="ord-1",
        symbol="NIFTY 260326 22500 CE",
        side=OrderSide.BUY,
        filled_qty=50,
        avg_fill_price=123.45,
        status=OrderStatus.FILLED,
        timestamp=datetime.now(timezone.utc),
    )

    await publish_order_update("default", fill)

    assert captured["redis_url"] == "redis://localhost:6379/0"
    assert captured["channel"] == "orders:updates:default"
    assert captured["event"].event_type == EventType.ORDER_UPDATE
    assert captured["event"].source_service == "order_service"
    assert captured["event"].payload["order_id"] == "ord-1"


@pytest.mark.asyncio
async def test_publish_basket_status_uses_full_event_contract(monkeypatch) -> None:
    captured = {}

    async def fake_publish_event(redis_url, channel, event):
        captured["redis_url"] = redis_url
        captured["channel"] = channel
        captured["event"] = event

    monkeypatch.setattr("order_service.publisher.publish_event", fake_publish_event)

    await publish_basket_status("default", "basket-1", "SUBMITTED")

    assert captured["redis_url"] == "redis://localhost:6379/0"
    assert captured["channel"] == "orders:updates:default"
    assert captured["event"].event_type == EventType.ORDER_UPDATE
    assert captured["event"].source_service == "order_service"
    assert captured["event"].payload == {"basket_id": "basket-1", "status": "SUBMITTED"}


@pytest.mark.asyncio
async def test_command_listener_subscribes_with_redis_url(monkeypatch) -> None:
    captured = {}

    async def fake_subscribe(redis_url, channels, pattern=False):
        captured["redis_url"] = redis_url
        captured["channels"] = channels
        captured["pattern"] = pattern
        if False:
            yield "", None
        return

    monkeypatch.setattr("order_service.main.subscribe", fake_subscribe)

    await _command_listener()

    assert captured == {
        "redis_url": "redis://localhost:6379/0",
        "channels": ["orders:commands"],
        "pattern": False,
    }
