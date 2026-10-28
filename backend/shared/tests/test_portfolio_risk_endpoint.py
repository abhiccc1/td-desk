"""Integration test for the portfolio risk endpoint."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from api_gateway.routers.analytics import router
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from shared.schemas.risk import (
    GreekExposure,
    PortfolioRiskResult,
    StrategyTailRisk,
    UnderlyingRiskSummary,
)
from shared.schemas.strategy import MarginInfo, StrategyResult


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.state.http_client = MagicMock()
    return app


@pytest.mark.asyncio
async def test_portfolio_risk_endpoint(monkeypatch):
    now = datetime.now(UTC)
    mock_result = PortfolioRiskResult(
        as_of=now,
        account_net=100000.0,
        available_margin=75000.0,
        margin_used=25000.0,
        collateral=5000.0,
        position_count=1,
        underlying_count=1,
        expiry_count=1,
        exposures=GreekExposure(delta=1.0),
        risk_level="safe",
        flags=[],
        underlyings=[
            UnderlyingRiskSummary(
                underlying="NIFTY",
                spot=22500.0,
                atm_iv=0.18,
                iv_rank=50.0,
                vrp=0.06,
                position_count=1,
                expiry_count=1,
                exposures=GreekExposure(delta=1.0),
                tail_risk=StrategyTailRisk(
                    spot=22500.0,
                    atm_iv=0.18,
                    expected_move=250.0,
                    expected_move_pct=1.1,
                ),
                risk_level="safe",
                flags=[],
                strategy=StrategyResult(
                    legs=[],
                    net_credit=0.0,
                    max_profit=10.0,
                    max_loss=-5.0,
                    breakeven_points=[22500.0],
                    probability_of_profit=0.5,
                    margin=MarginInfo(
                        initial_margin=100.0,
                        maintenance_margin=75.0,
                        collateral_utilization=0.1,
                    ),
                    payoff_x=[22400.0, 22500.0, 22600.0],
                    payoff_y=[-5.0, 0.0, 10.0],
                ),
            ),
        ],
    )

    monkeypatch.setattr(
        "shared.positions.load_positions",
        AsyncMock(
            return_value=[
                {"symbol": "NIFTY 260319 22500 CE", "quantity": 65, "netQty": 65, "isOpen": True},
            ]
        ),
    )
    monkeypatch.setattr(
        "api_gateway.routers.analytics.build_portfolio_risk",
        AsyncMock(return_value=mock_result),
    )

    app = _make_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/portfolio-risk")

    assert resp.status_code == 200
    body = resp.json()
    assert body["underlyingCount"] == 1
    assert body["positionCount"] == 1
    assert body["underlyings"][0]["underlying"] == "NIFTY"
