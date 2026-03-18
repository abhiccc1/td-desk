"""Model pricer — runs Heston and VG pricing on each chain snapshot.

Prices entire strike strips via the Carr-Madan FFT engine (td_core) and
computes BSM implied vols for each model.  Results are cached to Redis
and published as MODEL_PRICES_COMPUTED events for the frontend IV skew
chart and model comparison panel.

Calibration is deferred — uses sensible default parameters for NSE
NIFTY/BANKNIFTY weeklies.  When calibration is implemented, the params
will be loaded from a Redis cache or database instead.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import structlog
import td_core

from shared.redis_client import cache_set
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.greeks import ModelPricesResult, ModelStrikeResult

from quant_service.config import QuantSettings
from quant_service.indicators.registry import IndicatorBase, register

log = structlog.get_logger()

_RISK_FREE_RATE: float = 0.065
_IST = ZoneInfo("Asia/Kolkata")
_settings: QuantSettings | None = None

# ── Default model parameters (until calibration is implemented) ──────

_DEFAULT_HESTON = {
    "kappa": 1.8,
    "theta": 0.04,
    "sigma_v": 0.6,
    "rho": -0.55,
    "v0": 0.03,
}

_DEFAULT_VG = {
    "sigma": 0.12,
    "theta": -0.14,
    "nu": 0.2,
}


def _get_settings() -> QuantSettings:
    global _settings
    if _settings is None:
        _settings = QuantSettings()
    return _settings


@register([EventType.CHAIN_SNAPSHOT])
class ModelPricer(IndicatorBase):
    """Price the option chain under Heston and VG models via FFT.

    Runs concurrently with ChainGreeksCalculator on the same
    CHAIN_SNAPSHOT event.  Produces a single MODEL_PRICES_COMPUTED
    event containing per-strike IVs from both models.
    """

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        payload = event.payload
        strikes_data: list[dict] = payload.get("strikes", [])
        underlying: str = payload.get("underlying", "")
        underlying_price: float | None = (
            payload.get("underlyingPrice") or payload.get("underlying_price")
        )
        expiry: str | None = payload.get("expiry")

        if not strikes_data or underlying_price is None or expiry is None:
            return []

        now = datetime.now(timezone.utc)
        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d").replace(
            hour=15, minute=30, tzinfo=_IST,
        ).astimezone(timezone.utc)
        t = max((expiry_dt - now).total_seconds() / (365.25 * 86400), 1e-6)
        r = _RISK_FREE_RATE

        # Collect unique sorted strikes from chain
        strike_set: set[float] = set()
        for entry in strikes_data:
            s = entry.get("strike", 0.0)
            if s > 0:
                strike_set.add(s)

        if len(strike_set) < 3:
            return []

        strikes = sorted(strike_set)

        # ── Price under Heston ───────────────────────────────────────
        heston_params = _DEFAULT_HESTON
        heston_calls = td_core.heston_price(heston_params, underlying_price, r, t, strikes)
        heston_chain = td_core.heston_price_chain(heston_params, underlying_price, r, t, strikes)
        heston_ivs = td_core.heston_iv(heston_params, underlying_price, r, t, strikes)
        heston_put_prices = heston_chain[1]

        # ── Price under VG ───────────────────────────────────────────
        vg_params = _DEFAULT_VG
        vg_calls = td_core.vg_price(vg_params, underlying_price, r, t, strikes)
        vg_chain = td_core.vg_price_chain(vg_params, underlying_price, r, t, strikes)
        vg_ivs = td_core.vg_iv(vg_params, underlying_price, r, t, strikes)
        vg_put_prices = vg_chain[1]

        # ── Build per-strike results ─────────────────────────────────
        strike_results: list[ModelStrikeResult] = []
        for i, k in enumerate(strikes):
            strike_results.append(ModelStrikeResult(
                strike=k,
                heston_iv=heston_ivs[i] if heston_ivs[i] is not None else None,
                vg_iv=vg_ivs[i] if vg_ivs[i] is not None else None,
                heston_call_price=heston_calls[i],
                heston_put_price=heston_put_prices[i],
                vg_call_price=vg_calls[i],
                vg_put_price=vg_put_prices[i],
            ))

        result = ModelPricesResult(
            underlying=underlying,
            expiry=expiry,
            spot=underlying_price,
            heston_params=heston_params,
            vg_params=vg_params,
            strikes=strike_results,
            timestamp=now,
        )

        # ── Cache to Redis ───────────────────────────────────────────
        await cache_set(
            _get_settings().redis_url,
            f"cache:model-prices:{underlying}:{expiry}",
            result.model_dump_json(by_alias=True),
            ttl=300,
        )

        heston_count = sum(1 for s in strike_results if s.heston_iv is not None)
        vg_count = sum(1 for s in strike_results if s.vg_iv is not None)

        log.info(
            "model_pricer.computed",
            underlying=underlying,
            expiry=expiry,
            strikes=len(strikes),
            heston_ivs=heston_count,
            vg_ivs=vg_count,
        )

        return [RedisEvent(
            event_type=EventType.MODEL_PRICES_COMPUTED,
            source_service="quant_service",
            payload=result.model_dump(mode="json", by_alias=True),
        )]
