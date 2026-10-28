from shared.positions import (
    _compute_cycle_realized_pnl,
    _compute_snapshot_realized_component,
    _select_latest_cycle_fills,
)


def test_select_latest_cycle_fills_ignores_older_same_symbol_round_trip() -> None:
    fills = [
        {"side": "SELL", "quantity": 455, "price": 103.25, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 104.75, "multiplier": 1},
        {"side": "BUY", "quantity": 130, "price": 80.25, "multiplier": 1},
        {"side": "BUY", "quantity": 390, "price": 80.25, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 51.65, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 47.65, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 47.65, "multiplier": 1},
        {"side": "SELL", "quantity": 130, "price": 47.65, "multiplier": 1},
        {"side": "SELL", "quantity": 325, "price": 47.60, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 47.60, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 48.50, "multiplier": 1},
        {"side": "SELL", "quantity": 130, "price": 49.00, "multiplier": 1},
        {"side": "BUY", "quantity": 910, "price": 98.675, "multiplier": 1},
    ]

    latest_cycle = _select_latest_cycle_fills(fills, buy_qty=910, sell_qty=910)

    assert latest_cycle is not None
    assert sum(fill["quantity"] for fill in latest_cycle if fill["side"] == "BUY") == 910
    assert sum(fill["quantity"] for fill in latest_cycle if fill["side"] == "SELL") == 910
    assert latest_cycle[0] == {"side": "SELL", "quantity": 65, "price": 51.65, "multiplier": 1}
    assert _compute_cycle_realized_pnl(latest_cycle) == -45961.5


def test_compute_cycle_realized_pnl_for_closed_carried_short() -> None:
    fills = [
        {"side": "SELL", "quantity": 455, "price": 71.35, "multiplier": 1},
        {"side": "SELL", "quantity": 130, "price": 69.65, "multiplier": 1},
        {"side": "SELL", "quantity": 780, "price": 69.65, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 69.55, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 69.40, "multiplier": 1},
        {"side": "SELL", "quantity": 65, "price": 69.35, "multiplier": 1},
        {"side": "BUY", "quantity": 585, "price": 17.90, "multiplier": 1},
        {"side": "BUY", "quantity": 455, "price": 17.95, "multiplier": 1},
        {"side": "BUY", "quantity": 520, "price": 18.05, "multiplier": 1},
    ]

    latest_cycle = _select_latest_cycle_fills(fills, buy_qty=1560, sell_qty=1560)

    assert latest_cycle is not None
    assert _compute_cycle_realized_pnl(latest_cycle) == 81360.5


def test_compute_snapshot_realized_component_for_open_carry_forward_short() -> None:
    pos = {
        "totalSellAmt": 137907.25,
        "totalBuyAmt": 89794.25,
        "netQty": -1170,
        "avgPrice": 75.75,
        "multiplier": 1,
    }

    assert _compute_snapshot_realized_component(pos) == -40514.5
