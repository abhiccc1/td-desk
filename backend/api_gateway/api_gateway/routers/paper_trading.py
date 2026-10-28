"""Paper-trading routes — SIMULATED order placement, fully isolated from live.

SAFETY: this module deliberately imports **no broker code** — no
``neo_api_client``, no ``shared.live_session``, no ``_get_neo_client``, and
nothing from ``routers/orders.py``.  Paper orders can therefore never reach the
Kotak broker.  Fills are simulated at the live LTP read from the Redis
``cache:ltp`` key and recorded in the ``paper_positions`` / ``paper_trade_logs``
tables.  A unit test enforces the no-broker-import invariant.
"""

from __future__ import annotations

import json as _json
import uuid

import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from api_gateway.config import settings

router = APIRouter(prefix="/api/v1/paper", tags=["paper-trading"])
log = structlog.get_logger()


class PaperOrderLeg(BaseModel):
    trading_symbol: str | None = None
    underlying: str | None = None
    expiry: str | None = None
    strike: float | None = None
    option_type: str | None = None  # "CE" or "PE"
    transaction_type: str  # "B" or "S"
    # Send either quantity (units) or lots; with lots the backend converts
    # using its own lot size. Both → must agree.
    quantity: int | None = Field(default=None, ge=1)
    lots: int | None = Field(default=None, ge=1)
    order_type: str = "MKT"  # "L", "MKT", "SL", "SL-M"
    product: str = "NRML"
    price: float = 0
    trigger_price: float = 0
    disclosed_quantity: int = 0
    tag: str | None = None


class PaperOrdersRequest(BaseModel):
    orders: list[PaperOrderLeg]


class PaperOrderResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    index: int
    success: bool
    order_number: str | None = None
    error: str | None = None
    trading_symbol: str | None = None
    fill_price: float | None = None




async def _resolve_ltp(cache_symbol: str) -> float | None:
    """Read the live LTP for a symbol from Redis (same keys as live positions)."""
    from shared.redis_client import cache_get

    raw = await cache_get(settings.redis_url, f"cache:ltp:{cache_symbol}")
    if not raw:
        raw = await cache_get(settings.redis_url, f"cache:lkgv:{cache_symbol}")
    if not raw:
        return None
    try:
        ltp = float(_json.loads(raw).get("ltp", 0))
    except (ValueError, _json.JSONDecodeError, AttributeError):
        return None
    return ltp if ltp > 0 else None


@router.post("/place-orders")
async def place_paper_orders(body: PaperOrdersRequest) -> list[PaperOrderResult]:
    """Place one or more SIMULATED orders.

    Each leg fills instantly at the current live LTP from the option chain.  No
    broker is contacted.  Legs without an available live price are rejected.
    """
    from shared.instruments import exchange_from_segment, get_instrument_master
    from shared.paper_trading import apply_paper_fill
    from shared.redis_client import cache_hgetall
    from shared.scrip_resolve import resolve_order_legs

    if not body.orders:
        raise HTTPException(status_code=400, detail="No orders provided")

    im = get_instrument_master()

    resolved, resolve_errors = await resolve_order_legs(body.orders, settings.redis_url)

    # Lot sizes (best-effort) for position display
    lot_map: dict[str, int] = {}
    raw_lots = await cache_hgetall(settings.redis_url, "cache:lot_sizes")
    if raw_lots:
        lot_map = {k: int(v) for k, v in raw_lots.items()}

    results: list[PaperOrderResult] = [
        PaperOrderResult(index=e["index"], success=False, error=e["error"])
        for e in resolve_errors
    ]

    for rl in resolved:
        idx = rl["original_index"]
        ltp = await _resolve_ltp(rl["cache_symbol"])
        if ltp is None:
            results.append(PaperOrderResult(
                index=idx,
                success=False,
                error="No live price available — option chain may not be subscribed",
                trading_symbol=rl["trading_symbol"],
            ))
            continue

        side = "BUY" if rl["transaction_type"] == "B" else "SELL"
        underlying = rl["underlying"] or ""
        try:
            await apply_paper_fill(settings.timescaledb_url, {
                "trading_symbol": rl["trading_symbol"],
                "symbol": rl["cache_symbol"],
                "exchange": exchange_from_segment(rl["exchange_segment"]),
                "product_type": rl["product"],
                "option_type": rl["option_type"] or "",
                "strike_price": rl["strike"],
                "expiry": rl["expiry"],
                "lot_size": lot_map.get(underlying, 1),
                "multiplier": cfg.unit_multiplier if (cfg := im.get(underlying)) else 1.0,
                "underlying": underlying,
                "side": side,
                "quantity": rl["quantity"],
                "price": ltp,
                "order_id": f"PAPER-{uuid.uuid4().hex[:12]}",
                "fill_id": uuid.uuid4().hex,
            })
            results.append(PaperOrderResult(
                index=idx,
                success=True,
                order_number=f"PAPER-{idx}",
                trading_symbol=rl["trading_symbol"],
                fill_price=ltp,
            ))
        except Exception as exc:
            log.error("paper.place_failed", index=idx, error=str(exc))
            results.append(PaperOrderResult(
                index=idx,
                success=False,
                error=f"Paper fill failed: {exc}",
                trading_symbol=rl["trading_symbol"],
            ))

    results.sort(key=lambda r: r.index)
    return results


@router.get("/positions")
async def get_paper_positions() -> dict:
    """Return current paper positions (same shape as live ``/positions``)."""
    from shared.paper_trading import load_paper_positions

    return await load_paper_positions(settings.timescaledb_url)


@router.post("/reset")
async def reset_paper_positions() -> dict:
    """Clear the entire paper book — positions and trade logs."""
    from shared.paper_trading import reset_paper_book

    await reset_paper_book(settings.timescaledb_url)
    return {"ok": True}
