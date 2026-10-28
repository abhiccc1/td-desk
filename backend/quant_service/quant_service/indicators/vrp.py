"""Volatility Risk Premium (VRP) indicator.

VRP = ATM Implied Volatility - Realized Volatility (close-to-close).

Subscribes to CHAIN_SNAPSHOT events, reads the cached SVI fit to get ATM IV,
queries TimescaleDB for historical spot prices to compute realized vol,
and publishes a VRP_COMPUTED event.

Throttled to once per 60 seconds per underlying via monotonic cooldown.
"""

import math
import time
from datetime import datetime, timezone

import orjson
import structlog

import td_core

from shared.db import get_engine
from shared.instruments import time_to_expiry_years
from shared.redis_client import cache_get, cache_set
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.greeks import VrpResult

from quant_service.config import QuantSettings
from quant_service.indicators.registry import TIER_GREEKS, IndicatorBase, register

log = structlog.get_logger()

_VRP_COOLDOWN_S = 60.0
_RV_WINDOW_DAYS = 10
_IV_RANK_LOOKBACK_DAYS = 252

_settings: QuantSettings | None = None


def _get_settings() -> QuantSettings:
    global _settings
    if _settings is None:
        _settings = QuantSettings()
    return _settings


@register([EventType.CHAIN_SNAPSHOT], tier=TIER_GREEKS)
class VrpCalculator(IndicatorBase):
    """Compute Volatility Risk Premium for an underlying.

    Reads ATM IV from the cached SVI surface and realized vol from
    TimescaleDB spot price history.  Results are cached to Redis and
    published as VRP_COMPUTED events.
    """

    def __init__(self) -> None:
        self._last_run: dict[str, float] = {}

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        payload = event.payload
        underlying: str = payload.get("underlying", "")
        expiry: str | None = payload.get("expiry")

        if not underlying or expiry is None:
            return []

        # ── Cooldown (per underlying, not per expiry) ─────────────
        now_mono = time.monotonic()
        if now_mono - self._last_run.get(underlying, 0.0) < _VRP_COOLDOWN_S:
            return []

        settings = _get_settings()

        # ── Read cached SVI to extract ATM IV ─────────────────────
        svi_raw = await cache_get(settings.redis_url, f"cache:svi:{underlying}:{expiry}")
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

        # Compute time-to-expiry
        now_utc = datetime.now(timezone.utc)
        t = time_to_expiry_years(underlying, expiry, now_utc)

        # ATM IV from SVI at k=0 (log-moneyness = 0 → ATM)
        atm_iv = td_core.svi_iv(svi_params, 0.0, t)
        if not atm_iv or atm_iv <= 0:
            return []

        # Mark cooldown regardless of success to avoid tight retry loops
        self._last_run[underlying] = now_mono

        # ── Query TimescaleDB for spot price history ──────────────
        try:
            from sqlalchemy import text

            engine = get_engine(settings.timescaledb_url)
            async with engine.begin() as conn:
                result = await conn.execute(
                    text("""
                        SELECT DISTINCT ON (time_bucket('1 day', time))
                               spot_price, atm_iv
                        FROM iv_history
                        WHERE underlying = :underlying
                          AND time > now() - interval '400 days'
                          AND spot_price IS NOT NULL AND spot_price > 0
                        ORDER BY time_bucket('1 day', time), time DESC
                    """),
                    {"underlying": underlying},
                )
                rows = result.fetchall()
        except Exception:
            log.warning("vrp.db_query_failed", underlying=underlying, exc_info=True)
            return []

        if not rows or len(rows) < 2:
            log.debug("vrp.insufficient_history", underlying=underlying, rows=len(rows) if rows else 0)
            return []

        # ── Compute realized vol (close-to-close) ────────────────
        spots = [float(r[0]) for r in rows]

        # Log returns
        log_returns = [math.log(spots[i] / spots[i - 1]) for i in range(1, len(spots))]

        # Use last _RV_WINDOW_DAYS returns for RV
        tail = log_returns[-_RV_WINDOW_DAYS:]
        n = len(tail)
        if n < 3:
            log.debug("vrp.too_few_returns", underlying=underlying, n=n)
            return []

        mean = sum(tail) / n
        variance = sum((r - mean) ** 2 for r in tail) / (n - 1)
        realized_vol = math.sqrt(variance) * math.sqrt(252)  # annualized decimal

        # ── Compute IV Rank from historical ATM IVs ───────────────
        iv_rank: float | None = None
        historical_ivs = [float(r[1]) for r in rows]

        # Use up to last 252 daily values for rank
        iv_window = historical_ivs[-_IV_RANK_LOOKBACK_DAYS:]
        if len(iv_window) >= 10:
            current_iv_pct = atm_iv * 100  # SVI IV is decimal, iv_history stores %
            lower_count = sum(1 for v in iv_window[:-1] if v < current_iv_pct)
            iv_rank = round((lower_count / max(len(iv_window) - 1, 1)) * 100, 1)

        # ── VRP = ATM_IV - RV (both as decimals) ─────────────────
        vrp = atm_iv - realized_vol

        now = datetime.now(timezone.utc)
        vrp_result = VrpResult(
            underlying=underlying,
            atm_iv=round(atm_iv, 6),
            realized_vol=round(realized_vol, 6),
            vrp=round(vrp, 6),
            iv_rank=iv_rank,
            window_days=_RV_WINDOW_DAYS,
            timestamp=now,
        )

        # ── Cache to Redis ────────────────────────────────────────
        await cache_set(
            settings.redis_url,
            f"cache:vrp:{underlying}",
            vrp_result.model_dump_json(by_alias=True),
            ttl=120,
        )

        log.info(
            "vrp.computed",
            underlying=underlying,
            atm_iv=round(atm_iv * 100, 2),
            rv=round(realized_vol * 100, 2),
            vrp=round(vrp * 100, 2),
            iv_rank=iv_rank,
            window=_RV_WINDOW_DAYS,
        )

        # ── Emit VRP_COMPUTED event ───────────────────────────────
        return [
            RedisEvent(
                event_type=EventType.VRP_COMPUTED,
                source_service="quant_service",
                payload=vrp_result.model_dump(mode="json", by_alias=True),
            ),
        ]
