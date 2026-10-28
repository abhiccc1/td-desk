"""Tests for the paper-trading router and accounting — isolation + correctness."""

from __future__ import annotations

import ast
import inspect
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from api_gateway.routers import paper_trading as paper_router
from api_gateway.routers.paper_trading import PaperOrderLeg, router
from shared import paper_trading as paper_accounting
from shared import scrip_resolve


# ---------------------------------------------------------------------------
# SAFETY: the paper path must never import broker code (AST-based, so docstring
# mentions of the forbidden names don't count — only real import statements).
# ---------------------------------------------------------------------------

_FORBIDDEN_IMPORTS = {
    "neo_api_client",
    "shared.live_session",
    "api_gateway.routers.orders",
}


def _imported_modules(module) -> set[str]:
    """Collect every module name imported anywhere in the source (incl. lazy)."""
    src = inspect.getsource(module)
    names: set[str] = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


@pytest.mark.parametrize("module", [paper_router, paper_accounting, scrip_resolve])
def test_no_broker_imports(module):
    imported = _imported_modules(module)
    leaked = imported & _FORBIDDEN_IMPORTS
    assert not leaked, f"{module.__name__} imports broker code: {leaked}"
    # Also guard against any submodule of the broker SDK.
    assert not any(m.startswith("neo_api_client") for m in imported)


# ---------------------------------------------------------------------------
# Position accounting (_derive) — pure math, no DB.
# ---------------------------------------------------------------------------

class TestDerive:
    def test_open_long(self):
        d = paper_accounting._derive(75, 0, 7500.0, 0.0, multiplier=1, precision=2)
        assert d["net_qty"] == 75
        assert d["side"] == "BUY"
        assert d["is_open"] is True
        assert d["avg_price"] == 100.0
        assert d["booked_pnl"] == -7500.0  # bought, not yet sold

    def test_open_short(self):
        d = paper_accounting._derive(0, 75, 0.0, 9000.0, multiplier=1, precision=2)
        assert d["net_qty"] == -75
        assert d["side"] == "SELL"
        assert d["avg_price"] == 120.0
        assert d["booked_pnl"] == 9000.0

    def test_closed_realized_profit(self):
        # Bought 75 @100 (7500), sold 75 @130 (9750) → closed, +2250 realized
        d = paper_accounting._derive(75, 75, 7500.0, 9750.0, multiplier=1, precision=2)
        assert d["net_qty"] == 0
        assert d["side"] == "CLOSED"
        assert d["is_open"] is False
        assert d["booked_pnl"] == 2250.0


# ---------------------------------------------------------------------------
# PaperOrderLeg schema
# ---------------------------------------------------------------------------

class TestPaperOrderLeg:
    def test_resolution_fields(self):
        leg = PaperOrderLeg(
            underlying="NIFTY", expiry="2026-03-19", strike=23800,
            option_type="CE", transaction_type="B", quantity=75,
        )
        assert leg.order_type == "MKT"
        assert leg.trading_symbol is None

    def test_quantity_validation(self):
        with pytest.raises(Exception):
            PaperOrderLeg(trading_symbol="X", transaction_type="B", quantity=0)


# ---------------------------------------------------------------------------
# build_cache_symbol
# ---------------------------------------------------------------------------

def test_build_cache_symbol():
    assert scrip_resolve.build_cache_symbol("NIFTY", "2026-03-19", 23800, "CE") == "NIFTY 260319 23800 CE"
    assert scrip_resolve.build_cache_symbol("nifty", "2026-03-19", 23800.0, "PE") == "NIFTY 260319 23800 PE"
    assert scrip_resolve.build_cache_symbol("NIFTY", "bad-date", 23800, "CE") is None


@pytest.mark.asyncio
async def test_resolve_builds_cache_symbol_for_squareoff_leg():
    """Square-off / modify legs carry BOTH trading_symbol AND option fields.

    The LTP cache is keyed by the cache symbol, not the trading symbol, so the
    resolver must build the cache symbol from the option fields even when a
    trading_symbol is present — otherwise the paper-fill price lookup misses.
    """
    from types import SimpleNamespace

    leg = SimpleNamespace(
        trading_symbol="NIFTY2660923200PE",
        underlying="NIFTY", expiry="2026-06-09", strike=23200.0, option_type="PE",
        transaction_type="B", quantity=65, order_type="MKT", product="NRML",
        price=0, trigger_price=0, tag=None,
    )

    mock_redis = AsyncMock()
    mock_redis.hget = AsyncMock(return_value="")
    mock_ctx = AsyncMock()
    mock_ctx.__aenter__ = AsyncMock(return_value=mock_redis)
    mock_ctx.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("shared.redis_client.get_redis", return_value=mock_ctx),
        patch("shared.instruments.get_instrument_master", return_value=SimpleNamespace(get=lambda _u: None)),
    ):
        resolved, errors = await scrip_resolve.resolve_order_legs([leg], "redis://x")

    assert not errors
    assert resolved[0]["cache_symbol"] == "NIFTY 260609 23200 PE"


