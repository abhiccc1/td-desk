"""Model calibrator — fits Heston and VG parameters to the SVI IV surface."""

import asyncio
import orjson
import time
from datetime import datetime, timezone
from functools import partial

import structlog

import td_core

from shared.instruments import pricing_model, time_to_expiry_years
from shared.redis_client import cache_get, cache_set
from shared.schemas.events import EventType, RedisEvent

from quant_service.config import QuantSettings
from quant_service.indicators.registry import TIER_MODELS, IndicatorBase, register

log = structlog.get_logger()

_RISK_FREE_RATE: float = 0.065
_settings: QuantSettings | None = None

# Calibration cooldown per (underlying, expiry) key
_CALIBRATION_COOLDOWN_S = 30.0

# Number of log-moneyness points sampled from SVI for the target curve
_NUM_TARGET_POINTS = 25

# Log-moneyness range around ATM to calibrate over (±15 %)
_K_RANGE = 0.15

def _get_settings() -> QuantSettings:
    global _settings
    if _settings is None:
        _settings = QuantSettings()
    return _settings


# ── Indicator ─────────────────────────────────────────────────────────


@register([EventType.CHAIN_SNAPSHOT], tier=TIER_MODELS)
class ModelCalibrator(IndicatorBase):
    """Calibrate Heston and VG model parameters against the SVI IV surface.

        Reads the previously-cached SVI fit from Redis and delegates the
        full calibration loop to td_core so the event loop is not blocked.
        Calibrated params are written back to Redis for ModelPricer to
        pick up on the next snapshot.
    """

    def __init__(self) -> None:
        self._last_run: dict[tuple[str, str], float] = {}

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        payload = event.payload
        underlying: str = payload.get("underlying", "")
        underlying_price: float | None = (
            payload.get("underlyingPrice") or payload.get("underlying_price")
        )
        expiry: str | None = payload.get("expiry")

        if not underlying or underlying_price is None or expiry is None:
            return []

        if pricing_model(underlying) == "black76":
            # Heston/VG calibration assumes spot dynamics — not valid for
            # options on futures (MCX) yet.
            log.debug("calibrator.skip_unsupported_model", underlying=underlying)
            return []

        # ── Cooldown ──────────────────────────────────────────────
        key = (underlying, expiry)
        now_mono = time.monotonic()
        if now_mono - self._last_run.get(key, 0.0) < _CALIBRATION_COOLDOWN_S:
            return []

        # ── Read cached SVI ───────────────────────────────────────
        redis_url = _get_settings().redis_url
        svi_raw = await cache_get(redis_url, f"cache:svi:{underlying}:{expiry}")
        if not svi_raw:
            return []

        svi_data = orjson.loads(svi_raw)
        svi_params = {
            "a": svi_data["a"],
            "b": svi_data["b"],
            "rho": svi_data["rho"],
            "m": svi_data["m"],
            "sigma": svi_data["sigma"],
        }

        # ── Compute time-to-expiry ────────────────────────────────
        now_utc = datetime.now(timezone.utc)
        t = time_to_expiry_years(underlying, expiry, now_utc)
        r = _RISK_FREE_RATE

        # ── Run the full calibration pipeline in Rust ─────────────
        loop = asyncio.get_running_loop()
        heston_raw, vg_raw = await loop.run_in_executor(
            None,
            partial(
                td_core.calibrate_both,
                svi_params,
                underlying_price,
                r,
                t,
                _NUM_TARGET_POINTS,
                _K_RANGE,
            ),
        )

        # Mark cooldown regardless of success (avoid tight retry loops)
        self._last_run[key] = now_mono

        heston_result = None
        if heston_raw:
            params, rmse = heston_raw
            heston_result = {
                "params": params,
                "rmse": round(float(rmse), 6),
            }

        vg_result = None
        if vg_raw:
            params, rmse = vg_raw
            vg_result = {
                "params": params,
                "rmse": round(float(rmse), 6),
            }

        # ── Cache results ─────────────────────────────────────────
        if heston_result:
            await cache_set(
                redis_url,
                f"cache:calibrated-heston:{underlying}:{expiry}",
                orjson.dumps(heston_result).decode(),
                ttl=300,
            )
            log.info(
                "calibrator.heston_ok",
                underlying=underlying,
                expiry=expiry,
                rmse=heston_result["rmse"],
                params=heston_result["params"],
            )
        else:
            log.warning("calibrator.heston_failed", underlying=underlying, expiry=expiry)

        if vg_result:
            await cache_set(
                redis_url,
                f"cache:calibrated-vg:{underlying}:{expiry}",
                orjson.dumps(vg_result).decode(),
                ttl=300,
            )
            log.info(
                "calibrator.vg_ok",
                underlying=underlying,
                expiry=expiry,
                rmse=vg_result["rmse"],
                params=vg_result["params"],
            )
        else:
            log.warning("calibrator.vg_failed", underlying=underlying, expiry=expiry)

        # Emit a calibration event for observability
        result_events: list[RedisEvent] = []
        if heston_result or vg_result:
            result_events.append(RedisEvent(
                event_type=EventType.CALIBRATION_COMPLETED,
                source_service="quant_service",
                payload={
                    "underlying": underlying,
                    "expiry": expiry,
                    "heston": heston_result,
                    "vg": vg_result,
                },
            ))

        return result_events
