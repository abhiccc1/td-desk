"""Model pricers — split fast IV pricing from slow density/PoP analytics."""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import time

import numpy as np
import orjson
import structlog
import td_core

from shared.instruments import pricing_model, time_to_expiry_years
from shared.redis_client import cache_get, cache_set
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.greeks import ModelPricesResult, ModelStrikeResult

from quant_service.config import QuantSettings
from quant_service.indicators.registry import TIER_MODELS, IndicatorBase, register

log = structlog.get_logger()

_RISK_FREE_RATE: float = 0.065
_settings: QuantSettings | None = None

_FAST_COOLDOWN_S = 0.25
_SLOW_COOLDOWN_S = 1.0
_SPOT_MOVE_THRESHOLD = 0.0005
_DENSITY_GRID_POINTS = 500
_DENSITY_POINTS = 50

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


@dataclass
class _SnapshotContext:
    underlying: str
    expiry: str
    underlying_price: float
    now: datetime
    t: float
    r: float
    strikes: list[float]
    queue_age_ms: int | None
    snapshot_age_ms: int | None


@dataclass
class _PricingState:
    last_fast_run: float = 0.0
    last_slow_run: float = 0.0
    last_spot: float | None = None
    last_strike_hash: str = ""
    last_heston_params_hash: str = ""
    last_vg_params_hash: str = ""
    invoked: int = 0
    fast_skipped: int = 0
    slow_skipped: int = 0
    forced_rerun: int = 0


_pricing_state: dict[tuple[str, str], _PricingState] = {}


def _get_settings() -> QuantSettings:
    global _settings
    if _settings is None:
        _settings = QuantSettings()
    return _settings


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _age_ms(value: object, now: datetime) -> int | None:
    dt = _parse_timestamp(value)
    if dt is None:
        return None
    return max(0, int((now - dt).total_seconds() * 1000))


def _fingerprint(value: object) -> str:
    payload = orjson.dumps(value, option=orjson.OPT_SORT_KEYS)
    return hashlib.sha1(payload).hexdigest()


def _build_context(payload: dict) -> _SnapshotContext | None:
    strikes_data: list[dict] = payload.get("strikes", [])
    underlying: str = payload.get("underlying", "")
    underlying_price: float | None = (
        payload.get("underlyingPrice") or payload.get("underlying_price")
    )
    expiry: str | None = payload.get("expiry")

    if not strikes_data or underlying_price is None or expiry is None:
        return None

    if pricing_model(underlying) == "black76":
        # Heston/VG/FFT here model spot with drift r; applying them to a
        # futures price would silently mis-price. Not supported for MCX yet.
        log.debug("model_pricer.skip_unsupported_model", underlying=underlying, model="black76")
        return None

    now = datetime.now(timezone.utc)
    t = time_to_expiry_years(underlying, expiry, now)

    strike_set: set[float] = set()
    for entry in strikes_data:
        strike = entry.get("strike", 0.0)
        if strike > 0:
            strike_set.add(strike)

    if len(strike_set) < 3:
        return None

    return _SnapshotContext(
        underlying=underlying,
        expiry=expiry,
        underlying_price=underlying_price,
        now=now,
        t=t,
        r=_RISK_FREE_RATE,
        strikes=sorted(strike_set),
        queue_age_ms=_age_ms(payload.get("timestamp"), now),
        snapshot_age_ms=_age_ms(payload.get("sourceTimestamp"), now),
    )


async def _load_calibrated_params(
    redis_url: str,
    underlying: str,
    expiry: str,
) -> tuple[dict[str, float], bool, float | None, dict[str, float], bool, float | None]:
    heston_params = dict(_DEFAULT_HESTON)
    heston_calibrated = False
    heston_rmse: float | None = None

    vg_params = dict(_DEFAULT_VG)
    vg_calibrated = False
    vg_rmse: float | None = None

    heston_raw = await cache_get(
        redis_url, f"cache:calibrated-heston:{underlying}:{expiry}",
    )
    if heston_raw:
        cal = orjson.loads(heston_raw)
        heston_params = cal["params"]
        heston_calibrated = True
        heston_rmse = cal.get("rmse")

    vg_raw = await cache_get(
        redis_url, f"cache:calibrated-vg:{underlying}:{expiry}",
    )
    if vg_raw:
        cal = orjson.loads(vg_raw)
        vg_params = cal["params"]
        vg_calibrated = True
        vg_rmse = cal.get("rmse")

    return (
        heston_params,
        heston_calibrated,
        heston_rmse,
        vg_params,
        vg_calibrated,
        vg_rmse,
    )


