"""Strategy analyzer — computes margin, breakeven, PoP, payoff curves.

Uses td_core (Rust/PyO3) for payoff curve generation and breakeven finding.
Falls back to SVI-fitted IV + BSM pricing for legs with missing premiums.
"""

import math

import structlog
import td_core

from shared.instruments import pricing_model, unit_multiplier
from shared.redis_client import cache_get
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.strategy import MarginInfo, StrategyLeg, StrategyResult

from quant_service.indicators.registry import TIER_ALWAYS, IndicatorBase, register

log = structlog.get_logger()


def _svi_fair_premium(
    svi_params: dict,
    strike: float,
    underlying_price: float,
    t: float,
    r: float,
    is_call: bool,
    underlying: str | None = None,
) -> float | None:
    """Compute a fair premium from SVI-fitted IV + BSM (or Black-76 for MCX) pricing."""
    if underlying_price <= 0 or strike <= 0 or t <= 0:
        return None
    k = math.log(strike / underlying_price)
    iv = td_core.svi_iv(svi_params, k, t)
    if iv <= 0:
        return None
    if pricing_model(underlying) == "black76":
        return td_core.black76_price(underlying_price, strike, t, r, iv, is_call)
    return td_core.bs_price(underlying_price, strike, t, r, iv, is_call)


async def _get_svi_params(underlying: str, expiry: str) -> dict | None:
    """Try to load cached SVI params from Redis."""
    try:
        import json
        from quant_service.config import QuantSettings
        settings = QuantSettings()
        raw = await cache_get(settings.redis_url, f"cache:svi:{underlying}:{expiry}")
        if raw:
            data = json.loads(raw)
            return {"a": data["a"], "b": data["b"], "rho": data["rho"], "m": data["m"], "sigma": data["sigma"]}
    except Exception:
        log.debug("strategy.svi_cache_miss", underlying=underlying, expiry=expiry)
    return None


def _analyze(
    legs: list[StrategyLeg],
    underlying_price: float,
    days_to_expiry: int,
) -> tuple[list[float], list[float], list[float]]:
    """Use td_core for payoff curve + breakevens."""
    rust_legs = []
    for leg in legs:
        is_call = leg.option_type == "C"
        signed_qty = leg.quantity if leg.side == "BUY" else -leg.quantity
        rust_legs.append((leg.strike, leg.premium, signed_qty, is_call))

    spot_min = underlying_price * 0.8
    spot_max = underlying_price * 1.2

    payoff_x, payoff_y = td_core.strategy_payoff(rust_legs, spot_min, spot_max, 500)
    breakevens = td_core.find_breakevens(payoff_x, payoff_y)
    return payoff_x, payoff_y, breakevens


@register([EventType.ORDER_COMMAND], tier=TIER_ALWAYS)
class StrategyAnalyzer(IndicatorBase):
    """Analyze a multi-leg options strategy for margin, breakeven, and PoP."""

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        payload = event.payload

        raw_legs: list[dict] = payload.get("legs", [])
        underlying_price: float | None = payload.get("underlying_price")
        days_to_expiry: int = payload.get("days_to_expiry", 30)
        basket_id: str = payload.get("basket_id", "unknown")
        underlying: str = payload.get("underlying", "")
        expiry: str = payload.get("expiry", "")
        risk_free_rate: float = payload.get("interest_rate", 0.065)

        if not raw_legs or underlying_price is None:
            log.debug("strategy.skip", reason="missing_legs_or_price", basket_id=basket_id)
            return []

        legs = [StrategyLeg(**leg) for leg in raw_legs]

        # Fill missing premiums from SVI if available
        svi_params = None
        legs_patched = 0
        if underlying and expiry:
            svi_params = await _get_svi_params(underlying, expiry)

        if svi_params is not None:
            t = max(days_to_expiry / 365.25, 1e-6)
            for leg in legs:
                if leg.premium <= 0:
                    is_call = leg.option_type == "C"
                    fair = _svi_fair_premium(
                        svi_params, leg.strike, underlying_price, t, risk_free_rate, is_call,
                        underlying=underlying,
                    )
                    if fair is not None and fair > 0:
                        leg.premium = round(fair, 2)
                        legs_patched += 1

        if legs_patched > 0:
            log.info("strategy.svi_patched", basket_id=basket_id, patched=legs_patched)

        try:
            payoff_x, payoff_y, breakeven_points = _analyze(
                legs, underlying_price, days_to_expiry,
            )
            # Rupee values: ₹ per unit qty per ₹1 price (GOLD 100, GOLDM 0.1, else 1)
            value_mult = unit_multiplier(underlying)
            if value_mult != 1.0:
                payoff_y = [y * value_mult for y in payoff_y]
            # PoP estimate: fraction of payoff > 0
            probability_of_profit = (
                sum(1 for y in payoff_y if y > 0) / len(payoff_y)
                if payoff_y
                else 0.0
            )

            net_credit = value_mult * sum(
                leg.premium * leg.quantity * (1 if leg.side == "SELL" else -1)
                for leg in legs
            )

            max_profit = max(payoff_y) if payoff_y else None
            max_loss = min(payoff_y) if payoff_y else None

            # Estimate margin (simplified)
            total_premium_sold = value_mult * sum(
                leg.premium * leg.quantity for leg in legs if leg.side == "SELL"
            )
            initial_margin = max(abs(max_loss), 0.0) if max_loss is not None else total_premium_sold
            maintenance_margin = initial_margin * 0.75
            collateral_util = (
                min(initial_margin / (underlying_price * 100), 1.0)
                if underlying_price > 0
                else 0.0
            )

        except Exception:
            log.exception("strategy.analysis_failed", basket_id=basket_id)
            return []

        strategy_result = StrategyResult(
            legs=legs,
            net_credit=net_credit,
            max_profit=max_profit,
            max_loss=max_loss,
            breakeven_points=breakeven_points,
            probability_of_profit=probability_of_profit,
            margin=MarginInfo(
                initial_margin=initial_margin,
                maintenance_margin=maintenance_margin,
                collateral_utilization=collateral_util,
            ),
            payoff_x=payoff_x,
            payoff_y=payoff_y,
        )

        result_event = RedisEvent(
            event_type=EventType.STRATEGY_RESULT,
            source_service="quant_service",
            payload=strategy_result.model_dump(mode="json"),
        )

        log.info(
            "strategy.analyzed",
            basket_id=basket_id,
            pop=round(probability_of_profit, 4),
            breakevens=breakeven_points,
        )

        return [result_event]
