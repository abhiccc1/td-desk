"""Tests for the POST /api/v1/place-orders endpoint and supporting helpers."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from api_gateway.routers.orders import (
    PlaceOrderLeg,
    PlaceOrderResult,
    PlaceOrdersRequest,
    _split_by_freeze,
    router,
)


# ---------------------------------------------------------------------------
# _split_by_freeze unit tests
# ---------------------------------------------------------------------------

class TestSplitByFreeze:
    def test_no_limit(self):
        assert _split_by_freeze(3600, 0, 75) == [3600]

    def test_within_limit(self):
        assert _split_by_freeze(1800, 1800, 75) == [1800]

    def test_exactly_double(self):
        assert _split_by_freeze(3600, 1800, 75) == [1800, 1800]

    def test_remainder_chunk(self):
        # 2700 / 1800 → 1800 + 900
        assert _split_by_freeze(2700, 1800, 75) == [1800, 900]

    def test_lot_alignment(self):
        # 2000 with freeze 1800, lot 75 → chunks: 1800, then remaining 200:
        # 200 // 75 * 75 = 150, remaining 50 → place exactly 50 (the remainder)
        result = _split_by_freeze(2000, 1800, 75)
        assert result == [1800, 150, 50]
        # Total must equal the requested quantity
        assert sum(result) == 2000

    def test_remainder_less_than_lot(self):
        # 1850 with freeze 1800, lot 75 → 1800 + remaining 50 (exact)
        result = _split_by_freeze(1850, 1800, 75)
        assert result == [1800, 50]
        assert sum(result) == 1850

    def test_small_quantity(self):
        assert _split_by_freeze(75, 1800, 75) == [75]

    def test_banknifty_example(self):
        # BANKNIFTY: freeze=900, lot=30, order for 1800
        assert _split_by_freeze(1800, 900, 30) == [900, 900]

    def test_sensex_example(self):
        # SENSEX: freeze=1000, lot=10, order for 2500
        result = _split_by_freeze(2500, 1000, 10)
        assert result == [1000, 1000, 500]

    def test_lot_size_one(self):
        assert _split_by_freeze(5, 3, 1) == [3, 2]

    def test_total_equals_requested(self):
        """Sum of all chunks must equal the requested quantity."""
        for freeze, lot in [(1800, 75), (900, 30), (1000, 10)]:
            for qty in [freeze, freeze * 2, freeze + lot, freeze * 3 - lot, freeze + 1]:
                chunks = _split_by_freeze(qty, freeze, lot)
                assert sum(chunks) == qty, f"qty={qty}, freeze={freeze}, lot={lot} → chunks {chunks} sum to {sum(chunks)}"


# ---------------------------------------------------------------------------
# PlaceOrdersRequest schema tests
# ---------------------------------------------------------------------------

class TestPlaceOrderSchemas:
    def test_minimal_leg_with_trading_symbol(self):
        leg = PlaceOrderLeg(
            trading_symbol="NIFTY17MAR23100CE",
            transaction_type="B",
            quantity=75,
        )
        assert leg.order_type == "MKT"
        assert leg.product == "NRML"
        assert leg.price == 0
        assert leg.trigger_price == 0

    def test_leg_with_resolution_fields(self):
        leg = PlaceOrderLeg(
            underlying="NIFTY",
            expiry="2026-03-19",
            strike=23100,
            option_type="CE",
            transaction_type="B",
            quantity=150,
            order_type="L",
            price=120.5,
        )
        assert leg.trading_symbol is None
        assert leg.strike == 23100

    def test_quantity_validation(self):
        with pytest.raises(Exception):
            PlaceOrderLeg(trading_symbol="X", transaction_type="B", quantity=0)

    def test_request_with_multiple_legs(self):
        req = PlaceOrdersRequest(orders=[
            PlaceOrderLeg(trading_symbol="A", transaction_type="B", quantity=75),
            PlaceOrderLeg(trading_symbol="B", transaction_type="S", quantity=75),
        ])
        assert len(req.orders) == 2


# ---------------------------------------------------------------------------
# Endpoint integration tests (mocked dependencies)
# ---------------------------------------------------------------------------

def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.state.http_client = MagicMock()
    return app


@pytest.fixture
def app():
    return _make_app()


@pytest.fixture
def mock_neo_client():
    client = MagicMock()
    client.place_order = MagicMock(return_value={
        "stat": "Ok",
        "nOrdNo": "12345",
    })
    return client


def _patch_endpoint_deps(neo_client, *, hgetall_rv=None, im_cfg=None, redis_hget_rv=None):
    """Return a context manager that patches all lazy imports used by place_orders."""
    if hgetall_rv is None:
        hgetall_rv = {}
    patches = {}

    patches["neo"] = patch(
        "api_gateway.routers.orders._get_neo_client",
        new_callable=AsyncMock,
        return_value=neo_client,
    )
    patches["hgetall"] = patch(
        "shared.redis_client.cache_hgetall",
        new_callable=AsyncMock,
        return_value=hgetall_rv,
    )
    patches["im"] = patch(
        "shared.instruments.get_instrument_master",
    )

    if redis_hget_rv is not None:
        mock_redis = AsyncMock()
        mock_redis.hget = AsyncMock(return_value=redis_hget_rv)
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_redis)
        mock_ctx.__aexit__ = AsyncMock(return_value=False)
        patches["get_redis"] = patch(
            "shared.redis_client.get_redis",
            return_value=mock_ctx,
        )
        patches["_mock_redis"] = mock_redis  # stash for assertions

    return patches


_UNSET = object()


class _PatchCtx:
    """Helper to enter/exit multiple patches and configure defaults."""

    def __init__(self, neo_client, *, hgetall_side_effect=None, hgetall_rv=None,
                 segment="nse_fo", redis_hget_rv=_UNSET):
        self.neo_client = neo_client
        self._patchers: list = []
        self._mocks: dict = {}
        self.segment = segment
        self.hgetall_side_effect = hgetall_side_effect
        self.hgetall_rv = hgetall_rv or {}
        self.redis_hget_rv = redis_hget_rv
        self.mock_redis: AsyncMock | None = None

    def __enter__(self):
        self._mocks["neo"] = patch(
            "api_gateway.routers.orders._get_neo_client",
            new_callable=AsyncMock, return_value=self.neo_client,
        ).__enter__()
        # place_orders() loads the session again after a successful placement
        # to kick off the background trade-fill persist. Unmocked it reaches
        # real Redis and the endpoint 401s.
        self._mocks["session"] = patch(
            "api_gateway.routers.orders._load_kotak_session",
            new_callable=AsyncMock,
            return_value=("https://example.invalid", {"Auth": "tok", "Sid": "sid"}),
        ).__enter__()

        hgetall_mock = patch(
            "shared.redis_client.cache_hgetall",
            new_callable=AsyncMock,
        ).__enter__()
        if self.hgetall_side_effect:
            hgetall_mock.side_effect = self.hgetall_side_effect
        else:
            hgetall_mock.return_value = self.hgetall_rv
        self._mocks["hgetall"] = hgetall_mock
        self._patchers.append(("shared.redis_client.cache_hgetall", hgetall_mock))

        im_mock = patch("shared.instruments.get_instrument_master").__enter__()
        cfg = MagicMock()
        cfg.segment = self.segment
        im_mock.return_value.get.return_value = cfg
        self._mocks["im"] = im_mock
        self._patchers.append(("shared.instruments.get_instrument_master", im_mock))

        if self.redis_hget_rv is not _UNSET:
            self.mock_redis = AsyncMock()
            # hget is called for trdsym, token, and sym2tok lookups
            self.mock_redis.hget = AsyncMock(return_value=self.redis_hget_rv)
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=self.mock_redis)
            mock_ctx.__aexit__ = AsyncMock(return_value=False)
            redis_p = patch("shared.redis_client.get_redis", return_value=mock_ctx).__enter__()
            self._patchers.append(("shared.redis_client.get_redis", redis_p))

        # Always mock get_redis for sym2tok reverse lookup (when trading_symbol is provided directly)
        if self.redis_hget_rv is _UNSET:
            self.mock_redis = AsyncMock()
            self.mock_redis.hget = AsyncMock(return_value="12345")
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=self.mock_redis)
            mock_ctx.__aexit__ = AsyncMock(return_value=False)
            redis_p = patch("shared.redis_client.get_redis", return_value=mock_ctx).__enter__()
            self._patchers.append(("shared.redis_client.get_redis", redis_p))

        return self

    def __exit__(self, *args):
        patch.stopall()


class TestPlaceOrdersEndpoint:
    @pytest.mark.asyncio
    async def test_empty_orders_returns_400(self, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/v1/place-orders", json={"orders": []})
            assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_missing_auth_returns_401(self, app):
        with patch(
            "api_gateway.routers.orders._get_neo_client",
            new_callable=AsyncMock,
        ) as mock_neo:
            from fastapi import HTTPException
            mock_neo.side_effect = HTTPException(status_code=401, detail="Kotak session unavailable")
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{"trading_symbol": "X", "transaction_type": "B", "quantity": 75}],
                })
                assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_single_buy_order_with_trading_symbol(self, app, mock_neo_client):
        with _PatchCtx(mock_neo_client):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "trading_symbol": "NIFTY17MAR23100CE",
                        "transaction_type": "B",
                        "quantity": 75,
                        "order_type": "MKT",
                        "product": "NRML",
                    }],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert len(data) == 1
                assert data[0]["success"] is True
                assert data[0]["orderNumber"] == "12345"

    @pytest.mark.asyncio
    async def test_buy_first_ordering(self, app, mock_neo_client):
        """BUY legs must be placed before SELL legs."""
        call_order = []

        def tracking_place(**kwargs):
            call_order.append(kwargs["transaction_type"])
            return {"stat": "Ok", "nOrdNo": f"ord-{len(call_order)}"}

        mock_neo_client.place_order = tracking_place

        with _PatchCtx(mock_neo_client):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [
                        {"trading_symbol": "NIFTY17MAR23100PE", "transaction_type": "S", "quantity": 75},
                        {"trading_symbol": "NIFTY17MAR23000PE", "transaction_type": "B", "quantity": 75},
                    ],
                })
                assert resp.status_code == 200
                assert call_order == ["B", "S"]

    @pytest.mark.asyncio
    async def test_buy_failure_skips_sells(self, app, mock_neo_client):
        """If a BUY order fails, SELL orders should be skipped."""
        mock_neo_client.place_order = MagicMock(
            return_value={"stat": "Not_Ok", "errMsg": "Insufficient margin"}
        )

        with _PatchCtx(mock_neo_client):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [
                        {"trading_symbol": "NIFTY17MAR23000PE", "transaction_type": "B", "quantity": 75},
                        {"trading_symbol": "NIFTY17MAR23100PE", "transaction_type": "S", "quantity": 75},
                    ],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert data[0]["success"] is False
                assert "Insufficient margin" in data[0]["error"]
                assert data[1]["success"] is False
                assert "Skipped SELL" in data[1]["error"]
                assert mock_neo_client.place_order.call_count == 1

    @pytest.mark.asyncio
    async def test_missing_resolution_fields_returns_error(self, app, mock_neo_client):
        """Legs without trading_symbol must have all resolution fields."""
        with _PatchCtx(mock_neo_client):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "underlying": "NIFTY",
                        "transaction_type": "B",
                        "quantity": 75,
                    }],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert data[0]["success"] is False
                assert "Missing required fields" in data[0]["error"]

    @pytest.mark.asyncio
    async def test_freeze_qty_splitting(self, app, mock_neo_client):
        """Large orders should be split by freeze quantity."""
        call_qtys = []

        def tracking_place(**kwargs):
            call_qtys.append(int(kwargs["quantity"]))
            return {"stat": "Ok", "nOrdNo": f"ord-{len(call_qtys)}"}

        mock_neo_client.place_order = tracking_place

        with _PatchCtx(
            mock_neo_client,
            hgetall_side_effect=[
                {"NIFTY": "1800"},
                {"NIFTY": "75"},
            ],
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "trading_symbol": "NIFTY17MAR23100CE",
                        "transaction_type": "B",
                        "quantity": 3600,
                    }],
                })
                assert resp.status_code == 200
                assert call_qtys == [1800, 1800]

    @pytest.mark.asyncio
    async def test_symbol_resolution_from_redis(self, app, mock_neo_client):
        """When no trading_symbol is provided, resolve from Redis cache."""
        with _PatchCtx(mock_neo_client, redis_hget_rv="NIFTY19MAR23100CE") as ctx:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "underlying": "NIFTY",
                        "expiry": "2026-03-19",
                        "strike": 23100,
                        "option_type": "CE",
                        "transaction_type": "B",
                        "quantity": 75,
                    }],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert data[0]["success"] is True
                # hget is called twice: once for trdsym, once for token
                calls = ctx.mock_redis.hget.call_args_list
                assert any(c.args == ("cache:scrip:trdsym:NIFTY:2026-03-19", "23100:CE") for c in calls)
                assert any(c.args == ("cache:scrip:token:NIFTY:2026-03-19", "23100:CE") for c in calls)

    @pytest.mark.asyncio
    async def test_symbol_not_found_in_redis(self, app, mock_neo_client):
        """If trading symbol can't be resolved, return error for that leg."""
        with _PatchCtx(mock_neo_client, redis_hget_rv=None):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "underlying": "NIFTY",
                        "expiry": "2026-03-19",
                        "strike": 99999,
                        "option_type": "CE",
                        "transaction_type": "B",
                        "quantity": 75,
                    }],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert data[0]["success"] is False
                assert "Trading symbol not found" in data[0]["error"]

    @pytest.mark.asyncio
    async def test_strike_zero_treated_as_missing(self, app, mock_neo_client):
        """Strike of 0 should be treated as missing (not a valid strike)."""
        with _PatchCtx(mock_neo_client):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "underlying": "NIFTY",
                        "expiry": "2026-03-19",
                        "strike": 0,
                        "option_type": "CE",
                        "transaction_type": "B",
                        "quantity": 75,
                    }],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert data[0]["success"] is False
                assert "Missing required fields" in data[0]["error"]

    @pytest.mark.asyncio
    async def test_sdk_exception_handled(self, app, mock_neo_client):
        """SDK exceptions should be caught and returned as errors."""
        mock_neo_client.place_order = MagicMock(side_effect=RuntimeError("connection reset"))

        with _PatchCtx(mock_neo_client):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/api/v1/place-orders", json={
                    "orders": [{
                        "trading_symbol": "NIFTY17MAR23100CE",
                        "transaction_type": "B",
                        "quantity": 75,
                    }],
                })
                assert resp.status_code == 200
                data = resp.json()
                assert data[0]["success"] is False
                assert "connection reset" in data[0]["error"]
