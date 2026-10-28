"""Broker-free scrip resolution for option order legs.

Resolves an option leg (``underlying``/``expiry``/``strike``/``option_type`` or a
raw ``trading_symbol``) into the trading symbol, numeric token, exchange segment,
and the cache-compatible symbol used as the Redis LTP key
(``cache:ltp:{symbol}``).

This module imports **no broker code** — it only reads the scrip caches that the
market-data service populates.  It is used by the paper-trading router so the
paper path never touches ``routers/orders.py`` (which constructs the live Kotak
client).  Resolution logic mirrors ``orders.py::_resolve_order_legs``.
"""

from __future__ import annotations

import re
from typing import Any, Protocol

import structlog

logger = structlog.get_logger()


class OrderLegLike(Protocol):
    trading_symbol: str | None
    underlying: str | None
    expiry: str | None
    strike: float | None
    option_type: str | None
    transaction_type: str
    quantity: int | None
    lots: int | None
    order_type: str
    product: str
    price: float
    trigger_price: float
    tag: str | None


def _strike_key(strike: float) -> int | float:
    """Match the scrip-cache field encoding: drop ``.0`` for whole strikes."""
    return int(strike) if strike == int(strike) else strike


def build_cache_symbol(underlying: str, expiry: str, strike: float, option_type: str) -> str | None:
    """Build the cache-compatible LTP symbol, e.g. ``"NIFTY 260319 23800 CE"``.

    ``expiry`` is the ISO date (``"2026-03-19"``) the frontend sends; it is
    compacted to ``YYMMDD``.  Matches ``scrip_master`` symbol construction.
    """
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", expiry or "")
    if not m:
        return None
    yy, mm, dd = m.group(1)[2:], m.group(2), m.group(3)
    strike_str = str(_strike_key(strike))
    return f"{underlying.upper()} {yy}{mm}{dd} {strike_str} {option_type}"


async def resolve_order_legs(
    orders: list[OrderLegLike],
    redis_url: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Resolve legs to trading symbol / token / segment / cache symbol.

    Returns ``(resolved, errors)`` where ``errors`` are ``{"index", "error"}``
    dicts.  No broker dependency — only Redis scrip caches and the instrument
    master are consulted.
    """
    from shared.instruments import get_instrument_master, order_quantity_from_lots
    from shared.redis_client import get_redis

    im = get_instrument_master()
    resolved: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for i, leg in enumerate(orders):
        trading_symbol = leg.trading_symbol
        underlying = leg.underlying
        scrip_token = ""
        cache_symbol: str | None = None

        if not trading_symbol:
            if not (leg.underlying and leg.expiry and leg.strike and leg.option_type):
                errors.append({
                    "index": i,
                    "error": "Missing required fields: underlying, expiry, strike, option_type",
                })
                continue
            underlying = leg.underlying.upper()
            field = f"{_strike_key(leg.strike)}:{leg.option_type}"
            async with get_redis(redis_url) as redis_client:
                trading_symbol = await redis_client.hget(
                    f"cache:scrip:trdsym:{underlying}:{leg.expiry}", field
                )
                scrip_token = await redis_client.hget(
                    f"cache:scrip:token:{underlying}:{leg.expiry}", field
                ) or ""
            if not trading_symbol:
                errors.append({
                    "index": i,
                    "error": f"Trading symbol not found for {underlying} {leg.expiry} "
                             f"{_strike_key(leg.strike)} {leg.option_type}",
                })
                continue
            cache_symbol = build_cache_symbol(
                underlying, leg.expiry, leg.strike, leg.option_type
            )
        else:
            m = re.match(r"^([A-Z]+)", trading_symbol)
            if m:
                underlying = m.group(1)
            async with get_redis(redis_url) as redis_client:
                scrip_token = await redis_client.hget("cache:scrip:sym2tok", trading_symbol) or ""
            # Build the cache symbol from the option fields when present (e.g.
            # square-off / modify legs that carry both trading_symbol AND
            # underlying/expiry/strike/option_type). The LTP cache is keyed by
            # the cache symbol, NOT the trading symbol, so this is required for
            # the paper-fill price lookup to succeed.
            if leg.underlying and leg.expiry and leg.strike and leg.option_type:
                cache_symbol = build_cache_symbol(
                    leg.underlying, leg.expiry, leg.strike, leg.option_type
                )

        cfg = im.get(underlying or "")
        exchange_segment = cfg.segment if cfg else ""
        if not exchange_segment:
            # Untracked underlying (e.g. an NSE stock option being squared
            # off). Every configured underlying — including MCX — resolves
            # above, so this never routes a commodity to nse_fo.
            logger.warning("scrip_resolve.segment_fallback", underlying=underlying,
                           trading_symbol=trading_symbol)
            exchange_segment = "nse_fo"

        quantity, qty_error = await order_quantity_from_lots(
            # getattr: older callers pass leg objects without a lots field
            redis_url, underlying, leg.expiry, leg.quantity, getattr(leg, "lots", None),
        )
        if qty_error or quantity is None:
            errors.append({"index": i, "error": qty_error or "Invalid quantity"})
            continue

        resolved.append({
            "original_index": i,
            "trading_symbol": trading_symbol,
            # Cache symbol falls back to trading_symbol so the LTP lookup still
            # has a key for raw-trading-symbol legs (square-off path).
            "cache_symbol": cache_symbol or trading_symbol,
            "scrip_token": scrip_token,
            "exchange_segment": exchange_segment,
            "underlying": underlying,
            "expiry": leg.expiry,
            "strike": leg.strike,
            "option_type": leg.option_type,
            "transaction_type": leg.transaction_type,
            "quantity": quantity,
            "order_type": leg.order_type,
            "product": leg.product,
            "price": leg.price,
            "trigger_price": leg.trigger_price,
            "tag": leg.tag,
        })

    return resolved, errors
