"""Greeks calculator — computes IV and option Greeks from chain snapshots.

Uses td_core (Rust/PyO3) for BSM computation via batch_compute_greeks_warm
(warm-started IV solver with rayon parallelism).
"""

from datetime import datetime, timezone

import math
import time

import structlog
import td_core

from shared.instruments import pricing_model, time_to_expiry_years
from shared.redis_client import cache_set, cache_hset
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.greeks import GreeksResult, SviParams

from quant_service.config import QuantSettings
from quant_service.indicators.registry import TIER_GREEKS, IndicatorBase, register

log = structlog.get_logger()

_RISK_FREE_RATE: float = 0.065
_settings: QuantSettings | None = None


def _get_settings() -> QuantSettings:
    global _settings
    if _settings is None:
        _settings = QuantSettings()
    return _settings


def set_risk_free_rate(rate: float) -> None:
    global _RISK_FREE_RATE
    _RISK_FREE_RATE = rate


# Previous SVI params per (underlying, expiry) for change detection
_prev_svi: dict[tuple[str, str], dict] = {}

# Thresholds for significant changes
_RHO_THRESHOLD = 0.05      # skew shift
_SIGMA_THRESHOLD = 0.03    # smile width change
_A_THRESHOLD = 0.02        # level shift


def _detect_svi_alerts(
    underlying: str,
    expiry: str,
    current: dict,
    is_arb_free: bool,
) -> list[dict]:
    """Compare current SVI params with previous, return alert dicts."""
    key = (underlying, expiry)
    prev = _prev_svi.get(key)
    _prev_svi[key] = dict(current)

    alerts: list[dict] = []

    if not is_arb_free:
        alerts.append({
            "level": "error",
            "title": "Arbitrage detected",
            "message": f"{underlying} {expiry}: SVI surface is not arbitrage-free",
        })

    if prev is None:
        return alerts

    rho_diff = abs(current["rho"] - prev["rho"])
    sigma_diff = abs(current["sigma"] - prev["sigma"])
    a_diff = abs(current["a"] - prev["a"])

    if rho_diff > _RHO_THRESHOLD:
        direction = "steepened" if current["rho"] < prev["rho"] else "flattened"
        alerts.append({
            "level": "warning",
            "title": "Skew shift",
            "message": f"{underlying} {expiry}: Skew {direction} (rho {prev['rho']:.3f} → {current['rho']:.3f})",
        })

    if sigma_diff > _SIGMA_THRESHOLD:
        direction = "expanded" if current["sigma"] > prev["sigma"] else "contracted"
        alerts.append({
            "level": "warning",
            "title": "Smile change",
            "message": f"{underlying} {expiry}: Smile {direction} (sigma {prev['sigma']:.3f} → {current['sigma']:.3f})",
        })

    if a_diff > _A_THRESHOLD:
        direction = "jumped" if current["a"] > prev["a"] else "dropped"
        alerts.append({
            "level": "info",
            "title": "Vol level shift",
            "message": f"{underlying} {expiry}: Vol level {direction} (a {prev['a']:.4f} → {current['a']:.4f})",
        })

    return alerts


# Longest a chain may go without a Greeks recompute when no quote has moved.
# Theta and the time-to-expiry term keep drifting even on a frozen chain, so
# an unchanged fingerprint still re-solves at this cadence.
_GREEKS_MAX_STALENESS_S = 5.0


