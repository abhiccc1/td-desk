"""FastAPI routes for the order service."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from shared.schemas.order import OrderRequest

from order_service.basket import create_basket, get_basket
from order_service.executor import OrderExecutor
from order_service.position_tracker import PositionTracker
from order_service.publisher import publish_basket_status, publish_order_update

router = APIRouter(prefix="/api/v1", tags=["orders"])

_executor = OrderExecutor()
_tracker = PositionTracker()


# --- basket management ---------------------------------------------------


@router.post("/basket")
async def create_new_basket():
    """Create a new empty order basket."""
    basket = create_basket()
    return {"basket_id": basket.basket_id, "state": basket.state}


@router.post("/basket/{basket_id}/leg")
async def add_leg(basket_id: str, order: OrderRequest):
    """Add an order leg to an existing basket."""
    try:
        basket = get_basket(basket_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Basket not found")
    try:
        basket.add_leg(order)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"basket_id": basket_id, "legs": len(basket.legs), "state": basket.state}


@router.delete("/basket/{basket_id}/leg/{order_id}")
async def remove_leg(basket_id: str, order_id: str):
    """Remove a leg from the basket."""
    try:
        basket = get_basket(basket_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Basket not found")
    try:
        basket.remove_leg(order_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"basket_id": basket_id, "legs": len(basket.legs), "state": basket.state}


@router.post("/basket/{basket_id}/submit")
async def submit_basket(basket_id: str, user_id: str = "anonymous"):
    """Validate and submit a basket for execution."""
    try:
        basket = get_basket(basket_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Basket not found")

    try:
        basket.validate()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    fills = await _executor.execute_basket(basket)

    # Update position tracker and publish events
    for fill in fills:
        _tracker.update_on_fill(fill)
        await publish_order_update(user_id, fill)

    await publish_basket_status(user_id, basket_id, basket.state)
    await _tracker.persist()

    return {
        "basket_id": basket_id,
        "state": basket.state,
        "fills": [f.model_dump(mode="json") for f in fills],
    }


# --- positions ------------------------------------------------------------


@router.get("/positions")
async def get_positions():
    """Return all current positions."""
    return [p.model_dump(mode="json") for p in _tracker.get_positions()]


@router.get("/positions/pnl")
async def get_pnl(ltp: str = ""):
    """Return P&L summary.

    Accepts an optional comma-separated ``ltp`` query param of
    ``symbol:price`` pairs, e.g. ``NIFTY24600CE:120.5,NIFTY24600PE:80.0``.
    """
    ltp_map: dict[str, float] = {}
    if ltp:
        for pair in ltp.split(","):
            parts = pair.split(":")
            if len(parts) == 2:
                ltp_map[parts[0]] = float(parts[1])

    pnl = _tracker.calculate_pnl(ltp_map)
    total = sum(pnl.values())
    return {"pnl": pnl, "total": total}
