"""Adjustment engine — generates concrete, scored position adjustment recommendations.

Scans the option chain for structure-aware adjustment candidates, evaluates each
against the current position using full strategy analysis, and ranks by an
efficiency metric that balances risk improvement against profit sacrifice.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any, Literal

import structlog

from shared.positions import load_positions
from shared.redis_client import cache_get
from shared.risk_analytics import (
    aggregate_exposures,
    build_strategy_result,
    infer_trade_style,
    load_account_limits,
    load_cached_greeks,
    load_cached_snapshot,
    load_underlying_expiries,
    make_strategy_legs,
    normalize_expiry,
    parse_position_symbol,
)
from shared.schemas.risk import (
    AdjustmentLeg,
    AdjustmentRecommendation,
    GreekExposure,
)
from shared.schemas.strategy import StrategyLeg

log = structlog.get_logger()

# ── Thresholds ──────────────────────────────────────────────────────────────

_MIN_EFFICIENCY = 1.5
_MAX_PROFIT_SACRIFICE = 0.40  # don't lose > 40% of max profit
_MAX_LOSS_INCREASE = 1.15  # don't increase max loss > 15%
_MAX_DEBIT_PCT = 0.05  # max debit as % of account net
_MIN_RISK_IMPROVEMENT = 0.02  # must improve risk by ≥ 2%
_MIN_BID = 0.5  # strike must have bid > this to be tradeable
_SPREAD_LIMIT = 0.10  # bid-ask spread must be < 10% of mid
_MIN_DTE = 3  # don't adjust positions < 3 DTE

PositionStructure = Literal[
    "iron_condor",
    "vertical_spread",
    "strangle",
    "straddle",
    "naked_short",
    "naked_long",
    "butterfly",
    "calendar",
    "mixed",
]


# ── Main entry point ───────────────────────────────────────────────────────


async def generate_adjustments(
    underlying: str,
    redis_url: str,
    db_url: str,
) -> list[AdjustmentRecommendation]:
    """Generate ranked adjustment recommendations for *underlying*."""
    target = underlying.upper()

    # 1. Load positions
    all_positions = await load_positions(db_url)
    positions = [
        p
        for p in all_positions
        if p.get("isOpen", True)
        and (int(p.get("quantity", 0) or 0) != 0 or int(p.get("netQty", 0) or 0) != 0)
        and parse_position_symbol(str(p.get("symbol", ""))).get("underlying") == target
    ]
    if not positions:
        return []

    # 2. Group by expiry, load greeks & chains
    expiry_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for pos in positions:
        parsed = parse_position_symbol(str(pos.get("symbol", "")))
        expiry = normalize_expiry(str(pos.get("expiry", "") or parsed.get("expiry") or ""))
        if expiry:
            expiry_groups[expiry].append(pos)

    if not expiry_groups:
        return []

    position_expiries = sorted(expiry_groups.keys())
    current_expiry = position_expiries[0]

    # Load all available expiries for this underlying
    available_expiries = await load_underlying_expiries(redis_url, target)
    next_expiry = _find_next_expiry(current_expiry, available_expiries)

    # Load greeks for each expiry
    all_greeks: dict[str, dict[str, Any]] = {}
    for expiry in position_expiries:
        greeks = await load_cached_greeks(redis_url, target, expiry)
        all_greeks.update(greeks)

    # Load chain snapshots
    chain = await load_cached_snapshot(redis_url, target, current_expiry)
    next_chain = await load_cached_snapshot(redis_url, target, next_expiry) if next_expiry else None

    if not chain:
        log.warning("adj_engine.no_chain", underlying=target, expiry=current_expiry)
        return []

    spot = chain.get("underlyingPrice", 0)
    if not spot or spot <= 0:
        return []

    # 3. Account limits
    limits = await load_account_limits(redis_url)
    account_net = (limits or {}).get("net") or 0

    # 4. Aggregate current greeks
    current_greeks = aggregate_exposures(positions, all_greeks)

    # 5. Build current strategy result for baseline
    current_legs = make_strategy_legs(positions, spot=spot)
    if not current_legs:
        return []
    current_result = await build_strategy_result(current_legs, redis_url=redis_url)
    if current_result is None:
        return []

    # 6. Detect structure & find risks
    structure = classify_position_structure(positions, all_greeks, spot)
    risks = _detect_risks(current_greeks, current_expiry, current_result)

    # 7. Generate candidates
    chain_strikes = _parse_chain_strikes(chain)
    next_chain_strikes = _parse_chain_strikes(next_chain) if next_chain else {}

    candidates: list[_Candidate] = []
    for risk in risks:
        new_candidates = _generate_candidates(
            risk=risk,
            structure=structure,
            positions=positions,
            greeks_map=all_greeks,
            chain_strikes=chain_strikes,
            next_chain_strikes=next_chain_strikes,
            current_expiry=current_expiry,
            next_expiry=next_expiry,
            spot=spot,
            underlying=target,
        )
        candidates.extend(new_candidates)

    if not candidates:
        return []

    # 8. Score and filter
    results: list[AdjustmentRecommendation] = []
    for candidate in candidates:
        rec = await _score_candidate(
            candidate=candidate,
            current_legs=current_legs,
            current_result=current_result,
            current_greeks=current_greeks,
            account_net=account_net,
            redis_url=redis_url,
        )
        if rec is not None:
            results.append(rec)

    # Sort by efficiency (best first) and return top 5
    results.sort(key=lambda r: r.efficiency_score, reverse=True)
    return results[:5]


# ── Position structure classification ──────────────────────────────────────


def classify_position_structure(
    positions: list[dict[str, Any]],
    greeks_map: dict[str, dict[str, Any]],
    spot: float,
) -> PositionStructure:
    """Identify the position structure from open legs."""
    legs: list[dict[str, Any]] = []
    for pos in positions:
        qty = int(pos.get("quantity", 0) or pos.get("netQty", 0) or 0)
        if qty == 0:
            continue
        parsed = parse_position_symbol(str(pos.get("symbol", "")))
        legs.append({
            "strike": parsed.get("strike") or 0,
            "option_type": parsed.get("option_type", ""),
            "side": "BUY" if qty > 0 else "SELL",
            "qty": abs(qty),
            "expiry": parsed.get("expiry", ""),
        })

    if not legs:
        return "mixed"

    expiries = {leg["expiry"] for leg in legs}
    if len(expiries) > 1:
        return "calendar"

    sells = [l for l in legs if l["side"] == "SELL"]
    buys = [l for l in legs if l["side"] == "BUY"]

    sell_calls = [l for l in sells if l["option_type"] == "CE"]
    sell_puts = [l for l in sells if l["option_type"] == "PE"]
    buy_calls = [l for l in buys if l["option_type"] == "CE"]
    buy_puts = [l for l in buys if l["option_type"] == "PE"]

    n_sells = len(sells)
    n_buys = len(buys)

    # Iron condor: sell call + sell put + buy call + buy put (4 legs)
    if sell_calls and sell_puts and buy_calls and buy_puts:
        return "iron_condor"

    # Strangle: short call + short put, no longs
    if sell_calls and sell_puts and not buys:
        if len(sells) == 2 and sells[0]["strike"] != sells[1]["strike"]:
            return "strangle"
        if len(sells) == 2 and sells[0]["strike"] == sells[1]["strike"]:
            return "straddle"
        return "strangle"

    # Vertical spread: 1 buy + 1 sell same type
    if n_sells == 1 and n_buys == 1:
        if sells[0]["option_type"] == buys[0]["option_type"]:
            return "vertical_spread"

    # Naked short
    if sells and not buys:
        return "naked_short"

    # Naked long
    if buys and not sells:
        return "naked_long"

    # Butterfly: 3 strikes with ratio
    if len(legs) >= 3:
        return "butterfly"

    return "mixed"


# ── Risk detection ─────────────────────────────────────────────────────────

_Risk = str  # "delta_high", "short_gamma", "short_vega", "near_expiry"


def _detect_risks(
    greeks: GreekExposure,
    current_expiry: str,
    result: Any,
) -> list[_Risk]:
    """Detect which risks should trigger adjustment candidates."""
    risks: list[_Risk] = []

    dte = _compute_dte(current_expiry)

    if abs(greeks.delta) >= 8:
        risks.append("delta_high")

    if greeks.gamma < 0 and dte is not None and dte <= 14:
        risks.append("short_gamma")

    if greeks.vega < 0 and greeks.vomma < 0:
        risks.append("short_vega")

    if dte is not None and dte <= 7:
        risks.append("near_expiry")

    # If no specific risk detected but position exists, offer generic adjustments
    if not risks and abs(greeks.delta) >= 3:
        risks.append("delta_high")

    return risks


# ── Candidate generation ──────────────────────────────────────────────────

class _Candidate:
    """A potential adjustment to evaluate."""

    __slots__ = ("title", "description", "action_type", "legs", "trigger")

    def __init__(
        self,
        title: str,
        description: str,
        action_type: str,
        legs: list[AdjustmentLeg],
        trigger: str,
    ) -> None:
        self.title = title
        self.description = description
        self.action_type = action_type
        self.legs = legs
        self.trigger = trigger


def _generate_candidates(
    *,
    risk: _Risk,
    structure: PositionStructure,
    positions: list[dict[str, Any]],
    greeks_map: dict[str, dict[str, Any]],
    chain_strikes: dict[float, _StrikeData],
    next_chain_strikes: dict[float, _StrikeData],
    current_expiry: str,
    next_expiry: str | None,
    spot: float,
    underlying: str,
) -> list[_Candidate]:
    """Generate candidate adjustments for a specific risk trigger."""
    candidates: list[_Candidate] = []

    # Extract position legs with greeks
    pos_legs = _extract_pos_legs(positions, greeks_map)

    if risk == "delta_high":
        candidates.extend(_candidates_delta_hedge(
            pos_legs, chain_strikes, current_expiry, spot, underlying,
        ))

    if risk in ("short_gamma", "near_expiry") and next_expiry:
        candidates.extend(_candidates_roll_expiry(
            pos_legs, next_chain_strikes, current_expiry, next_expiry, spot, underlying, risk,
        ))

    if risk == "short_vega" and structure in ("strangle", "naked_short"):
        candidates.extend(_candidates_add_wings(
            pos_legs, chain_strikes, current_expiry, spot, underlying,
        ))

    # Close partial — always available
    candidates.extend(_candidates_close_partial(
        pos_legs, chain_strikes, current_expiry, spot, underlying, risk,
    ))

    return candidates


class _PosLeg:
    __slots__ = ("symbol", "strike", "option_type", "side", "qty", "expiry", "delta", "premium")

    def __init__(self, symbol, strike, option_type, side, qty, expiry, delta, premium):
        self.symbol = symbol
        self.strike = strike
        self.option_type = option_type
        self.side = side
        self.qty = qty
        self.expiry = expiry
        self.delta = delta
        self.premium = premium


class _StrikeData:
    __slots__ = ("strike", "call_bid", "call_ask", "call_ltp", "put_bid", "put_ask", "put_ltp")

    def __init__(self, strike, call_bid, call_ask, call_ltp, put_bid, put_ask, put_ltp):
        self.strike = strike
        self.call_bid = call_bid
        self.call_ask = call_ask
        self.call_ltp = call_ltp
        self.put_bid = put_bid
        self.put_ask = put_ask
        self.put_ltp = put_ltp


def _extract_pos_legs(
    positions: list[dict[str, Any]], greeks_map: dict[str, dict[str, Any]]
) -> list[_PosLeg]:
    legs: list[_PosLeg] = []
    for pos in positions:
        qty = int(pos.get("quantity", 0) or pos.get("netQty", 0) or 0)
        if qty == 0:
            continue
        symbol = str(pos.get("symbol", ""))
        parsed = parse_position_symbol(symbol)
        g = greeks_map.get(symbol, {})
        legs.append(_PosLeg(
            symbol=symbol,
            strike=parsed.get("strike") or 0,
            option_type=parsed.get("option_type", ""),
            side="BUY" if qty > 0 else "SELL",
            qty=abs(qty),
            expiry=normalize_expiry(str(pos.get("expiry", "") or parsed.get("expiry") or "")),
            delta=float(g.get("delta") or 0),
            premium=float(pos.get("avgPrice", 0) or 0),
        ))
    return legs


def _parse_chain_strikes(chain: dict[str, Any] | None) -> dict[float, _StrikeData]:
    if not chain:
        return {}
    strikes: dict[float, _StrikeData] = {}
    for s in chain.get("strikes", []):
        strike_val = float(s.get("strike", 0))
        if strike_val <= 0:
            continue
        call = s.get("call") or {}
        put = s.get("put") or {}
        strikes[strike_val] = _StrikeData(
            strike=strike_val,
            call_bid=float(call.get("bid") or 0),
            call_ask=float(call.get("ask") or 0),
            call_ltp=float(call.get("ltp") or 0),
            put_bid=float(put.get("bid") or 0),
            put_ask=float(put.get("ask") or 0),
            put_ltp=float(put.get("ltp") or 0),
        )
    return strikes


def _is_liquid(bid: float, ask: float) -> bool:
    if bid < _MIN_BID:
        return False
    mid = (bid + ask) / 2
    if mid <= 0:
        return False
    return (ask - bid) / mid < _SPREAD_LIMIT


def _mid_price(bid: float, ask: float) -> float:
    if bid > 0 and ask > 0:
        return (bid + ask) / 2
    return max(bid, ask)


def _make_symbol(underlying: str, expiry: str, strike: float, opt_type: str) -> str:
    """Build normalized symbol like 'NIFTY 260319 23000 CE'."""
    dt = datetime.strptime(expiry, "%Y-%m-%d")
    compact = dt.strftime("%y%m%d")
    strike_str = str(int(strike)) if strike == int(strike) else str(strike)
    return f"{underlying} {compact} {strike_str} {opt_type}"


# ── Delta hedge candidates ────────────────────────────────────────────────


def _candidates_delta_hedge(
    pos_legs: list[_PosLeg],
    chain: dict[float, _StrikeData],
    expiry: str,
    spot: float,
    underlying: str,
) -> list[_Candidate]:
    """Generate delta-reducing candidates by selling/buying options."""
    candidates: list[_Candidate] = []
    net_delta = sum(
        (l.delta * l.qty if l.side == "BUY" else -l.delta * l.qty) for l in pos_legs
    )

    if abs(net_delta) < 3:
        return []

    # Determine: if delta positive, sell calls or buy puts; if negative, sell puts or buy calls
    if net_delta > 0:
        # Sell OTM calls or buy OTM puts
        targets = sorted(
            (s for s in chain.values() if s.strike > spot),
            key=lambda s: s.strike,
        )
        for sd in targets[:3]:
            # Option 1: Sell OTM call
            if _is_liquid(sd.call_bid, sd.call_ask):
                price = _mid_price(sd.call_bid, sd.call_ask)
                qty = max(1, pos_legs[0].qty) if pos_legs else 1
                leg = AdjustmentLeg(
                    symbol=_make_symbol(underlying, expiry, sd.strike, "CE"),
                    strike=sd.strike,
                    option_type="CE",
                    expiry=expiry,
                    side="SELL",
                    quantity=qty,
                    estimated_price=round(price, 2),
                    bid=sd.call_bid,
                    ask=sd.call_ask,
                )
                candidates.append(_Candidate(
                    title=f"Sell {int(sd.strike)} CE to reduce delta",
                    description=(
                        f"Net delta is +{net_delta:.1f}. Selling {int(sd.strike)} CE "
                        f"for ~{price:.1f} reduces upside delta exposure and collects credit."
                    ),
                    action_type="add_wing",
                    legs=[leg],
                    trigger="delta_high",
                ))
            # Option 2: Buy OTM put
            if sd.strike < spot and _is_liquid(sd.put_bid, sd.put_ask):
                price = _mid_price(sd.put_bid, sd.put_ask)
                qty = max(1, pos_legs[0].qty) if pos_legs else 1
                leg = AdjustmentLeg(
                    symbol=_make_symbol(underlying, expiry, sd.strike, "PE"),
                    strike=sd.strike,
                    option_type="PE",
                    expiry=expiry,
                    side="BUY",
                    quantity=qty,
                    estimated_price=round(price, 2),
                    bid=sd.put_bid,
                    ask=sd.put_ask,
                )
                candidates.append(_Candidate(
                    title=f"Buy {int(sd.strike)} PE to hedge delta",
                    description=(
                        f"Net delta is +{net_delta:.1f}. Buying {int(sd.strike)} PE "
                        f"adds negative delta protection at ~{price:.1f}."
                    ),
                    action_type="add_wing",
                    legs=[leg],
                    trigger="delta_high",
                ))
    else:
        # Negative delta — sell OTM puts or buy OTM calls
        targets = sorted(
            (s for s in chain.values() if s.strike < spot),
            key=lambda s: s.strike,
            reverse=True,
        )
        for sd in targets[:3]:
            if _is_liquid(sd.put_bid, sd.put_ask):
                price = _mid_price(sd.put_bid, sd.put_ask)
                qty = max(1, pos_legs[0].qty) if pos_legs else 1
                leg = AdjustmentLeg(
                    symbol=_make_symbol(underlying, expiry, sd.strike, "PE"),
                    strike=sd.strike,
                    option_type="PE",
                    expiry=expiry,
                    side="SELL",
                    quantity=qty,
                    estimated_price=round(price, 2),
                    bid=sd.put_bid,
                    ask=sd.put_ask,
                )
                candidates.append(_Candidate(
                    title=f"Sell {int(sd.strike)} PE to reduce delta",
                    description=(
                        f"Net delta is {net_delta:.1f}. Selling {int(sd.strike)} PE "
                        f"for ~{price:.1f} reduces downside delta exposure and collects credit."
                    ),
                    action_type="add_wing",
                    legs=[leg],
                    trigger="delta_high",
                ))

    return candidates


# ── Roll to next expiry candidates ────────────────────────────────────────


def _candidates_roll_expiry(
    pos_legs: list[_PosLeg],
    next_chain: dict[float, _StrikeData],
    current_expiry: str,
    next_expiry: str,
    spot: float,
    underlying: str,
    trigger: str,
) -> list[_Candidate]:
    """Roll short legs to next expiry for more theta & less gamma."""
    if not next_chain:
        return []

    candidates: list[_Candidate] = []
    short_legs = [l for l in pos_legs if l.side == "SELL" and l.expiry == current_expiry]

    for sl in short_legs:
        sd = next_chain.get(sl.strike)
        if sd is None:
            continue

        is_call = sl.option_type == "CE"
        old_bid = 0.0
        new_ask = 0.0
        if is_call:
            # Find current chain bid to close
            old_bid = sl.premium  # approximate with avg price
            new_ask = sd.call_ask
            new_bid = sd.call_bid
            new_mid = _mid_price(new_bid, new_ask)
            if not _is_liquid(new_bid, new_ask):
                continue
        else:
            old_bid = sl.premium
            new_ask = sd.put_ask
            new_bid = sd.put_bid
            new_mid = _mid_price(new_bid, new_ask)
            if not _is_liquid(new_bid, new_ask):
                continue

        # Roll = close current (BUY) + open next (SELL)
        close_leg = AdjustmentLeg(
            symbol=sl.symbol,
            strike=sl.strike,
            option_type=sl.option_type,
            expiry=current_expiry,
            side="BUY",
            quantity=sl.qty,
            estimated_price=round(sl.premium, 2),
            bid=0,
            ask=round(sl.premium * 1.05, 2),  # rough estimate
        )
        open_leg = AdjustmentLeg(
            symbol=_make_symbol(underlying, next_expiry, sl.strike, sl.option_type),
            strike=sl.strike,
            option_type=sl.option_type,
            expiry=next_expiry,
            side="SELL",
            quantity=sl.qty,
            estimated_price=round(new_mid, 2),
            bid=new_bid,
            ask=new_ask,
        )
        candidates.append(_Candidate(
            title=f"Roll {int(sl.strike)} {sl.option_type} to {next_expiry}",
            description=(
                f"Close {int(sl.strike)} {sl.option_type} in {current_expiry} and "
                f"reopen in {next_expiry} for ~{new_mid:.1f}. "
                "Reduces gamma risk and adds theta from longer DTE."
            ),
            action_type="roll",
            legs=[close_leg, open_leg],
            trigger=trigger,
        ))

    return candidates


# ── Add protective wings ──────────────────────────────────────────────────


def _candidates_add_wings(
    pos_legs: list[_PosLeg],
    chain: dict[float, _StrikeData],
    expiry: str,
    spot: float,
    underlying: str,
) -> list[_Candidate]:
    """Add long wings to cap tail risk on short positions."""
    candidates: list[_Candidate] = []
    short_legs = [l for l in pos_legs if l.side == "SELL"]

    existing_strikes = {(l.strike, l.option_type) for l in pos_legs}

    for sl in short_legs:
        is_call = sl.option_type == "CE"
        # Find strikes further OTM (2-5 strikes away)
        if is_call:
            wing_strikes = sorted(
                s for s in chain if s > sl.strike and (s, "CE") not in existing_strikes
            )[:4]
        else:
            wing_strikes = sorted(
                (s for s in chain if s < sl.strike and (s, "PE") not in existing_strikes),
                reverse=True,
            )[:4]

        for ws in wing_strikes:
            sd = chain.get(ws)
            if sd is None:
                continue
            if is_call:
                bid, ask = sd.call_bid, sd.call_ask
            else:
                bid, ask = sd.put_bid, sd.put_ask

            if not _is_liquid(bid, ask):
                continue

            price = _mid_price(bid, ask)
            leg = AdjustmentLeg(
                symbol=_make_symbol(underlying, expiry, ws, sl.option_type),
                strike=ws,
                option_type=sl.option_type,
                expiry=expiry,
                side="BUY",
                quantity=sl.qty,
                estimated_price=round(price, 2),
                bid=bid,
                ask=ask,
            )
            width = abs(ws - sl.strike)
            candidates.append(_Candidate(
                title=f"Buy {int(ws)} {sl.option_type} wing (width {int(width)})",
                description=(
                    f"Add {int(ws)} {sl.option_type} long to cap max loss on the "
                    f"short {int(sl.strike)} {sl.option_type}. "
                    f"Creates a defined-risk spread at ~{price:.1f} debit."
                ),
                action_type="add_wing",
                legs=[leg],
                trigger="short_vega",
            ))

    return candidates


# ── Close partial candidates ──────────────────────────────────────────────


def _candidates_close_partial(
    pos_legs: list[_PosLeg],
    chain: dict[float, _StrikeData],
    expiry: str,
    spot: float,
    underlying: str,
    trigger: str,
) -> list[_Candidate]:
    """Close a portion of the position to reduce exposure."""
    candidates: list[_Candidate] = []

    # Find the most delta-contributing legs
    sorted_legs = sorted(pos_legs, key=lambda l: abs(l.delta * l.qty), reverse=True)

    for leg in sorted_legs[:2]:
        if leg.qty <= 1:
            continue

        close_qty = max(1, leg.qty // 2)  # close ~50%
        close_side = "SELL" if leg.side == "BUY" else "BUY"

        sd = chain.get(leg.strike)
        if sd is None:
            continue

        is_call = leg.option_type == "CE"
        if close_side == "SELL":
            bid = sd.call_bid if is_call else sd.put_bid
            ask = sd.call_ask if is_call else sd.put_ask
        else:
            bid = sd.call_bid if is_call else sd.put_bid
            ask = sd.call_ask if is_call else sd.put_ask

        price = _mid_price(bid, ask)
        if price <= 0:
            continue

        adj_leg = AdjustmentLeg(
            symbol=leg.symbol,
            strike=leg.strike,
            option_type=leg.option_type,
            expiry=leg.expiry,
            side=close_side,
            quantity=close_qty,
            estimated_price=round(price, 2),
            bid=bid,
            ask=ask,
        )
        action = "close" if close_side == "BUY" else "trim"
        candidates.append(_Candidate(
            title=f"Close {close_qty}x {int(leg.strike)} {leg.option_type}",
            description=(
                f"Reduce {leg.side.lower()} position in {int(leg.strike)} {leg.option_type} "
                f"by {close_qty} lots at ~{price:.1f}. "
                "Proportionally reduces all greek exposures."
            ),
            action_type="close_partial",
            legs=[adj_leg],
            trigger=trigger,
        ))

    return candidates


# ── Scoring ───────────────────────────────────────────────────────────────


async def _score_candidate(
    *,
    candidate: _Candidate,
    current_legs: list[StrategyLeg],
    current_result: Any,
    current_greeks: GreekExposure,
    account_net: float,
    redis_url: str,
) -> AdjustmentRecommendation | None:
    """Score a candidate adjustment and return a recommendation, or None if filtered."""
    # Build the adjusted position: current legs + adjustment legs
    adjusted_legs = list(current_legs)
    for adj_leg in candidate.legs:
        adjusted_legs.append(StrategyLeg(
            symbol=adj_leg.symbol,
            strike=adj_leg.strike,
            option_type=adj_leg.option_type,
            side=adj_leg.side,
            quantity=adj_leg.quantity,
            premium=adj_leg.estimated_price,
            underlying=adj_leg.symbol.split()[0] if " " in adj_leg.symbol else None,
            expiry=adj_leg.expiry,
        ))

    # Evaluate adjusted position
    adjusted_result = await build_strategy_result(adjusted_legs, redis_url=redis_url)
    if adjusted_result is None:
        return None

    # Extract metrics
    old_max_loss = current_result.max_loss
    new_max_loss = adjusted_result.max_loss
    old_max_profit = current_result.max_profit
    new_max_profit = adjusted_result.max_profit
    old_pop = current_result.probability_of_profit
    new_pop = adjusted_result.probability_of_profit

    # Compute net credit/debit of the adjustment itself
    adj_credit = sum(
        leg.estimated_price * leg.quantity * (1 if leg.side == "SELL" else -1)
        for leg in candidate.legs
    )

    # Compute projected greeks (approximate: scale by leg deltas)
    projected_greeks = GreekExposure(
        delta=current_greeks.delta,
        gamma=current_greeks.gamma,
        theta=current_greeks.theta,
        vega=current_greeks.vega,
        vanna=current_greeks.vanna,
        charm=current_greeks.charm,
        vomma=current_greeks.vomma,
    )
    # Rough greek adjustments from the new legs
    for adj_leg in candidate.legs:
        sign = 1 if adj_leg.side == "BUY" else -1
        qty = adj_leg.quantity
        # Approximate delta from moneyness
        is_call = adj_leg.option_type == "CE"
        if adj_leg.estimated_price > 0:
            approx_delta = 0.5 * sign * qty  # rough placeholder
            projected_greeks.delta += approx_delta

    # ── Hard filters ──
    # Max loss increase
    if (
        old_max_loss is not None
        and new_max_loss is not None
        and old_max_loss < 0
        and new_max_loss < old_max_loss * _MAX_LOSS_INCREASE
    ):
        return None

    # Profit sacrifice
    profit_impact = 0.0
    if old_max_profit and old_max_profit > 0 and new_max_profit is not None:
        profit_impact = (new_max_profit - old_max_profit) / old_max_profit
        if profit_impact < -_MAX_PROFIT_SACRIFICE:
            return None

    # Debit too large
    if account_net > 0 and adj_credit < 0 and abs(adj_credit) > account_net * _MAX_DEBIT_PCT:
        return None

    # ── Compute efficiency ──
    risk_score = 0.0
    risk_components = 0

    # Max loss improvement
    if old_max_loss and old_max_loss < 0 and new_max_loss is not None:
        ml_improvement = (new_max_loss - old_max_loss) / abs(old_max_loss)
        risk_score += 0.35 * max(0, ml_improvement)
        risk_components += 1

    # Delta improvement
    old_abs_delta = abs(current_greeks.delta)
    new_abs_delta = abs(projected_greeks.delta)
    if old_abs_delta > 1:
        delta_improvement = (old_abs_delta - new_abs_delta) / old_abs_delta
        risk_score += 0.25 * max(0, delta_improvement)
        risk_components += 1

    # POP improvement
    if old_pop > 0 and new_pop > 0:
        pop_improvement = new_pop - old_pop
        risk_score += 0.20 * max(0, pop_improvement)
        risk_components += 1

    # VaR improvement
    old_var = current_result.var_5
    new_var = adjusted_result.var_5
    if old_var is not None and new_var is not None and old_var < 0:
        var_improvement = (new_var - old_var) / abs(old_var)
        risk_score += 0.20 * max(0, var_improvement)
        risk_components += 1

    # Minimum risk improvement check
    if risk_score < _MIN_RISK_IMPROVEMENT and risk_components > 0:
        return None

    # Cost score
    cost_score = 0.0
    if profit_impact < 0:
        cost_score += 0.50 * abs(profit_impact)
    if account_net > 0 and adj_credit < 0:
        cost_score += 0.30 * abs(adj_credit) / account_net
    # Slippage estimate
    slippage = sum(
        (leg.ask - leg.bid) * 0.5 * leg.quantity for leg in candidate.legs
    )
    if account_net > 0:
        cost_score += 0.20 * slippage / max(account_net, 1)

    # Credit bonus: if adjustment collects credit, reduce cost score
    if adj_credit > 0 and account_net > 0:
        cost_score = max(0, cost_score - 0.15 * adj_credit / account_net)

    # Efficiency
    if cost_score < 0.001:
        efficiency = risk_score * 100 if risk_score > 0 else 0.5
    else:
        efficiency = risk_score / cost_score

    if efficiency < _MIN_EFFICIENCY:
        return None

    # Risk impact %
    risk_impact = 0.0
    if old_max_loss and old_max_loss < 0 and new_max_loss is not None:
        risk_impact = ((new_max_loss - old_max_loss) / abs(old_max_loss)) * 100

    # Confidence
    confidence = "medium"
    if risk_components >= 3:
        confidence = "high"
    elif risk_components <= 1:
        confidence = "low"

    # Warnings
    warnings: list[str] = []
    if profit_impact < -0.1:
        warnings.append(f"Reduces max profit by {abs(profit_impact)*100:.0f}%")
    if adj_credit < 0:
        warnings.append(f"Costs Rs {abs(adj_credit):,.0f} net debit")
    for leg in candidate.legs:
        spread_pct = (leg.ask - leg.bid) / max(_mid_price(leg.bid, leg.ask), 0.01)
        if spread_pct > 0.05:
            warnings.append(f"{int(leg.strike)} {leg.option_type} has {spread_pct*100:.0f}% bid-ask spread")

    return AdjustmentRecommendation(
        id=str(uuid.uuid4())[:8],
        title=candidate.title,
        description=candidate.description,
        action_type=candidate.action_type,
        legs=candidate.legs,
        current_greeks=current_greeks,
        projected_greeks=projected_greeks,
        current_max_loss=round(old_max_loss, 2) if old_max_loss else None,
        projected_max_loss=round(new_max_loss, 2) if new_max_loss else None,
        current_pop=round(old_pop, 4) if old_pop else None,
        projected_pop=round(new_pop, 4) if new_pop else None,
        net_credit=round(adj_credit, 2),
        efficiency_score=round(efficiency, 2),
        profit_impact_pct=round(profit_impact * 100, 1),
        risk_impact_pct=round(risk_impact, 1),
        trigger=candidate.trigger,
        confidence=confidence,
        warnings=warnings,
    )


# ── Helpers ───────────────────────────────────────────────────────────────


def _compute_dte(expiry: str) -> int | None:
    try:
        exp_date = datetime.strptime(expiry, "%Y-%m-%d").replace(tzinfo=UTC)
        now = datetime.now(UTC)
        return max(0, (exp_date - now).days)
    except (ValueError, TypeError):
        return None


def _find_next_expiry(current: str, available: list[str]) -> str | None:
    for exp in available:
        if exp > current:
            return exp
    return None
