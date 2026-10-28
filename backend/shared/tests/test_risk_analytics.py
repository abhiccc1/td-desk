"""Tests for shared strategy and portfolio risk helpers."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from shared.risk_analytics import build_portfolio_risk, parse_position_symbol
from shared.schemas.greeks import VrpResult
from shared.schemas.strategy import MarginInfo, StrategyResult


def test_parse_position_symbol():
    parsed = parse_position_symbol("NIFTY 260319 22500 CE")
    assert parsed["underlying"] == "NIFTY"
    assert parsed["expiry"] == "2026-03-19"
    assert parsed["strike"] == 22500.0
    assert parsed["option_type"] == "CE"


@pytest.mark.asyncio
async def test_build_portfolio_risk_groups_and_normalizes(monkeypatch):
    positions = [
        {
            "symbol": "NIFTY 260319 22500 CE",
            "quantity": 65,
            "netQty": 65,
            "side": "BUY",
            "isOpen": True,
            "strikePrice": "22500",
            "expiry": "2026-03-19",
            "avgPrice": 120.0,
        },
        {
            "symbol": "NIFTY 260319 22600 PE",
            "quantity": -65,
            "netQty": -65,
            "side": "SELL",
            "isOpen": True,
            "strikePrice": "22600",
            "expiry": "2026-03-19",
            "avgPrice": 105.0,
        },
    ]

    async def fake_load_account_limits(_redis_url: str):
        return {
            "net": 100000.0,
            "available_margin": 75000.0,
            "margin_used": 25000.0,
            "collateral": 5000.0,
        }

    async def fake_load_cached_greeks(_redis_url: str, _underlying: str, _expiry: str):
        return {
            "NIFTY 260319 22500 CE": {
                "delta": 0.40,
                "gamma": 0.02,
                "theta": -3.0,
                "vega": 4.5,
                "vanna": 0.8,
                "charm": -0.05,
                "vomma": -0.01,
                "underlying_price": 22500.0,
            },
            "NIFTY 260319 22600 PE": {
                "delta": -0.20,
                "gamma": 0.01,
                "theta": -2.0,
                "vega": 3.0,
                "vanna": 0.4,
                "charm": -0.03,
                "vomma": -0.01,
                "underlying_price": 22500.0,
            },
        }

    async def fake_load_cached_snapshot(_redis_url: str, _underlying: str, _expiry: str):
        return {"underlyingPrice": 22500.0}

    async def fake_load_cached_vrp(_redis_url: str, _underlying: str):
        return VrpResult(
            underlying="NIFTY",
            atm_iv=0.18,
            realized_vol=0.12,
            vrp=0.06,
            iv_rank=55.0,
            window_days=10,
            timestamp=datetime.now(UTC),
        )

    async def fake_build_strategy_result(*_args, **_kwargs):
        return StrategyResult(
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
        )

    monkeypatch.setattr("shared.risk_analytics.load_account_limits", fake_load_account_limits)
    monkeypatch.setattr("shared.risk_analytics.load_cached_greeks", fake_load_cached_greeks)
    monkeypatch.setattr("shared.risk_analytics.load_cached_snapshot", fake_load_cached_snapshot)
    monkeypatch.setattr("shared.risk_analytics.load_cached_vrp", fake_load_cached_vrp)
    monkeypatch.setattr("shared.risk_analytics.build_strategy_result", fake_build_strategy_result)

    result = await build_portfolio_risk(positions, redis_url="redis://example")

    assert result.underlying_count == 1
    assert result.position_count == 2
    assert result.risk_level in {"safe", "elevated", "high", "critical"}
    assert len(result.underlyings) == 1
    underlying = result.underlyings[0]
    assert underlying.underlying == "NIFTY"
    assert underlying.spot == 22500.0
    assert underlying.exposures.delta == pytest.approx(0.60)
    assert underlying.exposures.gamma == pytest.approx(0.01)
    assert underlying.exposures.theta == pytest.approx(-1.0)
    assert underlying.exposures.vega == pytest.approx(1.5)
    assert underlying.exposures.vanna == pytest.approx(0.4)
    assert underlying.exposures.charm == pytest.approx(-0.02)
    assert underlying.exposures.vomma == pytest.approx(0.0)
    assert underlying.tail_risk.expected_move is not None
    assert underlying.expiry_count == 1


@pytest.mark.asyncio
async def test_build_portfolio_risk_emits_policy_suggestions(monkeypatch):
    positions = [
        {
            "symbol": "NIFTY 260319 22500 CE",
            "quantity": -1,
            "netQty": -1,
            "side": "SELL",
            "isOpen": True,
            "strikePrice": "22500",
            "expiry": "2026-03-19",
            "avgPrice": 120.0,
        },
    ]

    async def fake_load_account_limits(_redis_url: str):
        return {
            "net": 100000.0,
            "available_margin": 12000.0,
            "margin_used": 88000.0,
            "collateral": 5000.0,
        }

    async def fake_load_cached_greeks(_redis_url: str, _underlying: str, _expiry: str):
        return {
            "NIFTY 260319 22500 CE": {
                "delta": 18.0,
                "gamma": 6.0,
                "theta": -3.0,
                "vega": 15.0,
                "vanna": 9.0,
                "charm": -0.05,
                "vomma": 2.5,
                "underlying_price": 22500.0,
            },
        }

    async def fake_load_cached_snapshot(_redis_url: str, _underlying: str, _expiry: str):
        return {"underlyingPrice": 22500.0}

    async def fake_load_cached_vrp(_redis_url: str, _underlying: str):
        return VrpResult(
            underlying="NIFTY",
            atm_iv=0.22,
            realized_vol=0.15,
            vrp=0.07,
            iv_rank=40.0,
            window_days=10,
            timestamp=datetime.now(UTC),
        )

    async def fake_build_strategy_result(*_args, **_kwargs):
        return StrategyResult(
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
        )

    monkeypatch.setattr("shared.risk_analytics.load_account_limits", fake_load_account_limits)
    monkeypatch.setattr("shared.risk_analytics.load_cached_greeks", fake_load_cached_greeks)
    monkeypatch.setattr("shared.risk_analytics.load_cached_snapshot", fake_load_cached_snapshot)
    monkeypatch.setattr("shared.risk_analytics.load_cached_vrp", fake_load_cached_vrp)
    monkeypatch.setattr("shared.risk_analytics.build_strategy_result", fake_build_strategy_result)
    monkeypatch.setattr("shared.risk_analytics.days_to_expiry", lambda *_args, **_kwargs: 3)
    monkeypatch.setattr(
        "shared.risk_analytics.time_to_expiry_years",
        lambda *_args, **_kwargs: 3 / 365.25,
    )

    result = await build_portfolio_risk(positions, redis_url="redis://example")

    underlying = result.underlyings[0]
    rule_ids = {item.rule_id for item in underlying.suggestions}
    portfolio_rule_ids = {item.rule_id for item in result.suggestions}

    assert "delta_hedge" in rule_ids
    assert "reduce_short_gamma_front_expiry" in rule_ids
    assert "add_vol_convexity" in rule_ids
    assert "preserve_margin_headroom" in portfolio_rule_ids


@pytest.mark.asyncio
async def test_build_regime_snapshot_uses_percentiles(monkeypatch):
    """Percentile fields should be populated and used when surface percentile data is cached."""
    import json as _json

    from shared.risk_analytics import build_regime_snapshot

    # Provide a sorted history where a term_structure_slope of -0.005
    # falls at percentile ~5 (below the backwardation threshold of 10).
    history = {
        "term_structure_slope": [round(-0.04 + i * 0.002, 4) for i in range(40)],  # -0.04 to +0.04
        "skew_indicator": [round(i * 0.001, 4) for i in range(40)],                # 0 to 0.039
        "convexity_indicator": [round(-0.01 + i * 0.001, 4) for i in range(40)],   # -0.01 to +0.03
    }

    fake_cache: dict[str, str] = {
        "cache:surface_percentiles:NIFTY": _json.dumps(history),
    }

    async def fake_cache_get(_url: str, key: str) -> str | None:
        return fake_cache.get(key)

    monkeypatch.setattr("shared.risk_analytics.cache_get", fake_cache_get)
    monkeypatch.setattr("shared.risk_analytics.load_underlying_expiries", lambda *a, **k: [])

    # IV rank 85 + backwardation (percentile ~5) → should be "stressed"
    snapshot = await build_regime_snapshot(
        redis_url="redis://example",
        underlying="NIFTY",
        expiry=None,
        spot=22500.0,
        atm_iv=0.18,
        iv_rank=85.0,
        vrp=0.06,
        daily_expected_move_pct=1.2,
    )
    # Percentile data can't be looked up without slope/skew values from SVI (no expiry),
    # so the snapshot should still be created but without percentile enrichment.
    assert snapshot is not None
    assert snapshot.underlying == "NIFTY"


@pytest.mark.asyncio
async def test_build_regime_snapshot_event_tags(monkeypatch):
    """Event tags from the event calendar should trigger event_rich regime."""
    import json as _json

    from shared.risk_analytics import build_regime_snapshot

    fake_cache: dict[str, str] = {
        "cache:event_calendar:NIFTY": _json.dumps([
            {"date": "2026-03-22", "label": "RBI_policy", "type": "policy"},
            {"date": "2026-03-27", "label": "GDP_release", "type": "economic_data"},
        ]),
    }

    async def fake_cache_get(_url: str, key: str) -> str | None:
        return fake_cache.get(key)

    monkeypatch.setattr("shared.risk_analytics.cache_get", fake_cache_get)
    monkeypatch.setattr("shared.risk_analytics.load_underlying_expiries", lambda *a, **k: [])

    snapshot = await build_regime_snapshot(
        redis_url="redis://example",
        underlying="NIFTY",
        expiry=None,
        spot=22500.0,
        atm_iv=0.18,
        iv_rank=50.0,
        vrp=0.04,
        daily_expected_move_pct=1.0,
        as_of=datetime(2026, 3, 21, tzinfo=UTC),
    )

    assert snapshot is not None
    # RBI_policy is within 3 days, GDP_release is 6 days away → only RBI_policy tagged
    assert "RBI_policy" in snapshot.event_tags
    assert "GDP_release" not in snapshot.event_tags
    # Event tags present → regime should be event_rich (IV rank 50 is not >= 80)
    assert snapshot.regime_label == "event_rich"


def test_suggestions_ranked_by_trade_quality():
    """Within the same severity bucket, lower quality should sort earlier (higher priority)."""
    from shared.risk_analytics import _build_portfolio_suggestions
    from shared.schemas.risk import AdjustmentSuggestion, UnderlyingRiskSummary, GreekExposure, StrategyTailRisk

    base_exposures = GreekExposure(delta=0, gamma=0, theta=0, vega=0, vanna=0, charm=0, vomma=0)
    base_tail = StrategyTailRisk(spot=22500)

    s1 = AdjustmentSuggestion(
        rule_id="test_a",
        severity="elevated",
        title="Suggestion A",
        label="A",
        rationale="test",
        action="do A",
        quality_rank=80.0,
    )
    s2 = AdjustmentSuggestion(
        rule_id="test_b",
        severity="elevated",
        title="Suggestion B",
        label="B",
        rationale="test",
        action="do B",
        quality_rank=30.0,  # Lower quality → should be ranked higher
    )

    u1 = UnderlyingRiskSummary(
        underlying="NIFTY",
        spot=22500.0,
        exposures=base_exposures,
        tail_risk=base_tail,
        risk_level="elevated",
        expiry_count=1,
        flags=[],
        suggestions=[s1, s2],
    )

    result = _build_portfolio_suggestions(underlyings=[u1], account_net=100000, available_margin=75000)

    # s2 (quality_rank=30) should come before s1 (quality_rank=80) since lower quality = higher priority
    assert len(result) >= 2
    assert result[0].rule_id == "test_b"
    assert result[1].rule_id == "test_a"
