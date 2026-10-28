"""Reusable analytics helpers for strategy and portfolio risk."""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import structlog

from shared.instruments import expiry_close_utc, pricing_model, unit_multiplier
from shared.redis_client import cache_get, cache_hgetall, get_redis
from shared.schemas.greeks import VrpResult
from shared.schemas.regime import RegimeSnapshot, TradeQualityAssessment, TradeStyle
from shared.schemas.risk import (
    AdjustmentSuggestion,
    ExpiryRiskSummary,
    GreekExposure,
    PortfolioRiskResult,
    RiskFlag,
    RiskSeverity,
    ScenarioPnl,
    StrategyTailRisk,
    UnderlyingRiskSummary,
)
from shared.schemas.strategy import MarginInfo, StrategyLeg, StrategyResult

log = structlog.get_logger()

_RISK_FREE_RATE: float = 0.065
_SYM_RE = re.compile(
    r"^(?P<underlying>[A-Z]+)\s+(?P<expiry>\d{6})\s+(?P<strike>[\d.]+)\s+(?P<option>CE|PE)$"
)


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def normalize_expiry(expiry: str) -> str:
    """Normalize broker/UI expiry strings to YYYY-MM-DD when possible."""
    value = (expiry or "").strip()
    if not value:
        return ""

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value

    compact = value.replace(",", " ").replace("-", " ")
    compact = re.sub(r"\s+", " ", compact).strip()

    for fmt in ("%d %b %Y", "%d %B %Y", "%d %b %y", "%d %B %y"):
        with suppress(ValueError):
            return datetime.strptime(compact, fmt).strftime("%Y-%m-%d")

    with suppress(ValueError):
        return datetime.fromisoformat(value).date().isoformat()

    return value


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _severity_rank(severity: RiskSeverity) -> int:
    return {"safe": 0, "elevated": 1, "high": 2, "critical": 3}[severity]


def _worst_severity(*severities: RiskSeverity) -> RiskSeverity:
    worst: RiskSeverity = "safe"
    for sev in severities:
        if _severity_rank(sev) > _severity_rank(worst):
            worst = sev
    return worst


def _label_from_ratio(ratio: float | None) -> RiskSeverity:
    if ratio is None:
        return "safe"
    if ratio >= 0.05:
        return "critical"
    if ratio >= 0.02:
        return "high"
    if ratio >= 0.005:
        return "elevated"
    return "safe"


def expiry_close_dt(expiry: str, underlying: str | None = None) -> datetime:
    """Expiry close in UTC: 15:30 IST for NSE/BSE, the evening close for MCX."""
    return expiry_close_utc(underlying, normalize_expiry(expiry))


def days_to_expiry(
    expiry: str, now: datetime | None = None, *, underlying: str | None = None
) -> int:
    current = now or datetime.now(UTC)
    diff = expiry_close_dt(expiry, underlying) - current
    return max(math.ceil(diff.total_seconds() / 86400), 1)


def time_to_expiry_years(
    expiry: str, now: datetime | None = None, *, underlying: str | None = None
) -> float:
    return max(days_to_expiry(expiry, now, underlying=underlying) / 365.25, 1e-6)


def build_strategy_leg(
    position: dict[str, Any], *, spot: float | None = None
) -> StrategyLeg | None:
    symbol = str(position.get("symbol", "") or position.get("tradingSymbol", ""))
    if not symbol:
        return None

    parsed = parse_position_symbol(symbol)
    strike = _safe_float(position.get("strikePrice")) or parsed.get("strike")
    option_type = str(position.get("optionType", "") or parsed.get("option_type") or "")
    if option_type == "P":
        option_type = "PE"
    elif option_type == "C":
        option_type = "CE"
    qty = _safe_int(position.get("quantity")) or _safe_int(position.get("netQty")) or 0
    if qty == 0 or strike is None or option_type not in {"CE", "PE"}:
        return None

    expiry = str(position.get("expiry", "") or parsed.get("expiry") or "")
    expiry = normalize_expiry(expiry)
    premium = _safe_float(position.get("avgPrice")) or _safe_float(position.get("ltp")) or 0.0

    return StrategyLeg(
        symbol=symbol,
        strike=float(strike),
        option_type=option_type,
        side="BUY" if qty > 0 else "SELL",
        quantity=abs(qty),
        premium=float(premium),
        underlying=parsed.get("underlying"),
        expiry=expiry or None,
        spot=spot,
    )


def parse_position_symbol(symbol: str) -> dict[str, Any]:
    """Parse our normalized symbol format into option metadata."""
    m = _SYM_RE.match(symbol.strip().upper())
    if not m:
        return {"underlying": "", "expiry": "", "strike": None, "option_type": ""}
    strike_raw = m.group("strike")
    strike = float(strike_raw) if "." in strike_raw else float(int(float(strike_raw)))
    return {
        "underlying": m.group("underlying"),
        "expiry": f"20{m.group('expiry')[:2]}-{m.group('expiry')[2:4]}-{m.group('expiry')[4:6]}",
        "strike": strike,
        "option_type": m.group("option"),
    }


