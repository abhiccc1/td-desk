"""Paper-trading position accounting — fully isolated from live trading.

Pure position math over the ``paper_positions`` / ``paper_trade_logs`` tables.
Imports **no broker code**.  Fills are simulated at the live LTP supplied by the
caller (the paper-trading router reads it from the Redis ``cache:ltp`` key).

The position dict shape produced by :func:`load_paper_positions` is identical to
``shared.positions.load_positions`` so the frontend ``Position`` type and the
``PositionMonitor`` component work unchanged for paper positions.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

import structlog

logger = structlog.get_logger()

# Advisory-lock key for serializing paper-position writes (distinct from the
# live positions lock 900_001).
_PAPER_LOCK_ID = 900_002


def _round(value: float, precision: int) -> float:
    return round(value, precision)


def _parse_expiry_date(value: Any) -> date | None:
    """Coerce an ISO expiry (``"2026-06-09"``) to a ``date`` for the DATE column."""
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _derive(
    total_buy_qty: int,
    total_sell_qty: int,
    total_buy_amt: float,
    total_sell_amt: float,
    multiplier: float,
    precision: int,
) -> dict[str, Any]:
    """Recompute derived position fields from accumulated totals.

    Mirrors the Kotak formulae used in ``shared.positions.transform_kotak_positions``.
    """
    net_qty = total_buy_qty - total_sell_qty
    booked = total_sell_amt - total_buy_amt
    adj = multiplier or 1

    buy_avg = _round(total_buy_amt / (total_buy_qty * adj), precision) if total_buy_qty > 0 else 0.0
    sell_avg = _round(total_sell_amt / (total_sell_qty * adj), precision) if total_sell_qty > 0 else 0.0
    if total_buy_qty > total_sell_qty:
        avg_price = buy_avg
    elif total_sell_qty > total_buy_qty:
        avg_price = sell_avg
    else:
        avg_price = 0.0

    return {
        "net_qty": net_qty,
        "side": "BUY" if net_qty > 0 else ("SELL" if net_qty < 0 else "CLOSED"),
        "is_open": net_qty != 0,
        "buy_avg_price": buy_avg,
        "sell_avg_price": sell_avg,
        "avg_price": avg_price,
        "booked_pnl": _round(booked, 2),
    }


async def apply_paper_fill(db_url: str, fill: dict[str, Any]) -> None:
    """Apply one simulated fill: accumulate the position and log the trade.

    ``fill`` must contain: ``trading_symbol``, ``symbol`` (cache symbol),
    ``exchange``, ``product_type``, ``option_type``, ``strike_price``,
    ``expiry``, ``lot_size``, ``underlying``, ``side`` (``"BUY"``/``"SELL"``),
    ``quantity``, ``price``, ``order_id``, ``fill_id``.  ``multiplier`` defaults
    to 1.

    Runs inside a single transaction under an advisory lock so overlapping fills
    for the same symbol never interleave.
    """
    from sqlalchemy import text

    from shared.db import get_engine

    engine = get_engine(db_url)

    trading_symbol = fill["trading_symbol"]
    qty = int(fill["quantity"])
    price = float(fill["price"])
    # ₹ per unit of qty per ₹1 of price (fractional for GOLDM: 0.1)
    multiplier = float(fill.get("multiplier", 1) or 1)
    precision = int(fill.get("precision", 2) or 2)
    value = _round(qty * price * multiplier, 2)
    is_buy = fill["side"] == "BUY"
    now = datetime.now(timezone.utc)

    try:
        async with engine.begin() as conn:
            await conn.execute(text(f"SELECT pg_advisory_xact_lock({_PAPER_LOCK_ID})"))

            row = (await conn.execute(
                text(
                    "SELECT total_buy_qty, total_sell_qty, total_buy_amt, total_sell_amt "
                    "FROM paper_positions WHERE trading_symbol = :ts"
                ),
                {"ts": trading_symbol},
            )).fetchone()

            prev_buy_qty, prev_sell_qty, prev_buy_amt, prev_sell_amt = row if row else (0, 0, 0.0, 0.0)

            total_buy_qty = prev_buy_qty + (qty if is_buy else 0)
            total_sell_qty = prev_sell_qty + (0 if is_buy else qty)
            total_buy_amt = float(prev_buy_amt) + (value if is_buy else 0.0)
            total_sell_amt = float(prev_sell_amt) + (0.0 if is_buy else value)

            derived = _derive(
                total_buy_qty, total_sell_qty, total_buy_amt, total_sell_amt, multiplier, precision
            )

            await conn.execute(
                text(
                    """
                    INSERT INTO paper_positions (
                        trading_symbol, symbol, exchange, product_type, option_type,
                        strike_price, expiry, lot_size, total_buy_qty, total_sell_qty,
                        net_qty, cf_qty, side, is_open, total_buy_amt, total_sell_amt,
                        buy_avg_price, sell_avg_price, avg_price, booked_pnl,
                        multiplier, precision, updated_at
                    ) VALUES (
                        :trading_symbol, :symbol, :exchange, :product_type, :option_type,
                        :strike_price, :expiry, :lot_size, :total_buy_qty, :total_sell_qty,
                        :net_qty, 0, :side, :is_open, :total_buy_amt, :total_sell_amt,
                        :buy_avg_price, :sell_avg_price, :avg_price, :booked_pnl,
                        :multiplier, :precision, now()
                    )
                    ON CONFLICT (trading_symbol) DO UPDATE SET
                        total_buy_qty  = EXCLUDED.total_buy_qty,
                        total_sell_qty = EXCLUDED.total_sell_qty,
                        net_qty        = EXCLUDED.net_qty,
                        side           = EXCLUDED.side,
                        is_open        = EXCLUDED.is_open,
                        total_buy_amt  = EXCLUDED.total_buy_amt,
                        total_sell_amt = EXCLUDED.total_sell_amt,
                        buy_avg_price  = EXCLUDED.buy_avg_price,
                        sell_avg_price = EXCLUDED.sell_avg_price,
                        avg_price      = EXCLUDED.avg_price,
                        booked_pnl     = EXCLUDED.booked_pnl,
                        updated_at     = now()
                    """
                ),
                {
                    "trading_symbol": trading_symbol,
                    "symbol": fill["symbol"],
                    "exchange": fill.get("exchange", "NSE"),
                    "product_type": fill.get("product_type", "NRML"),
                    "option_type": fill.get("option_type", ""),
                    "strike_price": str(fill.get("strike_price", "")),
                    "expiry": fill.get("expiry", ""),
                    "lot_size": int(fill.get("lot_size", 1) or 1),
                    "total_buy_qty": total_buy_qty,
                    "total_sell_qty": total_sell_qty,
                    "total_buy_amt": _round(total_buy_amt, 2),
                    "total_sell_amt": _round(total_sell_amt, 2),
                    "multiplier": multiplier,
                    "precision": precision,
                    **derived,
                },
            )

            strike_val = None
            try:
                strike_val = float(fill.get("strike_price")) if fill.get("strike_price") else None
            except (TypeError, ValueError):
                strike_val = None

            await conn.execute(
                text(
                    """
                    INSERT INTO paper_trade_logs (
                        time, symbol, trading_symbol, underlying, expiry, strike,
                        option_type, side, quantity, price, value, order_id, fill_id,
                        exchange, product_type, multiplier
                    ) VALUES (
                        :time, :symbol, :trading_symbol, :underlying, :expiry, :strike,
                        :option_type, :side, :quantity, :price, :value, :order_id, :fill_id,
                        :exchange, :product_type, :multiplier
                    )
                    """
                ),
                {
                    "time": now,
                    "symbol": fill["symbol"],
                    "trading_symbol": trading_symbol,
                    "underlying": fill.get("underlying"),
                    "expiry": _parse_expiry_date(fill.get("expiry")),
                    "strike": strike_val,
                    "option_type": (fill.get("option_type") or "")[:2] or None,
                    "side": fill["side"],
                    "quantity": qty,
                    "price": price,
                    "value": value,
                    "order_id": fill.get("order_id", ""),
                    "fill_id": fill.get("fill_id", ""),
                    "exchange": fill.get("exchange", "NSE"),
                    "product_type": fill.get("product_type", "NRML"),
                    "multiplier": multiplier,
                },
            )
        logger.info("paper.fill_applied", trading_symbol=trading_symbol, side=fill["side"], qty=qty, price=price)
    except Exception as exc:
        logger.error("paper.fill_failed", trading_symbol=trading_symbol, error=str(exc)[:200])
        raise


async def load_paper_positions(db_url: str) -> dict[str, Any]:
    """Load paper positions in the same shape as the live ``/positions`` endpoint.

    Returns ``{"positions": [...], "realizedPnl": float}``.  ``ltp`` is 0 — the
    frontend enriches unrealized P&L from live chain ticks, exactly as for live
    positions.
    """
    from sqlalchemy import text

    from shared.db import get_engine

    engine = get_engine(db_url)
    try:
        async with engine.begin() as conn:
            result = await conn.execute(text(
                "SELECT * FROM paper_positions ORDER BY is_open DESC, trading_symbol"
            ))
            rows = result.fetchall()
            columns = result.keys()
    except Exception as exc:
        logger.warning("paper.load_failed", error=str(exc)[:200])
        return {"positions": [], "realizedPnl": 0.0}

    positions: list[dict[str, Any]] = []
    realized_pnl = 0.0
    for raw in rows:
        r = dict(zip(columns, raw))
        if not r["is_open"]:
            realized_pnl += float(r["booked_pnl"] or 0)
        positions.append({
            "tradingSymbol": r["trading_symbol"],
            "symbol": r["symbol"],
            "exchange": r["exchange"],
            "productType": r["product_type"],
            "optionType": r["option_type"],
            "strikePrice": r["strike_price"],
            "expiry": r["expiry"],
            "lotSize": r["lot_size"],
            "totalBuyQty": r["total_buy_qty"],
            "totalSellQty": r["total_sell_qty"],
            "netQty": r["net_qty"],
            "carryForwardQty": r["cf_qty"],
            "quantity": r["net_qty"],
            "side": r["side"],
            "isOpen": r["is_open"],
            "totalBuyAmt": r["total_buy_amt"],
            "totalSellAmt": r["total_sell_amt"],
            "buyAvgPrice": r["buy_avg_price"],
            "sellAvgPrice": r["sell_avg_price"],
            "avgPrice": r["avg_price"],
            "ltp": 0,
            "pnl": r["booked_pnl"],
            "unrealizedPnl": 0,
            "bookedPnl": r["booked_pnl"],
            "multiplier": r["multiplier"],
            # Paper fills store the unit multiplier (₹ per unit qty per ₹1)
            "valueMultiplier": float(r["multiplier"] or 1),
            "precision": r["precision"],
            "isPaper": True,
        })

    return {"positions": positions, "realizedPnl": round(realized_pnl, 2)}


async def reset_paper_book(db_url: str) -> None:
    """Wipe all paper positions and trade logs (useful for a fresh test run)."""
    from sqlalchemy import text

    from shared.db import get_engine

    engine = get_engine(db_url)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(f"SELECT pg_advisory_xact_lock({_PAPER_LOCK_ID})"))
            await conn.execute(text("DELETE FROM paper_positions"))
            await conn.execute(text("DELETE FROM paper_trade_logs"))
        logger.info("paper.book_reset")
    except Exception as exc:
        logger.warning("paper.reset_failed", error=str(exc)[:200])
        raise


async def ensure_paper_tables(db_url: str) -> None:
    """Idempotently create the paper tables.

    ``init.sql`` only runs on a fresh DB volume; this lets an existing
    deployment pick up the paper tables on gateway startup.  Mirrors the DDL in
    ``infra/docker/timescaledb/init.sql``.
    """
    from sqlalchemy import text

    from shared.db import get_engine

    engine = get_engine(db_url)
    ddl = """
    CREATE TABLE IF NOT EXISTS paper_trade_logs (
        time TIMESTAMPTZ NOT NULL, symbol TEXT NOT NULL, trading_symbol TEXT NOT NULL,
        underlying TEXT, expiry DATE, strike DOUBLE PRECISION, option_type CHAR(2),
        side TEXT NOT NULL, quantity INTEGER NOT NULL, price DOUBLE PRECISION NOT NULL,
        value DOUBLE PRECISION NOT NULL, order_id TEXT NOT NULL DEFAULT '',
        fill_id TEXT NOT NULL DEFAULT '', exchange TEXT NOT NULL, product_type TEXT,
        multiplier DOUBLE PRECISION DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_paper_trade_logs_symbol_time ON paper_trade_logs (symbol, time DESC);
    CREATE TABLE IF NOT EXISTS paper_positions (
        trading_symbol TEXT PRIMARY KEY, symbol TEXT NOT NULL, exchange TEXT,
        product_type TEXT, option_type TEXT, strike_price TEXT, expiry TEXT,
        lot_size INTEGER DEFAULT 1, total_buy_qty INTEGER DEFAULT 0,
        total_sell_qty INTEGER DEFAULT 0, net_qty INTEGER DEFAULT 0, cf_qty INTEGER DEFAULT 0,
        side TEXT, is_open BOOLEAN DEFAULT true, total_buy_amt DOUBLE PRECISION DEFAULT 0,
        total_sell_amt DOUBLE PRECISION DEFAULT 0, buy_avg_price DOUBLE PRECISION DEFAULT 0,
        sell_avg_price DOUBLE PRECISION DEFAULT 0, avg_price DOUBLE PRECISION DEFAULT 0,
        booked_pnl DOUBLE PRECISION DEFAULT 0, multiplier DOUBLE PRECISION DEFAULT 1,
        precision INTEGER DEFAULT 2, updated_at TIMESTAMPTZ DEFAULT now()
    );
    """
    try:
        async with engine.begin() as conn:
            for stmt in (s.strip() for s in ddl.split(";") if s.strip()):
                await conn.execute(text(stmt))
        logger.info("paper.tables_ensured")
    except Exception as exc:
        logger.warning("paper.ensure_tables_failed", error=str(exc)[:200])
        return

    # Widen pre-existing INTEGER multiplier columns (MCX GOLDM is 0.1).
    # Separate transaction so a failure can't roll back table creation.
    try:
        async with engine.begin() as conn:
            for table in ("paper_trade_logs", "paper_positions"):
                await conn.execute(text(
                    f"ALTER TABLE {table} ALTER COLUMN multiplier TYPE DOUBLE PRECISION"
                ))
    except Exception as exc:
        logger.warning("paper.widen_multiplier_failed", error=str(exc)[:200])