async def _load_cached_model_prices(
    redis_url: str,
    underlying: str,
    expiry: str,
) -> ModelPricesResult | None:
    raw = await cache_get(redis_url, f"cache:model-prices:{underlying}:{expiry}")
    if not raw:
        return None
    try:
        return ModelPricesResult.model_validate_json(raw)
    except Exception:
        return None


def _cached_model_prices_match(
    cached: ModelPricesResult,
    ctx: _SnapshotContext,
    heston_params: dict[str, float],
    vg_params: dict[str, float],
) -> bool:
    if cached.underlying != ctx.underlying or cached.expiry != ctx.expiry:
        return False
    if cached.spot != ctx.underlying_price:
        return False
    if cached.heston_params != heston_params or cached.vg_params != vg_params:
        return False
    return [strike.strike for strike in cached.strikes] == ctx.strikes


def _should_run(
    state: _PricingState,
    now_mono: float,
    last_run: float,
    cooldown_s: float,
    spot: float,
    strike_hash: str,
    heston_hash: str,
    vg_hash: str,
    *,
    count_forced: bool,
) -> tuple[bool, str | None]:
    forced_reasons: list[str] = []

    if state.last_spot is None:
        forced_reasons.append("cold_start")
    else:
        spot_move = abs(spot - state.last_spot) / max(abs(state.last_spot), 1.0)
        if spot_move >= _SPOT_MOVE_THRESHOLD:
            forced_reasons.append("spot_move")

    if strike_hash != state.last_strike_hash:
        forced_reasons.append("strikes")
    if heston_hash != state.last_heston_params_hash:
        forced_reasons.append("heston_params")
    if vg_hash != state.last_vg_params_hash:
        forced_reasons.append("vg_params")

    if forced_reasons:
        if count_forced:
            state.forced_rerun += 1
        return True, ",".join(forced_reasons)

    if now_mono - last_run >= cooldown_s:
        return True, None

    return False, None


def _mark_run(
    state: _PricingState,
    *,
    run_kind: str,
    now_mono: float,
    spot: float,
    strike_hash: str,
    heston_hash: str,
    vg_hash: str,
) -> None:
    if run_kind == "fast":
        state.last_fast_run = now_mono
    else:
        state.last_slow_run = now_mono
    state.last_spot = spot
    state.last_strike_hash = strike_hash
    state.last_heston_params_hash = heston_hash
    state.last_vg_params_hash = vg_hash


def _build_fast_result(
    ctx: _SnapshotContext,
    *,
    heston_params: dict[str, float],
    heston_calibrated: bool,
    heston_rmse: float | None,
    vg_params: dict[str, float],
    vg_calibrated: bool,
    vg_rmse: float | None,
    heston_calls: list[float],
    heston_put_prices: list[float],
    heston_ivs: list[float | None],
    vg_calls: list[float],
    vg_put_prices: list[float],
    vg_ivs: list[float | None],
) -> ModelPricesResult:
    strike_results = [
        ModelStrikeResult(
            strike=strike,
            heston_iv=heston_ivs[idx] if heston_ivs[idx] is not None else None,
            vg_iv=vg_ivs[idx] if vg_ivs[idx] is not None else None,
            heston_call_price=heston_calls[idx],
            heston_put_price=heston_put_prices[idx],
            vg_call_price=vg_calls[idx],
            vg_put_price=vg_put_prices[idx],
            heston_pop=None,
            vg_pop=None,
        )
        for idx, strike in enumerate(ctx.strikes)
    ]

    return ModelPricesResult(
        underlying=ctx.underlying,
        expiry=ctx.expiry,
        spot=ctx.underlying_price,
        heston_params=heston_params,
        vg_params=vg_params,
        heston_calibrated=heston_calibrated,
        vg_calibrated=vg_calibrated,
        heston_rmse=heston_rmse,
        vg_rmse=vg_rmse,
        strikes=strike_results,
        heston_density=None,
        vg_density=None,
        timestamp=datetime.now(timezone.utc),
    )


def _interpolate_cdf(spot_grid: list[float], cdf: list[float], spot: float) -> float:
    if not spot_grid or not cdf:
        return 0.0
    idx = bisect_left(spot_grid, spot)
    if idx <= 0:
        return cdf[0]
    if idx >= len(spot_grid):
        return cdf[-1]
    x0 = spot_grid[idx - 1]
    x1 = spot_grid[idx]
    y0 = cdf[idx - 1]
    y1 = cdf[idx]
    if x1 <= x0:
        return y1
    frac = (spot - x0) / (x1 - x0)
    return y0 + frac * (y1 - y0)