def group_open_positions(
    positions: list[dict[str, Any]],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for pos in positions:
        if pos.get("isOpen", True) is False:
            continue
        qty = _safe_int(pos.get("quantity")) or _safe_int(pos.get("netQty")) or 0
        if qty == 0:
            continue
        parsed = parse_position_symbol(str(pos.get("symbol", "")))
        underlying = str(pos.get("_underlying") or parsed.get("underlying") or "").upper()
        expiry = normalize_expiry(str(pos.get("_expiryIso") or pos.get("expiry") or parsed.get("expiry") or ""))
        if not underlying or not expiry:
            continue
        grouped[underlying][expiry].append(pos)
    return grouped


async def load_cached_snapshot(
    redis_url: str, underlying: str, expiry: str
) -> dict[str, Any] | None:
    raw = await cache_get(redis_url, f"cache:chain:snapshot:{underlying}:{expiry}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def load_cached_vrp(redis_url: str, underlying: str) -> VrpResult | None:
    raw = await cache_get(redis_url, f"cache:vrp:{underlying}")
    if not raw:
        return None
    try:
        return VrpResult.model_validate_json(raw)
    except Exception:
        try:
            return VrpResult.model_validate(json.loads(raw))
        except Exception:
            return None


async def load_underlying_expiries(redis_url: str, underlying: str) -> list[str]:
    try:
        async with get_redis(redis_url) as client:
            expiries = await client.smembers(f"cache:expiries:{underlying}")
    except Exception:
        return []

    normalized = [normalize_expiry(str(expiry)) for expiry in expiries if expiry]
    return sorted({expiry for expiry in normalized if expiry})


async def load_cached_svi(redis_url: str, underlying: str, expiry: str) -> dict[str, Any] | None:
    raw = await cache_get(redis_url, f"cache:svi:{underlying}:{expiry}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def load_cached_surface_percentiles(
    redis_url: str, underlying: str
) -> dict[str, list[float]] | None:
    """Load historical surface metric observations for percentile ranking.

    Expected Redis value at ``cache:surface_percentiles:{underlying}`` is a JSON
    object with sorted float arrays::

        {
            "term_structure_slope": [-0.02, -0.01, 0.0, 0.005, ...],
            "skew_indicator":      [0.001, 0.005, 0.01, ...],
            "convexity_indicator": [-0.002, 0.0, 0.003, ...]
        }
    """
    raw = await cache_get(redis_url, f"cache:surface_percentiles:{underlying}")
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def compute_percentile(value: float, history: list[float]) -> float | None:
    """Return the percentile rank (0-100) of *value* within *history*.

    Uses a simple count-below approach.  Returns ``None`` when *history*
    contains fewer than 10 observations.
    """
    if not history or len(history) < 10:
        return None
    below = sum(1 for h in history if h < value)
    return round((below / len(history)) * 100.0, 1)


async def load_event_calendar(
    redis_url: str, underlying: str
) -> list[dict[str, str]] | None:
    """Load scheduled events from Redis.

    Expected Redis value at ``cache:event_calendar:{underlying}`` is a JSON
    array of ``{"date": "YYYY-MM-DD", "label": "...", "type": "..."}``.
    Types include ``earnings``, ``policy``, ``expiry``, ``economic_data``.
    """
    raw = await cache_get(redis_url, f"cache:event_calendar:{underlying}")
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else None
    except (json.JSONDecodeError, TypeError):
        return None


def tag_events(
    events: list[dict[str, str]] | None,
    expiry: str | None,
    now: datetime | None = None,
) -> list[str]:
    """Return event labels within 7 days or the DTE window (whichever is larger)."""
    if not events:
        return []
    current = now or datetime.now(UTC)
    current_date = current.date() if hasattr(current, "date") else current

    # Window: at least 7 days, extended to expiry if further out
    window_end = current_date + timedelta(days=7)
    if expiry:
        normalized = normalize_expiry(expiry)
        if normalized:
            with suppress(ValueError):
                expiry_date = datetime.strptime(normalized, "%Y-%m-%d").date()
                if expiry_date > window_end:
                    window_end = expiry_date

    tags: list[str] = []
    for event in events:
        event_date_str = event.get("date", "")
        if not event_date_str:
            continue
        try:
            event_date = datetime.strptime(event_date_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        if current_date <= event_date <= window_end:
            label = event.get("label", event.get("type", "event"))
            tags.append(label)
    return tags


def _estimate_atm_iv_from_svi(svi_params: dict[str, Any], t: float | None) -> float | None:
    if t is None or t <= 0:
        return None
    try:
        import td_core

        params = {
            "a": float(svi_params["a"]),
            "b": float(svi_params["b"]),
            "rho": float(svi_params["rho"]),
            "m": float(svi_params["m"]),
            "sigma": float(svi_params["sigma"]),
        }
        value = td_core.svi_iv(params, 0.0, t)
        return float(value) if value and value > 0 else None
    except Exception:
        return None


def _estimate_surface_shape_from_svi(
    svi_params: dict[str, Any], t: float | None
) -> tuple[float | None, float | None]:
    if t is None or t <= 0:
        return None, None
    try:
        import td_core

        params = {
            "a": float(svi_params["a"]),
            "b": float(svi_params["b"]),
            "rho": float(svi_params["rho"]),
            "m": float(svi_params["m"]),
            "sigma": float(svi_params["sigma"]),
        }
        put_iv = td_core.svi_iv(params, -0.1, t)
        atm_iv = td_core.svi_iv(params, 0.0, t)
        call_iv = td_core.svi_iv(params, 0.1, t)
        if not put_iv or not atm_iv or not call_iv:
            return None, None
        skew_indicator = float(put_iv - call_iv)
        convexity_indicator = float(((put_iv + call_iv) / 2.0) - atm_iv)
        return skew_indicator, convexity_indicator
    except Exception:
        return None, None


async def load_cached_greeks(
    redis_url: str, underlying: str, expiry: str
) -> dict[str, dict[str, Any]]:
    key = f"cache:position_greeks:{underlying}:{expiry}"
    data = await cache_hgetall(redis_url, key)
    if not data:
        key = f"cache:greeks:{underlying}:{expiry}"
        data = await cache_hgetall(redis_url, key)

    parsed: dict[str, dict[str, Any]] = {}
    for symbol, value in data.items():
        try:
            parsed[symbol] = json.loads(value) if isinstance(value, str) else value
        except (TypeError, json.JSONDecodeError):
            continue
    return parsed


async def load_account_limits(redis_url: str) -> dict[str, float | None] | None:
    from shared.live_session import get_live_kotak_credentials
    from shared.schemas.auth import SessionState
    from shared.session_client import get_session

    session = await get_session(redis_url)
    live_creds = get_live_kotak_credentials()
    if (
        not session
        or session.state not in (SessionState.ACTIVE, SessionState.DEGRADED)
        or live_creds is None
    ):
        return None

    access_token = live_creds.access_token.get_secret_value()
    sid = str(live_creds.extra.get("sid") or "")
    base_url = str(live_creds.extra.get("base_url") or session.base_url or "")
    if not access_token or not sid or not base_url:
        return None

    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    headers = {
        "Auth": access_token,
        "Sid": sid,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/x-www-form-urlencoded",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{base_url}/quick/user/limits",
                headers=headers,
                content='jData={"seg":"ALL","exch":"ALL","prod":"ALL"}',
            )
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception:
        return None

    margin_used = (
        (_safe_float(data.get("UnrealizedMtomPrsnt")) or 0.0)
        + (_safe_float(data.get("ExposureMarginPrsnt")) or 0.0)
        + (_safe_float(data.get("FoSpanrgnNrmlPrsnt")) or 0.0)
    )

    return {
        "net": _safe_float(data.get("Net")),
        "available_margin": _safe_float(data.get("Net")),
        "margin_used": margin_used,
        "collateral": _safe_float(data.get("CollateralValue")),
        "margin_from_shares": _safe_float(data.get("Collateral")),
    }


def make_strategy_legs(
    positions: list[dict[str, Any]], *, spot: float | None = None
) -> list[StrategyLeg]:
    legs: list[StrategyLeg] = []
    for pos in positions:
        leg = build_strategy_leg(pos, spot=spot)
        if leg is not None:
            legs.append(leg)
    return legs


def compute_expected_move(
    spot: float | None, atm_iv: float | None, t_years: float | None
) -> StrategyTailRisk:
    if (
        spot is None
        or spot <= 0
        or atm_iv is None
        or atm_iv <= 0
        or t_years is None
        or t_years <= 0
    ):
        return StrategyTailRisk()

    daily_move = spot * atm_iv / math.sqrt(252)
    expiry_move = spot * atm_iv * math.sqrt(t_years)
    return StrategyTailRisk(
        spot=spot,
        atm_iv=atm_iv,
        expected_move=expiry_move,
        expected_move_pct=(expiry_move / spot) * 100 if spot else None,
        daily_expected_move=daily_move,
        daily_expected_move_pct=(daily_move / spot) * 100 if spot else None,
    )


def infer_trade_style(
    *,
    exposures: GreekExposure,
    expiry_count: int,
    leg_count: int | None = None,
) -> TradeStyle:
    if expiry_count > 1 and abs(exposures.vega) >= max(abs(exposures.delta), 1.0):
        return "calendar_term_structure"
    if exposures.theta > 0 and exposures.vega < 0:
        return "short_vol_carry"
    if exposures.gamma > 0 and exposures.vega > 0 and exposures.theta < 0:
        return "long_convexity"
    if exposures.delta >= 10:
        return "directional_bull"
    if exposures.delta <= -10:
        return "directional_bear"
    if leg_count == 1 and exposures.gamma > 0:
        return "long_convexity"
    return "neutral"


def infer_trade_style_from_legs(legs: list[StrategyLeg]) -> TradeStyle:
    if not legs:
        return "unknown"

    expiry_count = len({normalize_expiry(leg.expiry or "") for leg in legs if leg.expiry})
    if expiry_count > 1:
        return "calendar_term_structure"

    if all(leg.side == "SELL" for leg in legs):
        return "short_vol_carry"
    if all(leg.side == "BUY" for leg in legs):
        if len(legs) == 1:
            leg = legs[0]
            if leg.option_type in {"CE", "C"}:
                return "directional_bull"
            if leg.option_type in {"PE", "P"}:
                return "directional_bear"
        return "long_convexity"

    if len(legs) == 1:
        leg = legs[0]
        if leg.side == "BUY" and leg.option_type in {"CE", "C"}:
            return "directional_bull"
        if leg.side == "BUY" and leg.option_type in {"PE", "P"}:
            return "directional_bear"

    return "neutral"


async def build_regime_snapshot(
    *,
    redis_url: str | None,
    underlying: str | None,
    expiry: str | None,
    spot: float | None,
    atm_iv: float | None,
    iv_rank: float | None,
    vrp: float | None,
    daily_expected_move_pct: float | None,
    as_of: datetime | None = None,
) -> RegimeSnapshot | None:
    if not underlying:
        return None

    drivers: list[str] = []
    term_structure_slope: float | None = None
    event_premium: float | None = None
    skew_indicator: float | None = None
    convexity_indicator: float | None = None
    term_structure_slope_pctile: float | None = None
    skew_indicator_pctile: float | None = None
    convexity_indicator_pctile: float | None = None
    event_tags: list[str] = []
    feature_count = 0

    target_expiry = normalize_expiry(expiry or "") or None
    if iv_rank is not None:
        feature_count += 1
        drivers.append(f"IV rank {iv_rank:.0f}")
    if vrp is not None:
        feature_count += 1
        drivers.append(f"VRP {vrp:+.2f}")

    if redis_url and target_expiry:
        expiries = await load_underlying_expiries(redis_url, underlying)
        future_expiries = [item for item in expiries if item >= target_expiry]
        current_t = time_to_expiry_years(target_expiry, underlying=underlying) if target_expiry else None
        current_svi = await load_cached_svi(redis_url, underlying, target_expiry)
        if current_svi:
            current_atm = _estimate_atm_iv_from_svi(current_svi, current_t)
            if current_atm and (atm_iv is None or atm_iv <= 0):
                atm_iv = current_atm
            skew_indicator, convexity_indicator = _estimate_surface_shape_from_svi(
                current_svi, current_t
            )
            if skew_indicator is not None:
                feature_count += 1
                drivers.append(f"Skew {skew_indicator:+.3f}")
            if convexity_indicator is not None:
                feature_count += 1
                drivers.append(f"Convexity {convexity_indicator:+.3f}")

        if len(future_expiries) >= 2 and atm_iv is not None:
            next_expiry = future_expiries[1]
            next_t = time_to_expiry_years(next_expiry, underlying=underlying)
            next_svi = await load_cached_svi(redis_url, underlying, next_expiry)
            next_atm = _estimate_atm_iv_from_svi(next_svi, next_t) if next_svi else None
            if next_atm is not None:
                term_structure_slope = next_atm - atm_iv
                event_premium = atm_iv - next_atm
                feature_count += 1
                shape = "backwardated" if term_structure_slope < 0 else "normal"
                drivers.append(f"Term {shape} {term_structure_slope:+.3f}")

    # ── Historical percentile normalization ────────────────────────────
    if redis_url:
        pctile_data = await load_cached_surface_percentiles(redis_url, underlying)
        if pctile_data:
            if term_structure_slope is not None:
                term_structure_slope_pctile = compute_percentile(
                    term_structure_slope,
                    pctile_data.get("term_structure_slope", []),
                )
                if term_structure_slope_pctile is not None:
                    feature_count += 1
                    drivers.append(f"Term pctile {term_structure_slope_pctile:.0f}")
            if skew_indicator is not None:
                skew_indicator_pctile = compute_percentile(
                    skew_indicator,
                    pctile_data.get("skew_indicator", []),
                )
                if skew_indicator_pctile is not None:
                    drivers.append(f"Skew pctile {skew_indicator_pctile:.0f}")
            if convexity_indicator is not None:
                convexity_indicator_pctile = compute_percentile(
                    convexity_indicator,
                    pctile_data.get("convexity_indicator", []),
                )
                if convexity_indicator_pctile is not None:
                    drivers.append(f"Convexity pctile {convexity_indicator_pctile:.0f}")

    # ── Event calendar tagging ────────────────────────────────────────
    if redis_url:
        events = await load_event_calendar(redis_url, underlying)
        event_tags = tag_events(events, target_expiry, as_of)
        if event_tags:
            feature_count += 1
            drivers.append(f"Events: {', '.join(event_tags[:3])}")

    # ── Regime classification (percentile-aware) ──────────────────────
    # Use percentile thresholds when available, fall back to raw levels.
    is_backwardated = (
        (term_structure_slope_pctile is not None and term_structure_slope_pctile <= 10)
        or (term_structure_slope_pctile is None and term_structure_slope is not None and term_structure_slope < 0)
    )
    has_event_premium = (
        event_premium is not None and event_premium > 0.015
    )
    has_event_tag = len(event_tags) > 0

    regime_label = "unknown"
    if iv_rank is not None and iv_rank >= 80 and (is_backwardated or has_event_premium):
        regime_label = "stressed"
    elif has_event_tag or has_event_premium:
        regime_label = "event_rich"
    elif iv_rank is not None and iv_rank <= 30:
        regime_label = "compressed"
    elif iv_rank is not None and iv_rank >= 65:
        regime_label = "elevated"
    elif iv_rank is not None or vrp is not None:
        regime_label = "balanced"

    confidence: str = "low"
    if feature_count >= 4:
        confidence = "high"
    elif feature_count >= 2:
        confidence = "medium"

    return RegimeSnapshot(
        underlying=underlying,
        expiry=target_expiry,
        as_of=as_of or datetime.now(UTC),
        spot=spot,
        atm_iv=atm_iv,
        iv_rank=iv_rank,
        vrp=vrp,
        daily_expected_move_pct=daily_expected_move_pct,
        term_structure_slope=term_structure_slope,
        event_premium=event_premium,
        skew_indicator=skew_indicator,
        convexity_indicator=convexity_indicator,
        term_structure_slope_pctile=term_structure_slope_pctile,
        skew_indicator_pctile=skew_indicator_pctile,
        convexity_indicator_pctile=convexity_indicator_pctile,
        event_tags=event_tags,
        regime_label=regime_label,
        confidence=confidence,
        drivers=drivers,
    )


def build_trade_quality(
    *,
    style: TradeStyle,
    regime_snapshot: RegimeSnapshot | None,
    pop_edge: float | None = None,
) -> TradeQualityAssessment:
    if regime_snapshot is None:
        return TradeQualityAssessment(style=style, overall_label="unknown", confidence="low")

    score = 50.0
    rationale: list[str] = []
    headwinds: list[str] = []

    iv_rank = regime_snapshot.iv_rank
    vrp = regime_snapshot.vrp
    slope = regime_snapshot.term_structure_slope
    event_premium = regime_snapshot.event_premium
    skew = regime_snapshot.skew_indicator

    # Percentile-aware helpers — prefer percentile thresholds when available.
    slope_pctile = regime_snapshot.term_structure_slope_pctile if regime_snapshot else None
    skew_pctile = regime_snapshot.skew_indicator_pctile if regime_snapshot else None

    def _is_backwardated() -> bool:
        if slope_pctile is not None:
            return slope_pctile <= 15
        return slope is not None and slope < -0.01

    def _is_skew_rich() -> bool:
        if skew_pctile is not None:
            return skew_pctile >= 85
        return skew is not None and skew > 0.02

    if style == "short_vol_carry":
        if vrp is not None and vrp > 0:
            score += 18
            rationale.append("Positive VRP supports short-vol carry.")
        elif vrp is not None and vrp < 0:
            score -= 18
            headwinds.append("Negative VRP weakens short-vol carry.")
        if iv_rank is not None and 55 <= iv_rank < 85:
            score += 10
            rationale.append("IV is rich without being at panic extremes.")
        elif iv_rank is not None and iv_rank < 30:
            score -= 12
            headwinds.append("Low-IV regime leaves less premium cushion.")
        if _is_backwardated():
            score -= 18
            headwinds.append("Backwardated term structure points to stress/event premium.")
        if event_premium is not None and event_premium > 0.015:
            score -= 10
            headwinds.append("Front expiry carries event premium.")
        if _is_skew_rich():
            score -= 8
            headwinds.append("Downside skew is rich, increasing tail premium.")
    elif style == "long_convexity":
        if vrp is not None and vrp < 0:
            score += 18
            rationale.append("Negative VRP favors owning convexity.")
        elif vrp is not None and vrp > 0:
            score -= 10
            headwinds.append("Positive VRP makes long premium carry harder.")
        if iv_rank is not None and iv_rank <= 35:
            score += 14
            rationale.append("IV is relatively cheap.")
        elif iv_rank is not None and iv_rank >= 70:
            score -= 14
            headwinds.append("High-IV regime makes long premium expensive.")
        if _is_backwardated():
            score += 10
            rationale.append("Backwardated term structure supports convexity demand.")
        if event_premium is not None and event_premium > 0.015:
            score += 8
            rationale.append("Front expiry is pricing an event premium.")
    elif style == "calendar_term_structure":
        if event_premium is not None and abs(event_premium) >= 0.01:
            score += 15
            rationale.append("Visible front/back dislocation supports term-structure positioning.")
        if slope is not None and slope > 0.005:
            score += 8
            rationale.append("Normal term structure supports carry across expiries.")
        elif _is_backwardated():
            score -= 8
            headwinds.append("Backwardation can destabilize calendar carry.")
    elif style in {"directional_bull", "directional_bear"}:
        if pop_edge is not None and pop_edge > 0:
            score += 12
            rationale.append("Model PoP exceeds market-implied PoP.")
        elif pop_edge is not None and pop_edge < 0:
            score -= 12
            headwinds.append("Market-implied pricing is richer than model edge.")
        if iv_rank is not None and iv_rank >= 75:
            headwinds.append("High-IV regime can dominate directional thesis with premium decay.")
            score -= 6

    if pop_edge is not None:
        edge_points = _clamp(pop_edge * 400.0, -15.0, 15.0)
        score += edge_points
        if edge_points > 0:
            rationale.append("Positive model-vs-market edge improves trade quality.")
        elif edge_points < 0:
            headwinds.append("Negative model-vs-market edge weakens quality.")

    score = round(_clamp(score, 0.0, 100.0), 1)
    if score >= 70:
        label = "strong"
    elif score >= 55:
        label = "favorable"
    elif score >= 40:
        label = "mixed"
    else:
        label = "poor"

    known_features = sum(
        1
        for item in (
            regime_snapshot.iv_rank,
            regime_snapshot.vrp,
            regime_snapshot.term_structure_slope,
            regime_snapshot.skew_indicator,
            pop_edge,
        )
        if item is not None
    )
    confidence: str = "low"
    if known_features >= 4:
        confidence = "high"
    elif known_features >= 2:
        confidence = "medium"

    return TradeQualityAssessment(
        style=style,
        overall_label=label,
        overall_score=score,
        regime_fit_score=round(_clamp(score - (pop_edge or 0.0) * 200.0, 0.0, 100.0), 1),
        edge_score=(
            round(_clamp(50.0 + (pop_edge * 400.0), 0.0, 100.0), 1)
            if pop_edge is not None
            else None
        ),
        confidence=confidence,
        rationale=rationale,
        headwinds=headwinds,
    )


def _one_sigma_delta_gamma_pnl(
    delta: float, gamma: float, spot_move: float
) -> tuple[float, float, float]:
    delta_pnl = delta * spot_move
    gamma_pnl = 0.5 * gamma * spot_move * spot_move
    return delta_pnl, gamma_pnl, delta_pnl + gamma_pnl


def compute_scenario_pnl(
    *,
    positions: list[dict[str, Any]],
    greeks_map: dict[str, dict[str, Any]],
    spot: float,
    atm_iv: float,
    t_years: float,
    risk_free_rate: float = _RISK_FREE_RATE,
    sigma_levels: tuple[int, ...] = (1, 2, 3),
    underlying: str | None = None,
) -> dict[int, ScenarioPnl]:
    """Full reprice at ±Nσ scenario underlying levels, replacing Taylor approximation.

    BSM on spot for index options; Black-76 on the future for options on
    futures (MCX). P&L is in rupees via the underlying's unit multiplier.
    """
    try:
        import td_core
    except ImportError:
        return {}

    price_fn = (
        td_core.black76_price if pricing_model(underlying) == "black76" else td_core.bs_price
    )
    value_mult = unit_multiplier(underlying)

    sigma_sqrt_t = atm_iv * math.sqrt(t_years)
    if sigma_sqrt_t <= 0:
        return {}

    # Pre-compute scenario spot levels
    scenarios: dict[int, tuple[float, float]] = {}
    for n in sigma_levels:
        scenarios[n] = (
            spot * math.exp(-n * sigma_sqrt_t),
            spot * math.exp(n * sigma_sqrt_t),
        )

    # Collect position details from greeks cache
    pos_details: list[tuple[float, float, float, bool]] = []  # (signed_qty, strike, iv, is_call)
    for pos in positions:
        qty = _safe_int(pos.get("quantity")) or _safe_int(pos.get("netQty")) or 0
        if qty == 0:
            continue
        symbol = str(pos.get("symbol", ""))
        g = greeks_map.get(symbol, {})
        iv = _safe_float(g.get("iv"))
        strike = _safe_float(g.get("strike"))
        opt_type = str(g.get("optionType") or g.get("option_type") or "")
        if iv is None or iv <= 0 or strike is None or strike <= 0:
            continue
        is_call = opt_type in ("C", "CE")
        pos_details.append((float(qty), strike, iv, is_call))

    if not pos_details:
        return {}

    # Compute current value of each position
    current_values: list[float] = []
    for signed_qty, strike, iv, is_call in pos_details:
        current_values.append(
            signed_qty * value_mult * price_fn(spot, strike, t_years, risk_free_rate, iv, is_call)
        )

    # Reprice at each scenario
    result: dict[int, ScenarioPnl] = {}
    for n, (spot_down, spot_up) in scenarios.items():
        pnl_down = 0.0
        pnl_up = 0.0
        for i, (signed_qty, strike, iv, is_call) in enumerate(pos_details):
            val_down = signed_qty * value_mult * price_fn(
                spot_down, strike, t_years, risk_free_rate, iv, is_call
            )
            val_up = signed_qty * value_mult * price_fn(
                spot_up, strike, t_years, risk_free_rate, iv, is_call
            )
            pnl_down += val_down - current_values[i]
            pnl_up += val_up - current_values[i]

        result[n] = ScenarioPnl(
            spot_down=round(spot_down, 2),
            spot_up=round(spot_up, 2),
            pnl_down=round(pnl_down, 2),
            pnl_up=round(pnl_up, 2),
            worst_pnl=round(min(pnl_down, pnl_up), 2),
        )

    return result


def classify_tail_risk(
    *,
    exposures: GreekExposure,
    tail_risk: StrategyTailRisk,
    account_net: float | None = None,
    expiry_count: int = 1,
    scenario_pnls: dict[int, ScenarioPnl] | None = None,
) -> tuple[RiskSeverity, list[RiskFlag]]:
    flags: list[RiskFlag] = []
    severity: RiskSeverity = "safe"

    if expiry_count > 1:
        flags.append(
            RiskFlag(
                code="mixed_expiries",
                severity="elevated",
                title="Multiple expiries",
                message=(
                    "Risk is split across multiple expiries; front expiry can "
                    "dominate near-term P&L."
                ),
            )
        )
        severity = _worst_severity(severity, "elevated")

    spot = tail_risk.spot
    one_sigma = tail_risk.expected_move

    # Taylor diagnostic values (kept for backward compat)
    if spot and one_sigma:
        delta_pnl, gamma_pnl, total_pnl = _one_sigma_delta_gamma_pnl(
            exposures.delta, exposures.gamma, one_sigma
        )
        tail_risk.one_sigma_delta_pnl = delta_pnl
        tail_risk.one_sigma_gamma_pnl = gamma_pnl
        tail_risk.one_sigma_total_pnl = total_pnl
        tail_risk.projected_delta_up = exposures.delta + exposures.gamma * one_sigma
        tail_risk.projected_delta_down = exposures.delta - exposures.gamma * one_sigma

    # Attach full-reprice scenarios
    if scenario_pnls:
        tail_risk.scenario_1s = scenario_pnls.get(1)
        tail_risk.scenario_2s = scenario_pnls.get(2)
        tail_risk.scenario_3s = scenario_pnls.get(3)

    # Risk flags: prefer full-reprice worst_pnl, fall back to Taylor
    if account_net and account_net > 0:
        s1 = scenario_pnls.get(1) if scenario_pnls else None
        pnl_1s = abs(s1.worst_pnl) if s1 else (abs(tail_risk.one_sigma_total_pnl) if tail_risk.one_sigma_total_pnl else None)
        if pnl_1s is not None:
            ratio = pnl_1s / account_net
            method = "Full-reprice" if s1 else "Estimated"
            if ratio >= 0.05:
                severity = _worst_severity(severity, "critical")
                flags.append(
                    RiskFlag(
                        code="one_sigma_pnl_critical",
                        severity="critical",
                        title="Large 1-sigma P&L",
                        message=f"{method} 1σ worst case is {ratio * 100:.1f}% of Net Liq.",
                    )
                )
            elif ratio >= 0.02:
                severity = _worst_severity(severity, "high")
                flags.append(
                    RiskFlag(
                        code="one_sigma_pnl_high",
                        severity="high",
                        title="Material 1-sigma P&L",
                        message=f"{method} 1σ worst case is {ratio * 100:.1f}% of Net Liq.",
                    )
                )
            elif ratio >= 0.005:
                severity = _worst_severity(severity, "elevated")
                flags.append(
                    RiskFlag(
                        code="one_sigma_pnl_elevated",
                        severity="elevated",
                        title="Visible 1-sigma P&L",
                        message=f"{method} 1σ worst case is {ratio * 100:.1f}% of Net Liq.",
                    )
                )

        # 2-sigma stress flags
        s2 = scenario_pnls.get(2) if scenario_pnls else None
        if s2:
            ratio_2 = abs(s2.worst_pnl) / account_net
            if ratio_2 >= 0.10:
                severity = _worst_severity(severity, "critical")
                flags.append(
                    RiskFlag(
                        code="two_sigma_pnl_critical",
                        severity="critical",
                        title="Severe 2-sigma P&L",
                        message=f"Full-reprice 2σ worst case is {ratio_2 * 100:.1f}% of Net Liq.",
                    )
                )
            elif ratio_2 >= 0.05:
                severity = _worst_severity(severity, "high")
                flags.append(
                    RiskFlag(
                        code="two_sigma_pnl_high",
                        severity="high",
                        title="Large 2-sigma P&L",
                        message=f"Full-reprice 2σ worst case is {ratio_2 * 100:.1f}% of Net Liq.",
                    )
                )

        # 3-sigma stress flags
        s3 = scenario_pnls.get(3) if scenario_pnls else None
        if s3:
            ratio_3 = abs(s3.worst_pnl) / account_net
            if ratio_3 >= 0.20:
                severity = _worst_severity(severity, "critical")
                flags.append(
                    RiskFlag(
                        code="three_sigma_pnl_critical",
                        severity="critical",
                        title="Extreme 3-sigma P&L",
                        message=f"Full-reprice 3σ worst case is {ratio_3 * 100:.1f}% of Net Liq.",
                    )
                )
            elif ratio_3 >= 0.10:
                severity = _worst_severity(severity, "high")
                flags.append(
                    RiskFlag(
                        code="three_sigma_pnl_high",
                        severity="high",
                        title="Severe 3-sigma P&L",
                        message=f"Full-reprice 3σ worst case is {ratio_3 * 100:.1f}% of Net Liq.",
                    )
                )

    if exposures.gamma < 0 and tail_risk.expected_move_pct is not None:
        if tail_risk.expected_move_pct <= 2.0:
            severity = _worst_severity(severity, "critical")
            flags.append(
                RiskFlag(
                    code="short_gamma_near_expiry",
                    severity="critical",
                    title="Short gamma near expiry",
                    message=(
                        "Delta can flip quickly on a normal move when "
                        "near-expiry short gamma dominates."
                    ),
                )
            )
        elif tail_risk.expected_move_pct <= 5.0:
            severity = _worst_severity(severity, "high")
            flags.append(
                RiskFlag(
                    code="short_gamma",
                    severity="high",
                    title="Short gamma",
                    message="Directional exposure can swing rapidly as spot moves.",
                )
            )

    if exposures.vega < 0 and tail_risk.iv_rank is not None:
        if tail_risk.iv_rank >= 70:
            severity = _worst_severity(severity, "high")
            flags.append(
                RiskFlag(
                    code="short_vega_high_iv",
                    severity="high",
                    title="Short vega in high IV",
                    message=(
                        "Premium is rich; short vega can work, but exposure "
                        "can accelerate in a volatility expansion."
                    ),
                )
            )
        elif tail_risk.iv_rank < 30:
            severity = _worst_severity(severity, "high")
            flags.append(
                RiskFlag(
                    code="short_vega_low_iv",
                    severity="high",
                    title="Short vega in low IV",
                    message="Vol is cheap; short vega has poor convexity if volatility expands.",
                )
            )

    if exposures.vega > 0 and tail_risk.iv_rank is not None and tail_risk.iv_rank >= 70:
        severity = _worst_severity(severity, "elevated")
        flags.append(
            RiskFlag(
                code="long_vega_high_iv",
                severity="elevated",
                title="Long vega in high IV",
                message="Volatility is already expensive; upside needs a strong catalyst.",
            )
        )

    if exposures.vanna and abs(exposures.vanna) >= 8:
        severity = _worst_severity(severity, "elevated")
        flags.append(
            RiskFlag(
                code="vanna_cross_risk",
                severity="elevated",
                title="Cross-risk present",
                message="Spot and IV moves will not remain independent for this book.",
            )
        )

    if exposures.vomma < 0:
        severity = _worst_severity(severity, "elevated")
        flags.append(
            RiskFlag(
                code="negative_vomma",
                severity="elevated",
                title="Negative vol convexity",
                message="Vega can worsen as volatility expands.",
            )
        )

    return severity, flags


async def build_strategy_result(
    legs: list[StrategyLeg],
    *,
    underlying: str | None = None,
    expiry: str | None = None,
    spot: float | None = None,
    redis_url: str | None = None,
    risk_free_rate: float = _RISK_FREE_RATE,
) -> StrategyResult | None:
    if not legs:
        return None

    if underlying is None:
        underlying = next((leg.underlying for leg in legs if leg.underlying), None)
    if expiry is None:
        expiry = next((leg.expiry for leg in legs if leg.expiry), None)
    if spot is None:
        spot = next((leg.spot for leg in legs if leg.spot), None)

    # ₹ per unit qty per ₹1 price (GOLD 100, GOLDM 0.1, else 1)
    value_mult = unit_multiplier(underlying)

    strikes = [leg.strike for leg in legs]
    center = sum(strikes) / len(strikes)
    spot_min = center * 0.8
    spot_max = center * 1.2
    n_points = 500
    step = (spot_max - spot_min) / n_points

    payoff_x: list[float] = []
    payoff_y: list[float] = []
    for i in range(n_points + 1):
        s = spot_min + i * step
        pnl = 0.0
        for leg in legs:
            is_call = leg.option_type in ("C", "CE")
            intrinsic = max(s - leg.strike, 0.0) if is_call else max(leg.strike - s, 0.0)
            signed_qty = leg.quantity if leg.side == "BUY" else -leg.quantity
            pnl += (intrinsic - leg.premium) * signed_qty * value_mult
        payoff_x.append(round(s, 2))
        payoff_y.append(round(pnl, 2))

    breakevens: list[float] = []
    for i in range(len(payoff_y) - 1):
        if payoff_y[i] * payoff_y[i + 1] < 0:
            frac = abs(payoff_y[i]) / (abs(payoff_y[i]) + abs(payoff_y[i + 1]))
            be = payoff_x[i] + frac * (payoff_x[i + 1] - payoff_x[i])
            breakevens.append(round(be, 2))

    net_credit = value_mult * sum(
        leg.premium * leg.quantity * (1 if leg.side == "SELL" else -1) for leg in legs
    )
    max_profit = max(payoff_y) if payoff_y else None
    max_loss = min(payoff_y) if payoff_y else None
    pop = sum(1 for y in payoff_y if y > 0) / len(payoff_y) if payoff_y else 0.0

    risk_neutral_pop: float | None = None
    density_x: list[float] | None = None
    density_y: list[float] | None = None
    density: list[float] | None = None
    t: float | None = None
    vg_pop: float | None = None

    if underlying and expiry and spot and spot > 0 and redis_url:
        try:
            import orjson
            import td_core

            now = datetime.now(UTC)
            t = time_to_expiry_years(expiry, now, underlying=underlying)
            heston_params = {"kappa": 1.8, "theta": 0.04, "sigma_v": 0.6, "rho": -0.55, "v0": 0.03}
            heston_raw = await cache_get(
                redis_url, f"cache:calibrated-heston:{underlying}:{expiry}"
            )
            if heston_raw:
                cal = orjson.loads(heston_raw)
                heston_params = cal["params"]

            density = td_core.risk_neutral_density(
                "heston", heston_params, spot, risk_free_rate, t, payoff_x
            )
            risk_neutral_pop = round(td_core.compute_pop(payoff_x, density, payoff_y), 4)
            density_x = payoff_x
            density_y = [round(d, 8) for d in density]

            vg_params = {"sigma": 0.12, "theta": -0.14, "nu": 0.2}
            vg_raw = await cache_get(redis_url, f"cache:calibrated-vg:{underlying}:{expiry}")
            if vg_raw:
                vg_cal = orjson.loads(vg_raw)
                vg_params = vg_cal["params"]

            vg_density = td_core.risk_neutral_density(
                "vg", vg_params, spot, risk_free_rate, t, payoff_x
            )
            vg_pop = round(td_core.compute_pop(payoff_x, vg_density, payoff_y), 4)
        except Exception:
            log.debug(
                "risk.strategy_tail_failed", underlying=underlying, expiry=expiry, exc_info=True
            )

    var_5: float | None = None
    es_5: float | None = None
    if density is not None:
        try:
            import td_core

            var_5 = round(td_core.compute_var(payoff_x, density, payoff_y, 0.05), 2)
            es_5 = round(td_core.compute_expected_shortfall(payoff_x, density, payoff_y, 0.05), 2)
        except Exception:
            log.debug(
                "risk.strategy_var_es_failed", underlying=underlying, expiry=expiry, exc_info=True
            )

    market_pop: float | None = None
    pop_edge: float | None = None
    if (
        underlying
        and expiry
        and spot
        and spot > 0
        and risk_neutral_pop is not None
        and t is not None
        and redis_url
    ):
        try:
            import orjson
            import td_core

            atm_iv: float | None = None
            svi_raw = await cache_get(redis_url, f"cache:svi:{underlying}:{expiry}")
            if svi_raw:
                svi_data = orjson.loads(svi_raw)
                svi_params = {
                    "a": svi_data["a"],
                    "b": svi_data["b"],
                    "rho": svi_data["rho"],
                    "m": svi_data["m"],
                    "sigma": svi_data["sigma"],
                }
                atm_iv = td_core.svi_iv(svi_params, 0.0, t)
            if not atm_iv or atm_iv <= 0:
                nearest_leg = min(legs, key=lambda leg: abs(leg.strike - spot))
                is_call = nearest_leg.option_type in ("C", "CE")
                with suppress(Exception):
                    atm_iv = td_core.implied_volatility(
                        nearest_leg.premium,
                        spot,
                        nearest_leg.strike,
                        t,
                        risk_free_rate,
                        is_call,
                    )
            if atm_iv and atm_iv > 0.01:
                forward = spot * math.exp(risk_free_rate * t)
                sigma_sqrt_t = atm_iv * math.sqrt(t)
                bsm_density = []
                for s in payoff_x:
                    if s <= 0:
                        bsm_density.append(0.0)
                    else:
                        d = (math.log(s / forward) + 0.5 * atm_iv**2 * t) / sigma_sqrt_t
                        phi = math.exp(-0.5 * d * d) / math.sqrt(2 * math.pi)
                        bsm_density.append(phi / (s * sigma_sqrt_t))

                market_pop = round(td_core.compute_pop(payoff_x, bsm_density, payoff_y), 4)
                pop_edge = round(risk_neutral_pop - market_pop, 4)
        except Exception:
            log.debug(
                "risk.strategy_market_pop_failed",
                underlying=underlying,
                expiry=expiry,
                exc_info=True,
            )

    regime_snapshot: RegimeSnapshot | None = None
    trade_quality: TradeQualityAssessment | None = None
    if underlying and expiry and redis_url:
        vrp_data = await load_cached_vrp(redis_url, underlying)
        daily_expected_move_pct = None
        if spot and spot > 0 and t is not None:
            tail_risk = compute_expected_move(spot, vrp_data.atm_iv if vrp_data else None, t)
            daily_expected_move_pct = tail_risk.daily_expected_move_pct
        regime_snapshot = await build_regime_snapshot(
            redis_url=redis_url,
            underlying=underlying,
            expiry=expiry,
            spot=spot,
            atm_iv=vrp_data.atm_iv if vrp_data else None,
            iv_rank=vrp_data.iv_rank if vrp_data else None,
            vrp=vrp_data.vrp if vrp_data else None,
            daily_expected_move_pct=daily_expected_move_pct,
        )
        trade_quality = build_trade_quality(
            style=infer_trade_style_from_legs(legs),
            regime_snapshot=regime_snapshot,
            pop_edge=pop_edge,
        )

    net = net_credit
    initial_margin = round(
        sum(leg.strike * leg.quantity for leg in legs if leg.side == "SELL") * 0.15, 2
    )
    maintenance_margin = round(initial_margin * 0.75, 2)
    collateral_utilization = (
        min(initial_margin / (spot * 100), 1.0) if spot and spot > 0 and initial_margin > 0 else 0.0
    )

    return StrategyResult(
        legs=legs,
        net_credit=round(net, 2),
        max_profit=max_profit,
        max_loss=max_loss,
        breakeven_points=breakevens,
        probability_of_profit=round(pop, 4),
        margin=MarginInfo(
            initial_margin=initial_margin,
            maintenance_margin=maintenance_margin,
            collateral_utilization=collateral_utilization,
        ),
        payoff_x=payoff_x,
        payoff_y=payoff_y,
        risk_neutral_pop=risk_neutral_pop,
        vg_pop=vg_pop,
        density_x=density_x,
        density_y=density_y,
        var_5=var_5,
        es_5=es_5,
        market_pop=market_pop,
        pop_edge=pop_edge,
        regime_snapshot=regime_snapshot,
        trade_quality=trade_quality,
    )


def aggregate_exposures(
    positions: list[dict[str, Any]], greeks: dict[str, dict[str, Any]]
) -> GreekExposure:
    totals = GreekExposure()
    for pos in positions:
        qty = _safe_int(pos.get("quantity")) or _safe_int(pos.get("netQty")) or 0
        if qty == 0:
            continue
        sign = 1 if qty > 0 else -1
        symbol = str(pos.get("symbol", ""))
        g = greeks.get(symbol, {})
        totals.delta += sign * (_safe_float(g.get("delta")) or 0.0)
        totals.gamma += sign * (_safe_float(g.get("gamma")) or 0.0)
        totals.theta += sign * (_safe_float(g.get("theta")) or 0.0)
        totals.vega += sign * (_safe_float(g.get("vega")) or 0.0)
        totals.vanna += sign * (_safe_float(g.get("vanna")) or 0.0)
        totals.charm += sign * (_safe_float(g.get("charm")) or 0.0)
        totals.vomma += sign * (_safe_float(g.get("vomma")) or 0.0)
    return totals


def _fmt_money(value: float | None) -> str:
    if value is None:
        return "n/a"
    sign = "+" if value > 0 else "-" if value < 0 else ""
    return f"{sign}Rs {abs(value):,.0f}"


def _fmt_pct(value: float | None, *, scale: float = 1.0, digits: int = 1) -> str:
    if value is None:
        return "n/a"
    return f"{value * scale:.{digits}f}%"


def _fmt_units(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{digits}f}"


def _earliest_expiry(
    expiries: list[ExpiryRiskSummary],
) -> ExpiryRiskSummary | None:
    dated = [item for item in expiries if item.dte is not None]
    if dated:
        return min(dated, key=lambda item: item.dte or 0)
    return expiries[0] if expiries else None


def _build_underlying_suggestions(
    *,
    underlying: str,
    exposures: GreekExposure,
    tail_risk: StrategyTailRisk,
    expiries: list[ExpiryRiskSummary],
    risk_level: RiskSeverity,
    account_net: float | None,
    margin_estimate: float | None,
    margin_utilization: float | None,
    trade_quality: TradeQualityAssessment | None = None,
) -> list[AdjustmentSuggestion]:
    suggestions: list[AdjustmentSuggestion] = []
    spot = tail_risk.spot
    earliest = _earliest_expiry(expiries)

    if spot and abs(exposures.delta) >= 10:
        delta_1pct_pnl = exposures.delta * spot * 0.01
        ratio = (
            abs(delta_1pct_pnl) / account_net
            if account_net and account_net > 0
            else None
        )
        severity = "high" if ratio and ratio >= 0.02 else "elevated"
        hedge_units = max(int(round(abs(exposures.delta))), 1)
        hedge_side = "sell" if exposures.delta > 0 else "buy"
        suggestions.append(
            AdjustmentSuggestion(
                rule_id="delta_hedge",
                severity=severity,
                title="Trim directional delta",
                rationale=(
                    f"{underlying} carries {_fmt_units(exposures.delta)} net delta. "
                    f"A 1% move changes P&L by about {_fmt_money(delta_1pct_pnl)}."
                ),
                action=(
                    f"{hedge_side.capitalize()} roughly {hedge_units} delta-equivalent "
                    "underlying units or futures to bring the book closer to flat."
                ),
                estimated_impact=(
                    f"Reduces 1% directional P&L swing by about {_fmt_money(delta_1pct_pnl)}."
                ),
                confidence="high" if ratio is not None else "medium",
                prerequisites=["Confirm hedge instrument liquidity and lot size mapping."],
                underlying=underlying,
            )
        )

    if (
        earliest is not None
        and earliest.dte is not None
        and exposures.gamma < 0
        and (
            earliest.dte <= 7
            or (
                tail_risk.projected_delta_down is not None
                and tail_risk.projected_delta_up is not None
                and tail_risk.projected_delta_down * tail_risk.projected_delta_up < 0
            )
        )
    ):
        severity = "critical" if earliest.dte <= 3 else "high"
        projected = (
            f"1-sigma delta shifts from {_fmt_units(exposures.delta)} to "
            f"{_fmt_units(tail_risk.projected_delta_down)} / {_fmt_units(tail_risk.projected_delta_up)}."
            if tail_risk.projected_delta_down is not None
            and tail_risk.projected_delta_up is not None
            else "Short gamma can accelerate directional risk on routine spot moves."
        )
        suggestions.append(
            AdjustmentSuggestion(
                rule_id="reduce_short_gamma_front_expiry",
                severity=severity,
                title="Reduce front-expiry short gamma",
                rationale=(
                    f"{underlying} is short gamma into {earliest.expiry} with {earliest.dte} DTE. "
                    f"{projected}"
                ),
                action=(
                    f"Reduce or roll the shortest-dated short premium in {underlying}, "
                    "or add long wings in the front expiry."
                ),
                estimated_impact=(
                    "Lowers delta flip risk and reduces re-hedging pressure on a normal move."
                ),
                confidence="high",
                prerequisites=["Check fill quality in the nearest expiry before rolling size."],
                underlying=underlying,
                expiry=earliest.expiry,
            )
        )

    if exposures.vega < 0 and exposures.vomma < 0:
        severity = (
            "high"
            if tail_risk.iv_rank is None or tail_risk.iv_rank < 70
            else "elevated"
        )
        vanna_context = (
            f" Cross-risk is amplified by vanna at {_fmt_units(exposures.vanna)}."
            if abs(exposures.vanna) >= 8
            else ""
        )
        suggestions.append(
            AdjustmentSuggestion(
                rule_id="add_vol_convexity",
                severity=severity,
                title="Add long vol convexity",
                rationale=(
                    f"{underlying} is short vega ({_fmt_units(exposures.vega)}) with negative "
                    f"vomma ({_fmt_units(exposures.vomma)}). Vega can worsen if IV expands."
                    f"{vanna_context}"
                ),
                action=(
                    "Shift some short premium into calendars or defined-risk wings, "
                    "or reduce naked short-vol size."
                ),
                estimated_impact=(
                    "Cuts vol-shock acceleration and improves behavior during IV expansion."
                ),
                confidence="medium",
                prerequisites=["Prefer structures that preserve carry while adding convexity."],
                underlying=underlying,
            )
        )

    if margin_utilization is not None and margin_utilization >= 0.05 and margin_estimate is not None:
        suggestions.append(
            AdjustmentSuggestion(
                rule_id="reduce_margin_usage",
                severity="high" if margin_utilization >= 0.1 else "elevated",
                title="Free up margin headroom",
                rationale=(
                    f"{underlying} uses {_fmt_pct(margin_utilization, scale=100.0)} of Net Liq "
                    f"on an estimated margin of {_fmt_money(margin_estimate)}."
                ),
                action=(
                    "Reduce the highest-margin short structures first or move risk into "
                    "defined-risk spreads."
                ),
                estimated_impact=(
                    "Improves operational headroom for hedging and reduces forced adjustment risk."
                ),
                confidence="medium",
                prerequisites=["Confirm broker margin offsets before replacing structures."],
                underlying=underlying,
            )
        )

    if risk_level == "safe":
        return []
    # Stamp each suggestion with the quality rank for downstream sorting.
    quality_score = trade_quality.overall_score if trade_quality else None
    for item in suggestions:
        item.quality_rank = quality_score
    return suggestions


def _build_portfolio_suggestions(
    *,
    underlyings: list[UnderlyingRiskSummary],
    account_net: float | None,
    available_margin: float | None,
) -> list[AdjustmentSuggestion]:
    suggestions: list[AdjustmentSuggestion] = []
    total_margin_estimate = sum(item.margin_estimate or 0.0 for item in underlyings)

    for item in underlyings:
        if total_margin_estimate <= 0 or not item.margin_estimate:
            continue
        concentration = item.margin_estimate / total_margin_estimate
        if concentration < 0.35:
            continue
        suggestions.append(
            AdjustmentSuggestion(
                rule_id="reduce_concentration",
                severity="high" if concentration >= 0.5 else "elevated",
                title="Reduce single-name concentration",
                rationale=(
                    f"{item.underlying} represents {_fmt_pct(concentration, scale=100.0)} "
                    "of current estimated portfolio margin."
                ),
                action=(
                    f"Trim or spread {item.underlying} exposure before adding new directional "
                    "or short-vol risk."
                ),
                estimated_impact=(
                    "Reduces concentration risk and makes portfolio-level P&L less path-dependent."
                ),
                confidence="high",
                prerequisites=["Keep the hedge in the same underlying unless you add explicit beta normalization."],
                underlying=item.underlying,
            )
        )

    if (
        account_net is not None
        and account_net > 0
        and available_margin is not None
        and (available_margin / account_net) <= 0.15
    ):
        suggestions.append(
            AdjustmentSuggestion(
                rule_id="preserve_margin_headroom",
                severity="critical" if (available_margin / account_net) <= 0.08 else "high",
                title="Preserve margin headroom",
                rationale=(
                    f"Available margin is {_fmt_money(available_margin)}, "
                    f"only {_fmt_pct(available_margin / account_net, scale=100.0)} of Net Liq."
                ),
                action=(
                    "Reduce highest-margin exposures before adding hedges that require more capital."
                ),
                estimated_impact=(
                    "Improves resilience during gap moves and reduces the chance of forced broker action."
                ),
                confidence="high",
            )
        )

    for item in underlyings:
        suggestions.extend(item.suggestions)

    # Sort by severity first, then by quality rank (lower quality = higher priority)
    # within the same severity bucket, then alphabetically by title.
    suggestions.sort(
        key=lambda item: (
            _severity_rank(item.severity),
            -(item.quality_rank or 0),
            item.title,
        ),
        reverse=True,
    )
    return suggestions[:6]


async def build_portfolio_risk(
    positions: list[dict[str, Any]],
    *,
    redis_url: str,
    account_limits: dict[str, float | None] | None = None,
) -> PortfolioRiskResult:
    grouped = group_open_positions(positions)
    underlying_summaries: list[UnderlyingRiskSummary] = []
    portfolio_flags: list[RiskFlag] = []
    portfolio_exposures = GreekExposure()
    position_count = 0
    expiry_count = 0

    if account_limits is None:
        account_limits = await load_account_limits(redis_url)

    account_net = account_limits.get("net") if account_limits else None
    available_margin = account_limits.get("available_margin") if account_limits else None
    margin_used = account_limits.get("margin_used") if account_limits else None
    collateral = account_limits.get("collateral") if account_limits else None

    for underlying, expiry_map in sorted(grouped.items()):
        per_expiry: list[ExpiryRiskSummary] = []
        underlying_flags: list[RiskFlag] = []
        underlying_exposures = GreekExposure()
        reference_spot: float | None = None
        reference_atm_iv: float | None = None
        reference_iv_rank: float | None = None
        reference_vrp: float | None = None
        reference_t_years: float | None = None
        margin_estimate = 0.0
        strategy_result: StrategyResult | None = None
        combined_scenarios: dict[int, list[float]] = {}  # n -> [pnl_down_sum, pnl_up_sum, spot_down, spot_up]

        for expiry, expiry_positions in sorted(expiry_map.items()):
            position_count += len(expiry_positions)
            expiry_count += 1

            greeks_map = await load_cached_greeks(redis_url, underlying, expiry)
            snapshot = await load_cached_snapshot(redis_url, underlying, expiry)
            vrp = await load_cached_vrp(redis_url, underlying)
            spot = _safe_float(snapshot.get("underlyingPrice")) if snapshot else None
            if spot is None or spot <= 0:
                for g in greeks_map.values():
                    spot = _safe_float(g.get("underlying_price")) or _safe_float(
                        g.get("underlyingPrice")
                    )
                    if spot and spot > 0:
                        break

            dte = days_to_expiry(expiry, underlying=underlying) if expiry else None
            t_years = time_to_expiry_years(expiry, underlying=underlying) if expiry else None
            atm_iv = vrp.atm_iv if vrp else None
            iv_rank = vrp.iv_rank if vrp else None
            vrp_value = vrp.vrp if vrp else None

            if reference_spot is None and spot is not None:
                reference_spot = spot
            if reference_atm_iv is None and atm_iv is not None:
                reference_atm_iv = atm_iv
            if reference_iv_rank is None and iv_rank is not None:
                reference_iv_rank = iv_rank
            if reference_vrp is None and vrp_value is not None:
                reference_vrp = vrp_value
            if reference_t_years is None and t_years is not None:
                reference_t_years = t_years

            exposures = GreekExposure()
            expiry_margin_estimate = 0.0
            for pos in expiry_positions:
                qty = _safe_int(pos.get("quantity")) or _safe_int(pos.get("netQty")) or 0
                if qty == 0:
                    continue
                sign = 1 if qty > 0 else -1
                symbol = str(pos.get("symbol", ""))
                g = greeks_map.get(symbol, {})
                exposures.delta += sign * (_safe_float(g.get("delta")) or 0.0)
                exposures.gamma += sign * (_safe_float(g.get("gamma")) or 0.0)
                exposures.theta += sign * (_safe_float(g.get("theta")) or 0.0)
                exposures.vega += sign * (_safe_float(g.get("vega")) or 0.0)
                exposures.vanna += sign * (_safe_float(g.get("vanna")) or 0.0)
                exposures.charm += sign * (_safe_float(g.get("charm")) or 0.0)
                exposures.vomma += sign * (_safe_float(g.get("vomma")) or 0.0)
                expiry_margin_estimate += max(
                    (_safe_float(pos.get("strikePrice")) or 0.0) * abs(qty) * 0.15, 0.0
                )

            portfolio_exposures.delta += exposures.delta
            portfolio_exposures.gamma += exposures.gamma
            portfolio_exposures.theta += exposures.theta
            portfolio_exposures.vega += exposures.vega
            portfolio_exposures.vanna += exposures.vanna
            portfolio_exposures.charm += exposures.charm
            portfolio_exposures.vomma += exposures.vomma
            underlying_exposures.delta += exposures.delta
            underlying_exposures.gamma += exposures.gamma
            underlying_exposures.theta += exposures.theta
            underlying_exposures.vega += exposures.vega
            underlying_exposures.vanna += exposures.vanna
            underlying_exposures.charm += exposures.charm
            underlying_exposures.vomma += exposures.vomma
            margin_estimate += expiry_margin_estimate

            tail_risk = compute_expected_move(spot, atm_iv, t_years)
            tail_risk.iv_rank = iv_rank
            tail_risk.vrp = vrp_value

            # Full BSM reprice at ±1/2/3σ scenario spots
            expiry_scenarios: dict[int, ScenarioPnl] = {}
            if spot and spot > 0 and atm_iv and atm_iv > 0 and t_years and t_years > 0:
                expiry_scenarios = compute_scenario_pnl(
                    positions=expiry_positions,
                    greeks_map=greeks_map,
                    spot=spot,
                    atm_iv=atm_iv,
                    t_years=t_years,
                    underlying=underlying,
                )

            exp_strategy = await build_strategy_result(
                make_strategy_legs(expiry_positions, spot=spot),
                underlying=underlying,
                expiry=expiry,
                spot=spot,
                redis_url=redis_url,
            )
            if exp_strategy is not None:
                strategy_result = strategy_result or exp_strategy

            severity, flags = classify_tail_risk(
                exposures=exposures,
                tail_risk=tail_risk,
                account_net=account_net,
                expiry_count=1,
                scenario_pnls=expiry_scenarios,
            )
            if severity != "safe":
                underlying_flags.extend(flags)

            # Accumulate per-expiry scenario P&L for underlying-level combined view.
            # Spot levels use the earliest expiry (sorted ascending) — most risk-relevant.
            for n, sc in expiry_scenarios.items():
                if n not in combined_scenarios:
                    combined_scenarios[n] = [0.0, 0.0, sc.spot_down, sc.spot_up]
                combined_scenarios[n][0] += sc.pnl_down
                combined_scenarios[n][1] += sc.pnl_up

            per_expiry.append(
                ExpiryRiskSummary(
                    underlying=underlying,
                    expiry=expiry,
                    spot=spot,
                    dte=dte,
                    position_count=len(expiry_positions),
                    lot_notional=expiry_margin_estimate if expiry_margin_estimate > 0 else None,
                    exposures=exposures,
                    tail_risk=tail_risk,
                    risk_level=severity,
                    flags=flags,
                    strategy=exp_strategy,
                )
            )

        combined_tail = compute_expected_move(reference_spot, reference_atm_iv, reference_t_years)
        combined_tail.iv_rank = reference_iv_rank
        combined_tail.vrp = reference_vrp

        # Build combined scenario P&L across all expiries
        combined_scenario_pnls: dict[int, ScenarioPnl] = {}
        for n, (pnl_down, pnl_up, spot_down, spot_up) in combined_scenarios.items():
            combined_scenario_pnls[n] = ScenarioPnl(
                spot_down=round(spot_down, 2),
                spot_up=round(spot_up, 2),
                pnl_down=round(pnl_down, 2),
                pnl_up=round(pnl_up, 2),
                worst_pnl=round(min(pnl_down, pnl_up), 2),
            )

        combined_severity, combined_flags = classify_tail_risk(
            exposures=underlying_exposures,
            tail_risk=combined_tail,
            account_net=account_net,
            expiry_count=len(per_expiry),
            scenario_pnls=combined_scenario_pnls,
        )

        if combined_severity != "safe":
            underlying_flags.extend(combined_flags)
        underlying_flags = _dedupe_flags(underlying_flags)

        if account_net and account_net > 0 and margin_estimate > 0:
            margin_utilization = margin_estimate / account_net
            if margin_utilization >= 0.1:
                combined_severity = _worst_severity(combined_severity, "critical")
            elif margin_utilization >= 0.05:
                combined_severity = _worst_severity(combined_severity, "high")
            elif margin_utilization >= 0.02:
                combined_severity = _worst_severity(combined_severity, "elevated")
        else:
            margin_utilization = None

        if len(per_expiry) == 1 and per_expiry[0].strategy is not None:
            strategy_result = per_expiry[0].strategy

        reference_expiry = min(
            (item.expiry for item in per_expiry if item.expiry),
            default=None,
        )
        regime_snapshot = await build_regime_snapshot(
            redis_url=redis_url,
            underlying=underlying,
            expiry=reference_expiry,
            spot=reference_spot,
            atm_iv=reference_atm_iv,
            iv_rank=reference_iv_rank,
            vrp=reference_vrp,
            daily_expected_move_pct=combined_tail.daily_expected_move_pct,
        )
        trade_quality = build_trade_quality(
            style=infer_trade_style(
                exposures=underlying_exposures,
                expiry_count=len(per_expiry),
                leg_count=sum(item.position_count for item in per_expiry),
            ),
            regime_snapshot=regime_snapshot,
            pop_edge=strategy_result.pop_edge if strategy_result is not None else None,
        )

        underlying_suggestions = _build_underlying_suggestions(
            underlying=underlying,
            exposures=underlying_exposures,
            tail_risk=combined_tail,
            expiries=per_expiry,
            risk_level=combined_severity,
            account_net=account_net,
            margin_estimate=margin_estimate if margin_estimate > 0 else None,
            margin_utilization=margin_utilization,
            trade_quality=trade_quality,
        )

        underlying_summaries.append(
            UnderlyingRiskSummary(
                underlying=underlying,
                spot=reference_spot,
                atm_iv=reference_atm_iv,
                iv_rank=reference_iv_rank,
                vrp=reference_vrp,
                position_count=sum(item.position_count for item in per_expiry),
                expiry_count=len(per_expiry),
                exposures=underlying_exposures,
                tail_risk=combined_tail,
                risk_level=combined_severity,
                flags=underlying_flags,
                suggestions=underlying_suggestions,
                regime_snapshot=regime_snapshot,
                trade_quality=trade_quality,
                expiries=per_expiry,
                strategy=strategy_result,
                margin_estimate=margin_estimate if margin_estimate > 0 else None,
                account_net_share=(margin_estimate / account_net)
                if account_net and account_net > 0
                else None,
                margin_utilization=margin_utilization,
            )
        )

    overall_severity: RiskSeverity = "safe"
    for underlying_summary in underlying_summaries:
        overall_severity = _worst_severity(overall_severity, underlying_summary.risk_level)

    if len(underlying_summaries) > 1:
        portfolio_flags.append(
            RiskFlag(
                code="mixed_underlyings",
                severity="elevated",
                title="Multiple underlyings",
                message=(
                    "Portfolio risk is aggregated across multiple underlyings; "
                    "risk is reported per underlying first."
                ),
            )
        )
        overall_severity = _worst_severity(overall_severity, "elevated")

    if account_net is None:
        portfolio_flags.append(
            RiskFlag(
                code="no_net_liq",
                severity="elevated",
                title="No Net Liq context",
                message="Account limits were unavailable, so risk normalization is unscaled.",
            )
        )

    portfolio_suggestions = _build_portfolio_suggestions(
        underlyings=underlying_summaries,
        account_net=account_net,
        available_margin=available_margin,
    )

    return PortfolioRiskResult(
        as_of=datetime.now(UTC),
        account_net=account_net,
        available_margin=available_margin,
        margin_used=margin_used,
        collateral=collateral,
        position_count=position_count,
        underlying_count=len(underlying_summaries),
        expiry_count=expiry_count,
        exposures=portfolio_exposures,
        risk_level=overall_severity,
        flags=portfolio_flags,
        suggestions=portfolio_suggestions,
        underlyings=underlying_summaries,
    )


def _dedupe_flags(flags: list[RiskFlag]) -> list[RiskFlag]:
    seen: set[tuple[str, str | None, str | None]] = set()
    unique: list[RiskFlag] = []
    for flag in flags:
        key = (flag.code, flag.underlying, flag.expiry)
        if key in seen:
            continue
        seen.add(key)
        unique.append(flag)
    return unique


def _compute_leg_greeks(
    spot: float,
    strike: float,
    t_years: float,
    premium: float,
    is_call: bool,
    risk_free_rate: float = _RISK_FREE_RATE,
) -> dict[str, float]:
    """Compute BSM Greeks for a leg using its market premium to back out IV."""
    try:
        import td_core

        iv = td_core.implied_volatility(premium, spot, strike, t_years, risk_free_rate, is_call)
        if iv is None or iv <= 0 or iv > 10.0:
            iv = 0.2  # fallback ATM estimate
        return {
            "iv": iv,
            "delta": td_core.bs_delta(spot, strike, t_years, risk_free_rate, iv, is_call),
            "gamma": td_core.bs_gamma(spot, strike, t_years, risk_free_rate, iv),
            "theta": td_core.bs_theta(spot, strike, t_years, risk_free_rate, iv, is_call),
            "vega": td_core.bs_vega(spot, strike, t_years, risk_free_rate, iv),
            "vanna": 0.0,
            "charm": 0.0,
            "vomma": 0.0,
        }
    except Exception:
        return {"iv": 0.0, "delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "vanna": 0.0, "charm": 0.0, "vomma": 0.0}


async def build_portfolio_risk_from_legs(
    legs: list[StrategyLeg],
    *,
    redis_url: str,
    risk_free_rate: float = _RISK_FREE_RATE,
) -> PortfolioRiskResult:
    """Build a PortfolioRiskResult from basket StrategyLegs without live positions.

    Greeks are computed inline via BSM (IV backed out from each leg's premium),
    so this works for hypothetical pre-trade risk preview without a broker session.
    Account limits are omitted — this is a what-if view only.
    """
    # Group legs by underlying → expiry
    grouped: dict[str, dict[str, list[StrategyLeg]]] = defaultdict(lambda: defaultdict(list))
    for leg in legs:
        und = (leg.underlying or "").upper()
        exp = normalize_expiry(leg.expiry or "")
        if not und or not exp:
            continue
        grouped[und][exp].append(leg)

    underlying_summaries: list[UnderlyingRiskSummary] = []
    portfolio_flags: list[RiskFlag] = []
    portfolio_exposures = GreekExposure()
    position_count = 0
    expiry_count = 0

    for underlying, expiry_map in sorted(grouped.items()):
        per_expiry: list[ExpiryRiskSummary] = []
        underlying_flags: list[RiskFlag] = []
        underlying_exposures = GreekExposure()
        reference_spot: float | None = None
        reference_atm_iv: float | None = None
        reference_iv_rank: float | None = None
        reference_vrp: float | None = None
        reference_t_years: float | None = None
        margin_estimate = 0.0
        strategy_result: StrategyResult | None = None
        combined_scenarios: dict[int, list[float]] = {}

        for expiry, expiry_legs in sorted(expiry_map.items()):
            position_count += len(expiry_legs)
            expiry_count += 1

            # Load market context from Redis
            vrp = await load_cached_vrp(redis_url, underlying)
            snapshot = await load_cached_snapshot(redis_url, underlying, expiry)

            spot: float | None = _safe_float(snapshot.get("underlyingPrice")) if snapshot else None
            if spot is None or spot <= 0:
                # Fallback: use spot from leg itself if provided
                for leg in expiry_legs:
                    if leg.spot and leg.spot > 0:
                        spot = leg.spot
                        break

            dte = days_to_expiry(expiry, underlying=underlying)
            t_years = time_to_expiry_years(expiry, underlying=underlying)
            atm_iv = vrp.atm_iv if vrp else None
            iv_rank = vrp.iv_rank if vrp else None
            vrp_value = vrp.vrp if vrp else None

            if reference_spot is None and spot is not None:
                reference_spot = spot
            if reference_atm_iv is None and atm_iv is not None:
                reference_atm_iv = atm_iv
            if reference_iv_rank is None and iv_rank is not None:
                reference_iv_rank = iv_rank
            if reference_vrp is None and vrp_value is not None:
                reference_vrp = vrp_value
            if reference_t_years is None:
                reference_t_years = t_years

            # Build inline Greeks for each leg
            greeks_map: dict[str, dict[str, Any]] = {}
            exposures = GreekExposure()
            expiry_margin_estimate = 0.0

            for leg in expiry_legs:
                signed_qty = leg.quantity if leg.side == "BUY" else -leg.quantity
                is_call = leg.option_type in ("C", "CE")

                if spot and spot > 0 and leg.premium > 0:
                    leg_greeks = _compute_leg_greeks(spot, leg.strike, t_years, leg.premium, is_call, risk_free_rate)
                else:
                    leg_greeks = {"iv": 0.0, "delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "vanna": 0.0, "charm": 0.0, "vomma": 0.0}

                greeks_map[leg.symbol] = {
                    "iv": leg_greeks["iv"],
                    "strike": leg.strike,
                    "optionType": "CE" if is_call else "PE",
                    "delta": leg_greeks["delta"],
                    "gamma": leg_greeks["gamma"],
                    "theta": leg_greeks["theta"],
                    "vega": leg_greeks["vega"],
                    "vanna": 0.0,
                    "charm": 0.0,
                    "vomma": 0.0,
                }

                exposures.delta += signed_qty * leg_greeks["delta"]
                exposures.gamma += signed_qty * leg_greeks["gamma"]
                exposures.theta += signed_qty * leg_greeks["theta"]
                exposures.vega += signed_qty * leg_greeks["vega"]
                expiry_margin_estimate += leg.strike * abs(signed_qty) * 0.15

            portfolio_exposures.delta += exposures.delta
            portfolio_exposures.gamma += exposures.gamma
            portfolio_exposures.theta += exposures.theta
            portfolio_exposures.vega += exposures.vega
            underlying_exposures.delta += exposures.delta
            underlying_exposures.gamma += exposures.gamma
            underlying_exposures.theta += exposures.theta
            underlying_exposures.vega += exposures.vega
            margin_estimate += expiry_margin_estimate

            tail_risk = compute_expected_move(spot, atm_iv, t_years)
            tail_risk.iv_rank = iv_rank
            tail_risk.vrp = vrp_value

            # Build position dicts for scenario repricing (reuse compute_scenario_pnl)
            position_dicts = [
                {
                    "symbol": leg.symbol,
                    "quantity": leg.quantity if leg.side == "BUY" else -leg.quantity,
                    "netQty": leg.quantity if leg.side == "BUY" else -leg.quantity,
                }
                for leg in expiry_legs
            ]

            expiry_scenarios: dict[int, ScenarioPnl] = {}
            if spot and spot > 0 and atm_iv and atm_iv > 0 and t_years > 0:
                expiry_scenarios = compute_scenario_pnl(
                    positions=position_dicts,
                    greeks_map=greeks_map,
                    spot=spot,
                    atm_iv=atm_iv,
                    t_years=t_years,
                    risk_free_rate=risk_free_rate,
                    underlying=underlying,
                )

            exp_strategy = await build_strategy_result(
                list(expiry_legs),
                underlying=underlying,
                expiry=expiry,
                spot=spot,
                redis_url=redis_url,
            )
            if exp_strategy is not None:
                strategy_result = strategy_result or exp_strategy

            severity, flags = classify_tail_risk(
                exposures=exposures,
                tail_risk=tail_risk,
                account_net=None,
                expiry_count=1,
                scenario_pnls=expiry_scenarios,
            )
            if severity != "safe":
                underlying_flags.extend(flags)

            for n, sc in expiry_scenarios.items():
                if n not in combined_scenarios:
                    combined_scenarios[n] = [0.0, 0.0, sc.spot_down, sc.spot_up]
                combined_scenarios[n][0] += sc.pnl_down
                combined_scenarios[n][1] += sc.pnl_up

            per_expiry.append(
                ExpiryRiskSummary(
                    underlying=underlying,
                    expiry=expiry,
                    spot=spot,
                    dte=dte,
                    position_count=len(expiry_legs),
                    lot_notional=expiry_margin_estimate if expiry_margin_estimate > 0 else None,
                    exposures=exposures,
                    tail_risk=tail_risk,
                    risk_level=severity,
                    flags=flags,
                    strategy=exp_strategy,
                )
            )

        combined_tail = compute_expected_move(reference_spot, reference_atm_iv, reference_t_years)
        combined_tail.iv_rank = reference_iv_rank
        combined_tail.vrp = reference_vrp

        combined_scenario_pnls: dict[int, ScenarioPnl] = {}
        for n, (pnl_down, pnl_up, spot_down, spot_up) in combined_scenarios.items():
            combined_scenario_pnls[n] = ScenarioPnl(
                spot_down=round(spot_down, 2),
                spot_up=round(spot_up, 2),
                pnl_down=round(pnl_down, 2),
                pnl_up=round(pnl_up, 2),
                worst_pnl=round(min(pnl_down, pnl_up), 2),
            )

        combined_severity, combined_flags = classify_tail_risk(
            exposures=underlying_exposures,
            tail_risk=combined_tail,
            account_net=None,
            expiry_count=len(per_expiry),
            scenario_pnls=combined_scenario_pnls,
        )

        if combined_severity != "safe":
            underlying_flags.extend(combined_flags)
        underlying_flags = _dedupe_flags(underlying_flags)

        if len(per_expiry) == 1 and per_expiry[0].strategy is not None:
            strategy_result = per_expiry[0].strategy

        reference_expiry = min(
            (item.expiry for item in per_expiry if item.expiry),
            default=None,
        )
        regime_snapshot = await build_regime_snapshot(
            redis_url=redis_url,
            underlying=underlying,
            expiry=reference_expiry,
            spot=reference_spot,
            atm_iv=reference_atm_iv,
            iv_rank=reference_iv_rank,
            vrp=reference_vrp,
            daily_expected_move_pct=combined_tail.daily_expected_move_pct,
        )
        trade_quality = build_trade_quality(
            style=infer_trade_style(
                exposures=underlying_exposures,
                expiry_count=len(per_expiry),
                leg_count=sum(item.position_count for item in per_expiry),
            ),
            regime_snapshot=regime_snapshot,
            pop_edge=strategy_result.pop_edge if strategy_result is not None else None,
        )

        underlying_suggestions = _build_underlying_suggestions(
            underlying=underlying,
            exposures=underlying_exposures,
            tail_risk=combined_tail,
            expiries=per_expiry,
            risk_level=combined_severity,
            account_net=None,
            margin_estimate=margin_estimate if margin_estimate > 0 else None,
            margin_utilization=None,
            trade_quality=trade_quality,
        )

        underlying_summaries.append(
            UnderlyingRiskSummary(
                underlying=underlying,
                spot=reference_spot,
                atm_iv=reference_atm_iv,
                iv_rank=reference_iv_rank,
                vrp=reference_vrp,
                position_count=sum(item.position_count for item in per_expiry),
                expiry_count=len(per_expiry),
                exposures=underlying_exposures,
                tail_risk=combined_tail,
                risk_level=combined_severity,
                flags=underlying_flags,
                suggestions=underlying_suggestions,
                regime_snapshot=regime_snapshot,
                trade_quality=trade_quality,
                expiries=per_expiry,
                strategy=strategy_result,
                margin_estimate=margin_estimate if margin_estimate > 0 else None,
            )
        )

    overall_severity: RiskSeverity = "safe"
    for u in underlying_summaries:
        overall_severity = _worst_severity(overall_severity, u.risk_level)

    if len(underlying_summaries) > 1:
        portfolio_flags.append(
            RiskFlag(
                code="mixed_underlyings",
                severity="elevated",
                title="Multiple underlyings",
                message=(
                    "Basket spans multiple underlyings; "
                    "risk is reported per underlying first."
                ),
            )
        )
        overall_severity = _worst_severity(overall_severity, "elevated")

    portfolio_suggestions = _build_portfolio_suggestions(
        underlyings=underlying_summaries,
        account_net=None,
        available_margin=None,
    )

    return PortfolioRiskResult(
        as_of=datetime.now(UTC),
        account_net=None,
        available_margin=None,
        margin_used=None,
        collateral=None,
        position_count=position_count,
        underlying_count=len(underlying_summaries),
        expiry_count=expiry_count,
        exposures=portfolio_exposures,
        risk_level=overall_severity,
        flags=portfolio_flags,
        suggestions=portfolio_suggestions,
        underlyings=underlying_summaries,
    )
