from shared.schemas.events import EventType


def test_event_type_enum_covers_quant_contract() -> None:
    assert EventType.ORDER_COMMAND == "order_command"
    assert EventType.STRATEGY_RESULT == "strategy_result"
    assert EventType.RISK_EXPOSURE == "risk_exposure"