def _downsample_density(
    spot_grid: list[float],
    density: list[float] | None,
) -> list[list[float]] | None:
    if density is None:
        return None
    step = max(1, len(spot_grid) // _DENSITY_POINTS)
    return [
        [spot_grid[idx], density[idx]]
        for idx in range(0, len(spot_grid), step)
    ]


def _build_slow_result(
    ctx: _SnapshotContext,
    *,
    base_result: ModelPricesResult,
    heston_params: dict[str, float],
    heston_calibrated: bool,
    heston_rmse: float | None,
    vg_params: dict[str, float],
    vg_calibrated: bool,
    vg_rmse: float | None,
    spot_grid: list[float],
    heston_density_raw: list[float] | None,
    heston_cdf: list[float] | None,
    vg_density_raw: list[float] | None,
    vg_cdf: list[float] | None,
) -> ModelPricesResult:
    strike_results: list[ModelStrikeResult] = []
    for idx, strike_result in enumerate(base_result.strikes):
        heston_pop: float | None = None
        heston_call_price = strike_result.heston_call_price or 0.0
        if heston_cdf is not None and heston_call_price > 0:
            threshold = strike_result.strike + heston_call_price
            heston_pop = max(0.0, 1.0 - _interpolate_cdf(spot_grid, heston_cdf, threshold))

        vg_pop: float | None = None
        vg_call_price = strike_result.vg_call_price or 0.0
        if vg_cdf is not None and vg_call_price > 0:
            threshold = strike_result.strike + vg_call_price
            vg_pop = max(0.0, 1.0 - _interpolate_cdf(spot_grid, vg_cdf, threshold))

        strike_results.append(ModelStrikeResult(
            strike=strike_result.strike,
            heston_iv=strike_result.heston_iv,
            vg_iv=strike_result.vg_iv,
            heston_call_price=strike_result.heston_call_price,
            heston_put_price=strike_result.heston_put_price,
            vg_call_price=strike_result.vg_call_price,
            vg_put_price=strike_result.vg_put_price,
            heston_pop=heston_pop,
            vg_pop=vg_pop,
        ))

    return ModelPricesResult(
        underlying=ctx.underlying,
        expiry=ctx.expiry,
        spot=ctx.underlying_price,
        heston_params=heston_params,
        vg_params=vg_params,
        heston_calibrated=heston_calibrated,
        vg_calibrated=vg_calibrated,
        heston_rmse=heston_rmse,
        vg_rmse=vg_rmse,
        strikes=strike_results,
        heston_density=_downsample_density(spot_grid, heston_density_raw),
        vg_density=_downsample_density(spot_grid, vg_density_raw),
        timestamp=datetime.now(timezone.utc),
    )


@register([EventType.CHAIN_SNAPSHOT], tier=TIER_MODELS)
class FastModelPricer(IndicatorBase):
    """Price the option chain under Heston and VG models via FFT."""

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        ctx = _build_context(event.payload)
        if ctx is None:
            return []

        key = (ctx.underlying, ctx.expiry)
        state = _pricing_state.setdefault(key, _PricingState())
        state.invoked += 1
        start = time.perf_counter()

        param_start = time.perf_counter()
        redis_url = _get_settings().redis_url
        (
            heston_params,
            heston_calibrated,
            heston_rmse,
            vg_params,
            vg_calibrated,
            vg_rmse,
        ) = await _load_calibrated_params(redis_url, ctx.underlying, ctx.expiry)
        param_load_ms = round((time.perf_counter() - param_start) * 1000, 2)

        strike_hash = _fingerprint(ctx.strikes)
        heston_hash = _fingerprint(heston_params)
        vg_hash = _fingerprint(vg_params)

        now_mono = time.monotonic()
        should_run, forced_reason = _should_run(
            state,
            now_mono,
            state.last_fast_run,
            _FAST_COOLDOWN_S,
            ctx.underlying_price,
            strike_hash,
            heston_hash,
            vg_hash,
            count_forced=True,
        )
        if not should_run:
            state.fast_skipped += 1
            log.debug(
                "model_pricer.fast_skipped",
                underlying=ctx.underlying,
                expiry=ctx.expiry,
                queue_age_ms=ctx.queue_age_ms,
                snapshot_age_ms=ctx.snapshot_age_ms,
                invoked=state.invoked,
                fast_skipped=state.fast_skipped,
                slow_skipped=state.slow_skipped,
            )
            return []

        chain_start = time.perf_counter()
        (
            (heston_calls, heston_put_prices, heston_ivs, _heston_density, _heston_cdf),
            (vg_calls, vg_put_prices, vg_ivs, _vg_density, _vg_cdf),
        ) = td_core.compute_model_snapshot(
            "fast",
            heston_params,
            vg_params,
            ctx.underlying_price,
            ctx.r,
            ctx.t,
            ctx.strikes,
        )
        chain_fused_ms = round((time.perf_counter() - chain_start) * 1000, 2)

        result = _build_fast_result(
            ctx,
            heston_params=heston_params,
            heston_calibrated=heston_calibrated,
            heston_rmse=heston_rmse,
            vg_params=vg_params,
            vg_calibrated=vg_calibrated,
            vg_rmse=vg_rmse,
            heston_calls=heston_calls,
            heston_put_prices=heston_put_prices,
            heston_ivs=heston_ivs,
            vg_calls=vg_calls,
            vg_put_prices=vg_put_prices,
            vg_ivs=vg_ivs,
        )

        publish_start = time.perf_counter()
        payload = result.model_dump(mode="json", by_alias=True)
        await cache_set(
            redis_url,
            f"cache:model-prices:{ctx.underlying}:{ctx.expiry}",
            result.model_dump_json(by_alias=True),
            ttl=300,
        )
        publish_ms = round((time.perf_counter() - publish_start) * 1000, 2)

        _mark_run(
            state,
            run_kind="fast",
            now_mono=now_mono,
            spot=ctx.underlying_price,
            strike_hash=strike_hash,
            heston_hash=heston_hash,
            vg_hash=vg_hash,
        )

        total_ms = round((time.perf_counter() - start) * 1000, 2)
        log.info(
            "model_pricer.fast_computed",
            underlying=ctx.underlying,
            expiry=ctx.expiry,
            strikes=len(ctx.strikes),
            queue_age_ms=ctx.queue_age_ms,
            snapshot_age_ms=ctx.snapshot_age_ms,
            param_load_ms=param_load_ms,
            heston_chain_ms=None,
            vg_chain_ms=None,
            chain_fused_ms=chain_fused_ms,
            heston_density_ms=None,
            vg_density_ms=None,
            pop_ms=0.0,
            publish_ms=publish_ms,
            total_ms=total_ms,
            invoked=state.invoked,
            fast_skipped=state.fast_skipped,
            slow_skipped=state.slow_skipped,
            forced_rerun=state.forced_rerun,
            forced_reason=forced_reason,
        )

        return [RedisEvent(
            event_type=EventType.MODEL_PRICES_COMPUTED,
            source_service="quant_service",
            payload=payload,
        )]


@register([EventType.CHAIN_SNAPSHOT], tier=TIER_MODELS)
class SlowModelPricer(IndicatorBase):
    """Compute slower density and PoP analytics for the option chain."""

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        ctx = _build_context(event.payload)
        if ctx is None:
            return []

        key = (ctx.underlying, ctx.expiry)
        state = _pricing_state.setdefault(key, _PricingState())
        start = time.perf_counter()

        param_start = time.perf_counter()
        redis_url = _get_settings().redis_url
        (
            heston_params,
            heston_calibrated,
            heston_rmse,
            vg_params,
            vg_calibrated,
            vg_rmse,
        ) = await _load_calibrated_params(redis_url, ctx.underlying, ctx.expiry)
        param_load_ms = round((time.perf_counter() - param_start) * 1000, 2)

        strike_hash = _fingerprint(ctx.strikes)
        heston_hash = _fingerprint(heston_params)
        vg_hash = _fingerprint(vg_params)

        now_mono = time.monotonic()
        should_run, forced_reason = _should_run(
            state,
            now_mono,
            state.last_slow_run,
            _SLOW_COOLDOWN_S,
            ctx.underlying_price,
            strike_hash,
            heston_hash,
            vg_hash,
            count_forced=False,
        )
        if not should_run:
            state.slow_skipped += 1
            log.debug(
                "model_pricer.slow_skipped",
                underlying=ctx.underlying,
                expiry=ctx.expiry,
                queue_age_ms=ctx.queue_age_ms,
                snapshot_age_ms=ctx.snapshot_age_ms,
                invoked=state.invoked,
                fast_skipped=state.fast_skipped,
                slow_skipped=state.slow_skipped,
            )
            return []

        cached_fast = await _load_cached_model_prices(
            redis_url, ctx.underlying, ctx.expiry,
        )
        cache_hit = (
            cached_fast is not None
            and _cached_model_prices_match(cached_fast, ctx, heston_params, vg_params)
        )

        if cache_hit:
            base_result = cached_fast
            chain_fused_ms = None
            heston_chain_ms = 0.0
            vg_chain_ms = 0.0
            snapshot_mode = "slow"
        else:
            base_result = None
            chain_fused_ms = None
            heston_chain_ms = None
            vg_chain_ms = None
            snapshot_mode = "full"

        spot_grid = np.linspace(
            ctx.underlying_price * 0.7,
            ctx.underlying_price * 1.3,
            _DENSITY_GRID_POINTS,
        ).tolist()

        heston_density_raw: list[float] | None = None
        heston_cdf: list[float] | None = None
        vg_density_raw: list[float] | None = None
        vg_cdf: list[float] | None = None

        try:
            density_start = time.perf_counter()
            (
                (full_heston_calls, full_heston_puts, full_heston_ivs, heston_density_raw, heston_cdf),
                (full_vg_calls, full_vg_puts, full_vg_ivs, vg_density_raw, vg_cdf),
            ) = td_core.compute_model_snapshot(
                snapshot_mode,
                heston_params,
                vg_params,
                ctx.underlying_price,
                ctx.r,
                ctx.t,
                ctx.strikes,
                spot_grid,
            )
            density_total_ms = round((time.perf_counter() - density_start) * 1000, 2)
        except Exception:
            density_total_ms = 0.0
            log.warning("model_pricer.snapshot_compute_failed", underlying=ctx.underlying)
            full_heston_calls = None
            full_heston_puts = None
            full_heston_ivs = None
            full_vg_calls = None
            full_vg_puts = None
            full_vg_ivs = None

        heston_density_ms = density_total_ms
        vg_density_ms = density_total_ms

        if not cache_hit and full_heston_calls is not None and full_vg_calls is not None:
            base_result = _build_fast_result(
                ctx,
                heston_params=heston_params,
                heston_calibrated=heston_calibrated,
                heston_rmse=heston_rmse,
                vg_params=vg_params,
                vg_calibrated=vg_calibrated,
                vg_rmse=vg_rmse,
                heston_calls=full_heston_calls,
                heston_put_prices=full_heston_puts or [],
                heston_ivs=full_heston_ivs or [],
                vg_calls=full_vg_calls,
                vg_put_prices=full_vg_puts or [],
                vg_ivs=full_vg_ivs or [],
            )
        if base_result is None:
            log.warning(
                "model_pricer.slow_base_result_missing",
                underlying=ctx.underlying,
                expiry=ctx.expiry,
                cache_hit=cache_hit,
            )
            return []

        pop_start = time.perf_counter()
        result = _build_slow_result(
            ctx,
            base_result=base_result,
            heston_params=heston_params,
            heston_calibrated=heston_calibrated,
            heston_rmse=heston_rmse,
            vg_params=vg_params,
            vg_calibrated=vg_calibrated,
            vg_rmse=vg_rmse,
            spot_grid=spot_grid,
            heston_density_raw=heston_density_raw,
            heston_cdf=heston_cdf,
            vg_density_raw=vg_density_raw,
            vg_cdf=vg_cdf,
        )
        pop_ms = round((time.perf_counter() - pop_start) * 1000, 2)

        publish_start = time.perf_counter()
        payload = result.model_dump(mode="json", by_alias=True)
        await cache_set(
            redis_url,
            f"cache:model-prices:{ctx.underlying}:{ctx.expiry}",
            result.model_dump_json(by_alias=True),
            ttl=300,
        )
        publish_ms = round((time.perf_counter() - publish_start) * 1000, 2)

        _mark_run(
            state,
            run_kind="slow",
            now_mono=now_mono,
            spot=ctx.underlying_price,
            strike_hash=strike_hash,
            heston_hash=heston_hash,
            vg_hash=vg_hash,
        )

        total_ms = round((time.perf_counter() - start) * 1000, 2)
        log.info(
            "model_pricer.slow_computed",
            underlying=ctx.underlying,
            expiry=ctx.expiry,
            strikes=len(ctx.strikes),
            queue_age_ms=ctx.queue_age_ms,
            snapshot_age_ms=ctx.snapshot_age_ms,
            param_load_ms=param_load_ms,
            heston_chain_ms=heston_chain_ms,
            vg_chain_ms=vg_chain_ms,
            chain_fused_ms=chain_fused_ms,
            heston_density_ms=heston_density_ms,
            vg_density_ms=vg_density_ms,
            pop_ms=pop_ms,
            publish_ms=publish_ms,
            total_ms=total_ms,
            invoked=state.invoked,
            fast_skipped=state.fast_skipped,
            slow_skipped=state.slow_skipped,
            forced_rerun=state.forced_rerun,
            forced_reason=forced_reason,
            cache_hit=cache_hit,
        )

        return [RedisEvent(
            event_type=EventType.MODEL_PRICES_SLOW_COMPUTED,
            source_service="quant_service",
            payload=payload,
        )]