@register([EventType.CHAIN_SNAPSHOT, EventType.POSITION_CHAIN_SNAPSHOT], tier=TIER_GREEKS)
class ChainGreeksCalculator(IndicatorBase):
    """Batch-compute IV and Greeks for an entire option chain snapshot.

    Uses td_core.batch_compute_greeks_warm for warm-started IV solving
    with rayon parallelism over the full strike strip.

    Snapshots arriving faster than the quotes inside them change are skipped:
    re-solving IV for an identical strip yields identical Greeks. This is a
    backstop independent of the UI's demand signal — if demand is mis-reported
    or never arrives, an idle chain still costs close to nothing.
    """

    def __init__(self) -> None:
        # (underlying, expiry, is_position) -> (fingerprint, monotonic time)
        self._last_compute: dict[tuple[str, str, bool], tuple[int, float]] = {}

    def _should_recompute(
        self, key: tuple[str, str, bool], fingerprint: int
    ) -> bool:
        previous = self._last_compute.get(key)
        now_mono = time.monotonic()
        if (
            previous is not None
            and previous[0] == fingerprint
            and now_mono - previous[1] < _GREEKS_MAX_STALENESS_S
        ):
            return False
        self._last_compute[key] = (fingerprint, now_mono)
        return True

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        is_position_snapshot = event.event_type == EventType.POSITION_CHAIN_SNAPSHOT

        payload = event.payload
        strikes_data: list[dict] = payload.get("strikes", [])
        underlying: str = payload.get("underlying", "")
        underlying_price: float | None = payload.get("underlyingPrice") or payload.get("underlying_price")
        expiry: str | None = payload.get("expiry")

        if not strikes_data or underlying_price is None or expiry is None:
            log.debug("greeks.chain_skip", reason="missing_fields", underlying=underlying)
            return []

        now = datetime.now(timezone.utc)
        t = time_to_expiry_years(underlying, expiry, now)
        r = _RISK_FREE_RATE
        # Options on futures (MCX) are Black-76 on the future's price; the
        # snapshot's underlyingPrice is that future's LTP for this expiry.
        is_black76 = pricing_model(underlying) == "black76"

        # Build sorted SoA arrays from the chain snapshot.
        # Each strike in the snapshot may have call and/or put data.
        sorted_strikes: list[float] = []
        sorted_prices: list[float] = []
        sorted_is_calls: list[bool] = []
        sorted_symbols: list[str] = []
        sorted_option_types: list[str] = []

        for strike_entry in strikes_data:
            strike_val: float = strike_entry.get("strike", 0.0)

            for side, is_call, opt_type in [("call", True, "C"), ("put", False, "P")]:
                tick = strike_entry.get(side)
                if tick is None:
                    continue
                bid = tick.get("bid")
                ask = tick.get("ask")
                ltp = tick.get("ltp")
                if bid is not None and ask is not None and bid > 0 and ask > 0:
                    mid = (bid + ask) / 2.0
                elif ltp is not None and ltp > 0:
                    mid = ltp
                else:
                    continue
                sorted_strikes.append(strike_val)
                sorted_prices.append(mid)
                sorted_is_calls.append(is_call)
                sorted_symbols.append(tick.get("symbol", ""))
                sorted_option_types.append(opt_type)

        if not sorted_strikes:
            log.warning("greeks.no_valid_strikes", underlying=underlying, total_entries=len(strikes_data))
            return []

        # debug, not info: fires at the chain's emit cadence.
        log.debug("greeks.pre_compute", underlying=underlying, valid_strikes=len(sorted_strikes), spot=underlying_price, t=round(t, 6))

        # Skip chains whose quotes haven't moved since the last solve. Built
        # from the same inputs the Rust batch consumes, so an identical
        # fingerprint guarantees identical Greeks (modulo the time decay the
        # staleness bound covers).
        fingerprint = hash((
            round(underlying_price, 4),
            tuple(sorted_strikes),
            tuple(round(p, 4) for p in sorted_prices),
            tuple(sorted_is_calls),
        ))
        if not self._should_recompute(
            (underlying, expiry, is_position_snapshot), fingerprint
        ):
            log.debug(
                "greeks.chain_unchanged",
                underlying=underlying,
                expiry=expiry,
                position=is_position_snapshot,
            )
            return []

        # Sort by strike for warm-start sweep
        indices = sorted(range(len(sorted_strikes)), key=lambda i: sorted_strikes[i])
        sorted_strikes = [sorted_strikes[i] for i in indices]
        sorted_prices = [sorted_prices[i] for i in indices]
        sorted_is_calls = [sorted_is_calls[i] for i in indices]
        sorted_symbols = [sorted_symbols[i] for i in indices]
        sorted_option_types = [sorted_option_types[i] for i in indices]

        # Call Rust warm-start batch
        batch = (
            td_core.batch_compute_greeks_warm_black76 if is_black76
            else td_core.batch_compute_greeks_warm
        )
        results = batch(
            underlying_price, r, t,
            sorted_strikes, sorted_prices, sorted_is_calls,
        )

        events: list[RedisEvent] = []
        computed = 0
        greeks_batch: list[dict] = []
        for i, result in enumerate(results):
            if result is None:
                continue
            iv, delta, gamma, theta, vega, vanna, charm, vomma, _price = result
            computed += 1

            greeks_result = GreeksResult(
                symbol=sorted_symbols[i],
                underlying=underlying,
                expiry=expiry,
                strike=sorted_strikes[i],
                option_type=sorted_option_types[i],
                iv=iv,
                delta=delta,
                gamma=gamma,
                theta=theta,
                vega=vega,
                vanna=vanna,
                charm=charm,
                vomma=vomma,
                underlying_price=underlying_price,
                timestamp=now,
            )
            greeks_batch.append(greeks_result.model_dump(mode="json", by_alias=True))

        output_event_type = (
            EventType.POSITION_GREEKS_BATCH_COMPUTED
            if is_position_snapshot
            else EventType.GREEKS_BATCH_COMPUTED
        )

        if greeks_batch:
            events.append(RedisEvent(
                event_type=output_event_type,
                source_service="quant_service",
                payload={
                    "underlying": underlying,
                    "expiry": expiry,
                    "greeks": greeks_batch,
                },
            ))

        # ── For position snapshots, skip SVI fitting and heavy analytics ──
        if is_position_snapshot:
            # Cache position Greeks to a separate hash key
            if computed > 0:
                import json as _json
                greeks_mapping = {}
                for g in greeks_batch:
                    sym = g.get("symbol", "")
                    if sym:
                        greeks_mapping[sym] = _json.dumps(g)
                if greeks_mapping:
                    await cache_hset(
                        _get_settings().redis_url,
                        f"cache:position_greeks:{underlying}:{expiry}",
                        greeks_mapping,
                        ttl=300,
                    )

            log.info(
                "greeks.position_chain_computed",
                underlying=underlying,
                expiry=expiry,
                total=len(sorted_strikes),
                computed=computed,
            )
            return events

        # ── Fit SVI surface to the solved IVs ────────────────────────────
        solved_ivs: list[float] = []
        solved_ks: list[float] = []
        for i, result in enumerate(results):
            if result is None:
                continue
            iv_val = result[0]
            if iv_val > 0 and underlying_price > 0 and sorted_strikes[i] > 0:
                # Forward ≈ spot for simplicity (no dividends)
                k = math.log(sorted_strikes[i] / underlying_price)
                solved_ks.append(k)
                solved_ivs.append(iv_val)

        weights: list[float] | None = None
        if len(solved_ivs) >= 5:
            solved_ks, solved_ivs, weights = td_core.filter_ivs_and_weight(
                solved_ks,
                solved_ivs,
                0.15,
                3.0,
                0.05,
            )

        if len(solved_ks) >= 5:
            svi_params = td_core.svi_fit(solved_ks, solved_ivs, t, weights)
            if svi_params is not None:
                is_arb_free = td_core.svi_check_arbitrage(
                    svi_params,
                    min(solved_ks) - 0.05,
                    max(solved_ks) + 0.05,
                )

                # Compute RMSE
                rmse = td_core.svi_rmse(svi_params, solved_ks, solved_ivs, t)

                svi_result = SviParams(
                    underlying=underlying,
                    expiry=expiry,
                    a=svi_params["a"],
                    b=svi_params["b"],
                    rho=svi_params["rho"],
                    m=svi_params["m"],
                    sigma=svi_params["sigma"],
                    rmse=rmse,
                    arbitrage_free=is_arb_free,
                    timestamp=now,
                )

                # Cache to Redis
                await cache_set(
                    _get_settings().redis_url,
                    f"cache:svi:{underlying}:{expiry}",
                    svi_result.model_dump_json(by_alias=True),
                    ttl=300,
                )

                log.info(
                    "svi.fitted",
                    underlying=underlying,
                    expiry=expiry,
                    rmse=round(rmse, 6),
                    arb_free=is_arb_free,
                    rho=round(svi_params["rho"], 4),
                )

                # Detect significant SVI parameter changes and publish alerts
                svi_alerts = _detect_svi_alerts(underlying, expiry, svi_params, is_arb_free)
                if svi_alerts:
                    from shared.redis_client import publish_event
                    for alert in svi_alerts:
                        alert_event = RedisEvent(
                            event_type=EventType.SVI_ALERT,
                            source_service="quant_service",
                            payload=alert,
                        )
                        await publish_event(
                            _get_settings().redis_url,
                            f"svi:alerts:{underlying}",
                            alert_event,
                        )
                    log.info("svi.alerts_published", underlying=underlying, count=len(svi_alerts))

                # Store ATM IV snapshot in TimescaleDB for persistent IV Rank history
                atm_iv = td_core.svi_iv(svi_params, 0.0, t)
                if atm_iv and atm_iv > 0:
                    try:
                        from shared.db import get_engine
                        from sqlalchemy import text
                        engine = get_engine(_get_settings().timescaledb_url)
                        async with engine.begin() as conn:
                            await conn.execute(
                                text("""
                                    INSERT INTO iv_history (time, underlying, atm_iv, spot_price)
                                    VALUES (:time, :underlying, :atm_iv, :spot)
                                """),
                                {"time": now, "underlying": underlying,
                                 "atm_iv": round(atm_iv * 100, 2),
                                 "spot": underlying_price},
                            )
                    except Exception:
                        log.debug("iv_history.write_failed", underlying=underlying)

        # ── Cache Greeks to Redis hash for REST API access ──────────────
        if computed > 0:
            import json as _json
            greeks_mapping = {}
            for g in greeks_batch:
                sym = g.get("symbol", "")
                if sym:
                    greeks_mapping[sym] = _json.dumps(g)
            if greeks_mapping:
                await cache_hset(
                    _get_settings().redis_url,
                    f"cache:greeks:{underlying}:{expiry}",
                    greeks_mapping,
                    ttl=300,
                )

        log.info(
            "greeks.chain_computed",
            underlying=underlying,
            expiry=expiry,
            total=len(sorted_strikes),
            computed=computed,
        )

        return events
