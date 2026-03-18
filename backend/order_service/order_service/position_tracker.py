"""Position tracker – maintains live positions and computes P&L."""

from __future__ import annotations

from datetime import datetime, timezone

import structlog

from shared.schemas.order import OrderFill, OrderSide, Position

log = structlog.get_logger()


class PositionTracker:
    """Maintain current positions and calculate P&L.

    Positions are held in-memory and persisted to TimescaleDB *order_events*
    table on each update.
    """

    def __init__(self) -> None:
        self.positions: dict[str, Position] = {}

    def update_on_fill(self, fill: OrderFill) -> Position:
        """Adjust the position for *fill.symbol* and return the updated position."""
        symbol = fill.symbol
        pos = self.positions.get(symbol)

        if pos is None:
            pos = Position(
                symbol=symbol,
                quantity=0,
                avg_price=0.0,
                side=OrderSide.BUY,
                pnl=0.0,
            )
            self.positions[symbol] = pos

        signed_qty = fill.filled_qty if fill.status.value != "CANCELLED" else 0
        # Determine the sign based on the fill
        if hasattr(fill, "side") and getattr(fill, "side", None) == OrderSide.SELL:
            signed_qty = -signed_qty

        new_qty = pos.quantity + signed_qty
        if new_qty != 0 and pos.quantity + signed_qty != 0:
            total_cost = pos.avg_price * pos.quantity + fill.filled_price * signed_qty
            pos.avg_price = total_cost / new_qty if new_qty else 0.0
        pos.quantity = new_qty
        pos.side = OrderSide.BUY if new_qty >= 0 else OrderSide.SELL

        log.info(
            "position_tracker.update",
            symbol=symbol,
            qty=pos.quantity,
            avg_price=pos.avg_price,
        )
        return pos

    def calculate_pnl(self, ltp_map: dict[str, float]) -> dict[str, float]:
        """Return per-symbol P&L given a map of latest traded prices."""
        pnl: dict[str, float] = {}
        for symbol, pos in self.positions.items():
            current_price = ltp_map.get(symbol, 0.0)
            pnl[symbol] = (current_price - pos.avg_price) * pos.quantity
        return pnl

    def get_positions(self) -> list[Position]:
        return list(self.positions.values())

    async def persist(self) -> None:
        """Persist current positions to TimescaleDB order_events table.

        TODO: implement actual DB write via shared.db.get_engine().
        """
        log.info(
            "position_tracker.persist",
            num_positions=len(self.positions),
            ts=datetime.now(timezone.utc).isoformat(),
        )