def test_parse_expiry_date():
    import datetime as _dt

    # ISO string → date object (DATE column needs a real date, not a str)
    assert paper_accounting._parse_expiry_date("2026-06-09") == _dt.date(2026, 6, 9)
    assert paper_accounting._parse_expiry_date(_dt.date(2026, 6, 9)) == _dt.date(2026, 6, 9)
    assert paper_accounting._parse_expiry_date(None) is None
    assert paper_accounting._parse_expiry_date("") is None
    assert paper_accounting._parse_expiry_date("not-a-date") is None


# ---------------------------------------------------------------------------
# Endpoint integration — mocked resolution, LTP and DB.
# ---------------------------------------------------------------------------

def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.mark.asyncio
async def test_place_paper_order_fills_at_ltp():
    app = _make_app()

    resolved = [{
        "original_index": 0,
        "trading_symbol": "NIFTY2603192380CE",
        "cache_symbol": "NIFTY 260319 23800 CE",
        "scrip_token": "12345",
        "exchange_segment": "nse_fo",
        "underlying": "NIFTY",
        "expiry": "2026-03-19",
        "strike": 23800,
        "option_type": "CE",
        "transaction_type": "B",
        "quantity": 75,
        "order_type": "MKT",
        "product": "NRML",
        "price": 0,
        "trigger_price": 0,
        "tag": None,
    }]

    apply_mock = AsyncMock()
    with (
        patch("shared.scrip_resolve.resolve_order_legs", new_callable=AsyncMock, return_value=(resolved, [])),
        patch("shared.redis_client.cache_hgetall", new_callable=AsyncMock, return_value={"NIFTY": "75"}),
        patch("shared.redis_client.cache_get", new_callable=AsyncMock, return_value='{"ltp": 142.5}'),
        patch("shared.paper_trading.apply_paper_fill", apply_mock),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/paper/place-orders", json={"orders": [{
                "underlying": "NIFTY", "expiry": "2026-03-19", "strike": 23800,
                "option_type": "CE", "transaction_type": "B", "quantity": 75,
            }]})

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["success"] is True
    assert body[0]["fillPrice"] == 142.5
    assert body[0]["orderNumber"] == "PAPER-0"

    # The fill was applied at the live LTP, BUY side, with no broker contact.
    apply_mock.assert_awaited_once()
    fill = apply_mock.await_args.args[1]
    assert fill["side"] == "BUY"
    assert fill["price"] == 142.5
    assert fill["symbol"] == "NIFTY 260319 23800 CE"
    assert fill["lot_size"] == 75


@pytest.mark.asyncio
async def test_place_paper_order_rejected_without_ltp():
    app = _make_app()
    resolved = [{
        "original_index": 0, "trading_symbol": "X", "cache_symbol": "NIFTY 260319 23800 CE",
        "scrip_token": "", "exchange_segment": "nse_fo", "underlying": "NIFTY",
        "expiry": "2026-03-19", "strike": 23800, "option_type": "CE",
        "transaction_type": "B", "quantity": 75, "order_type": "MKT", "product": "NRML",
        "price": 0, "trigger_price": 0, "tag": None,
    }]
    apply_mock = AsyncMock()
    with (
        patch("shared.scrip_resolve.resolve_order_legs", new_callable=AsyncMock, return_value=(resolved, [])),
        patch("shared.redis_client.cache_hgetall", new_callable=AsyncMock, return_value={}),
        patch("shared.redis_client.cache_get", new_callable=AsyncMock, return_value=None),
        patch("shared.paper_trading.apply_paper_fill", apply_mock),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/paper/place-orders", json={"orders": [{
                "underlying": "NIFTY", "expiry": "2026-03-19", "strike": 23800,
                "option_type": "CE", "transaction_type": "B", "quantity": 75,
            }]})

    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["success"] is False
    assert "No live price" in body[0]["error"]
    apply_mock.assert_not_awaited()  # no fill recorded when price unavailable
