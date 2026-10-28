"""MCX order-side guards: lot multiples, freeze split, live-order gate, segment."""

from __future__ import annotations

import pytest

from api_gateway.routers.orders import (
    _mcx_live_orders_enabled,
    _segment_for_trading_symbol,
    _split_by_freeze,
    _validate_commodity_leg,
)
from shared.instruments import get_instrument_master


@pytest.fixture
def im():
    return get_instrument_master()


@pytest.mark.parametrize("name,qty,ok", [
    ("CRUDEOIL", 100, True), ("CRUDEOIL", 150, False),
    ("CRUDEOILM", 30, True), ("NATURALGAS", 1250, True), ("NATURALGAS", 250, False),
    ("NATGASMINI", 500, True), ("GOLD", 3, True), ("GOLDM", 100, True), ("GOLDM", 50, False),
])
def test_lot_multiple(im, name, qty, ok):
    assert (_validate_commodity_leg(qty, im.get(name)) is None) is ok


def test_live_gate_default_off(monkeypatch):
    monkeypatch.delenv("MCX_LIVE_ORDERS_ENABLED", raising=False)
    assert _mcx_live_orders_enabled() is False
    monkeypatch.setenv("MCX_LIVE_ORDERS_ENABLED", "true")
    assert _mcx_live_orders_enabled() is True


def test_freeze_split_gold(im):
    gold = im.get("GOLD")
    # 250 lots of GOLD (lot=1), max 100/order
    assert _split_by_freeze(250, gold.freeze_quantity, gold.lot_size) == [100, 100, 50]


def test_freeze_split_crude(im):
    crude = im.get("CRUDEOIL")
    # 150 lots × 100 bbl, max 10000/order
    assert _split_by_freeze(15000, crude.freeze_quantity, crude.lot_size) == [10000, 5000]


@pytest.mark.parametrize("sym,seg", [
    ("CRUDEOIL19NOV2610800CE", "mcx_fo"),
    ("GOLDM29OCT26147500CE", "mcx_fo"),
    ("NATGASMINI23OCT26135PE", "mcx_fo"),
    ("NIFTY26OCT25000CE", "nse_fo"),
    ("SENSEX26OCT80000CE", "bse_fo"),
    ("RELIANCE26OCT3000CE", "nse_fo"),  # untracked → legacy fallback
])
def test_segment_for_trading_symbol(sym, seg):
    assert _segment_for_trading_symbol(sym) == seg
