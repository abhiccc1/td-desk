import sys
import types

sys.modules.setdefault(
    "orjson",
    types.SimpleNamespace(
        loads=lambda value: value,
        dumps=lambda value: b"{}",
    ),
)

from shared.schemas.events import EventType, RedisEvent

from quant_service.publisher import ResultPublisher


def test_strategy_result_routes_by_underlying_and_expiry() -> None:
    publisher = ResultPublisher("redis://unused")
    event = RedisEvent(
        event_type=EventType.STRATEGY_RESULT,
        source_service="quant_service",
        payload={
            "legs": [
                {
                    "underlying": "NIFTY",
                    "expiry": "2026-03-26",
                },
            ],
        },
    )

    assert publisher._resolve_channel(event) == "strategy:result:NIFTY:2026-03-26"


def test_risk_exposure_routes_to_single_portfolio_channel() -> None:
    publisher = ResultPublisher("redis://unused")
    event = RedisEvent(
        event_type=EventType.RISK_EXPOSURE,
        source_service="quant_service",
        payload={"net_delta": 12.5},
    )

    assert publisher._resolve_channel(event) == "risk:exposure"
