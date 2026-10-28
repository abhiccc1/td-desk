"""Trade logger — persists execution fills to TimescaleDB trade_logs table.

Fetches fills from Kotak Trade Report API and writes them to the trade_logs
hypertable, deduplicating by (ucc, fill_id, order_id).  Provides FIFO realized
P&L computation from persistent trade history.

Every row is tagged with the broker account's UCC and every query filters on it,
so switching accounts never merges one account's fills into another's P&L.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timezone

import structlog
from sqlalchemy import text

from shared.db import get_engine
from shared.instruments import exchange_from_segment

log = structlog.get_logger()

_OPTION_RE = re.compile(
    r"^(?P<sym>[A-Z]+)\s*(?P<expiry>\d{2}[A-Z]{3}\d{4}|\d{6})"
    r"\s*(?P<strike>[\d.]+)\s*(?P<ot>CE|PE)$"
)


def _parse_trade_fill(t: dict, ucc: str = "") -> dict | None:
    """Transform a raw Kotak trade fill dict into a trade_logs row."""
    fill_id = t.get("flId", "")
    order_id = t.get("nOrdNo", "")
    if not fill_id and not order_id:
        return None

    qty = int(t.get("fldQty", "0") or "0")
    price = float(t.get("avgPrc", "0") or "0")
    if qty <= 0 or price <= 0:
        return None

    multiplier = int(t.get("multiplier", "1") or "1")
    gen_num = int(t.get("genNum", "1") or "1")
    gen_den = int(t.get("genDen", "1") or "1")
    prc_num = int(t.get("prcNum", "1") or "1")
    prc_den = int(t.get("prcDen", "1") or "1")
    adj = multiplier * (gen_num / gen_den) * (prc_num / prc_den)
    value = qty * price * adj

    trd_sym = t.get("trdSym", "")
    sym = t.get("sym", "")
    side = "BUY" if t.get("trnsTp") == "B" else "SELL"
    ex_seg = t.get("exSeg", "")
    exchange = exchange_from_segment(ex_seg)
    opt_tp = t.get("optTp", "") or ""
    stk_prc = t.get("stkPrc", "")

    # Parse expiry
    expiry: date | None = None
    exp_dt = t.get("expDt", "")
    if exp_dt:
        try:
            exp_clean = re.sub(r",\s*", " ", exp_dt.strip())
            expiry = datetime.strptime(exp_clean, "%d %b %Y").date()
        except ValueError:
            pass

    strike: float | None = None
    if stk_prc and stk_prc != "0.00":
        try:
            strike = float(stk_prc)
        except ValueError:
            pass

    # Build cache-compatible symbol
    symbol = trd_sym
    if opt_tp and strike and expiry:
        exp_compact = expiry.strftime("%y%m%d")
        strike_str = str(int(strike)) if strike == int(strike) else str(strike)
        symbol = f"{sym} {exp_compact} {strike_str} {opt_tp}"

    # Parse fill timestamp
    fl_dt = t.get("flDt", "")
    fl_tm = t.get("flTm", "")
    ts = datetime.now(timezone.utc)
    if fl_dt and fl_tm:
        try:
            ts = datetime.strptime(f"{fl_dt} {fl_tm}", "%d-%b-%Y %H:%M:%S")
            ts = ts.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    elif fl_dt:
        try:
            ts = datetime.strptime(fl_dt, "%d-%b-%Y").replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    return {
        "time": ts,
        "ucc": ucc,
        "symbol": symbol,
        "trading_symbol": trd_sym,
        "underlying": sym or None,
        "expiry": expiry,
        "strike": strike,
        "option_type": opt_tp[:2] if opt_tp else None,
        "side": side,
        "quantity": qty,
        "price": price,
        "value": round(value, 2),
        "order_id": order_id or "",
        "fill_id": fill_id or "",
        "exchange": exchange,
        "product_type": t.get("prod", "") or None,
        "multiplier": multiplier,
    }


async def persist_trade_fills(db_url: str, raw_trades: list[dict], ucc: str = "") -> int:
    """Parse and write trade fills to TimescaleDB, deduplicating by fill_id.

    ``ucc`` tags every row with the broker account the fills came from.

    Returns the number of rows written.
    """
    records = []
    for t in raw_trades:
        row = _parse_trade_fill(t, ucc)
        if row is not None:
            records.append(row)

    if not records:
        return 0

    engine = get_engine(db_url)

    insert_sql = text("""
        INSERT INTO trade_logs (
            time, ucc, symbol, trading_symbol, underlying, expiry, strike,
            option_type, side, quantity, price, value, order_id, fill_id,
            exchange, product_type, multiplier
        )
        VALUES (
            :time, :ucc, :symbol, :trading_symbol, :underlying, :expiry, :strike,
            :option_type, :side, :quantity, :price, :value, :order_id, :fill_id,
            :exchange, :product_type, :multiplier
        )
        ON CONFLICT (time, ucc, fill_id, order_id) DO NOTHING
    """)

    try:
        async with engine.begin() as conn:
            await conn.execute(insert_sql, records)
        log.info("trade_logger.persisted", fills=len(records))
        return len(records)
    except Exception as exc:
        exc_str = str(exc)
        if "does not exist" in exc_str or "UndefinedTableError" in exc_str:
            log.warning("trade_logger.table_missing",
                        hint="Run init.sql to create trade_logs table")
        else:
            log.warning("trade_logger.persist_failed", error=exc_str[:200])
        return 0


async def compute_fifo_pnl(
    db_url: str,
    symbol: str,
    *,
    ucc: str = "",
    underlying: str | None = None,
) -> dict:
    """Compute FIFO realized P&L for a symbol from trade_logs.

    Returns:
        {
            "symbol": str,
            "realized_pnl": float,
            "open_qty": int,
            "avg_entry_price": float,
            "total_fills": int,
        }
    """
    engine = get_engine(db_url)

    query = text("""
        SELECT time, side, quantity, price, value, multiplier
        FROM trade_logs
        WHERE symbol = :symbol AND ucc = :ucc
        ORDER BY time ASC
    """)

    try:
        async with engine.begin() as conn:
            result = await conn.execute(query, {"symbol": symbol, "ucc": ucc})
            rows = result.fetchall()
    except Exception as exc:
        log.warning("fifo_pnl.query_failed", symbol=symbol, error=str(exc)[:200])
        return {
            "symbol": symbol,
            "realized_pnl": 0.0,
            "open_qty": 0,
            "avg_entry_price": 0.0,
            "total_fills": 0,
        }

    if not rows:
        return {
            "symbol": symbol,
            "realized_pnl": 0.0,
            "open_qty": 0,
            "avg_entry_price": 0.0,
            "total_fills": 0,
        }

    # FIFO matching: maintain a queue of open lots
    # Each lot: (qty, price_per_unit)
    buy_queue: list[tuple[int, float]] = []
    sell_queue: list[tuple[int, float]] = []
    realized_pnl = 0.0

    for row in rows:
        side = row[1]
        qty = row[2]
        price = row[3]
        multiplier = row[5] or 1

        if side == "BUY":
            # Try to match against pending sells (short position closing)
            remaining = qty
            while remaining > 0 and sell_queue:
                sq, sp = sell_queue[0]
                matched = min(remaining, sq)
                realized_pnl += matched * (sp - price) * multiplier
                remaining -= matched
                if matched == sq:
                    sell_queue.pop(0)
                else:
                    sell_queue[0] = (sq - matched, sp)
            if remaining > 0:
                buy_queue.append((remaining, price))
        else:
            # Try to match against pending buys (long position closing)
            remaining = qty
            while remaining > 0 and buy_queue:
                bq, bp = buy_queue[0]
                matched = min(remaining, bq)
                realized_pnl += matched * (price - bp) * multiplier
                remaining -= matched
                if matched == bq:
                    buy_queue.pop(0)
                else:
                    buy_queue[0] = (bq - matched, bp)
            if remaining > 0:
                sell_queue.append((remaining, price))

    # Open position summary
    open_buy = sum(q for q, _ in buy_queue)
    open_sell = sum(q for q, _ in sell_queue)
    open_qty = open_buy - open_sell

    if open_buy > 0:
        avg_entry = sum(q * p for q, p in buy_queue) / open_buy
    elif open_sell > 0:
        avg_entry = sum(q * p for q, p in sell_queue) / open_sell
    else:
        avg_entry = 0.0

    return {
        "symbol": symbol,
        "realized_pnl": round(realized_pnl, 2),
        "open_qty": open_qty,
        "avg_entry_price": round(avg_entry, 2),
        "total_fills": len(rows),
    }


async def seed_missing_fills(
    db_url: str,
    positions: list[dict],
    ucc: str = "",
) -> int:
    """Detect quantity gaps between Kotak positions and trade_logs, insert
    synthetic seed fills so the FIFO calculator has complete history.

    For each open position, if trade_logs doesn't account for the full
    net_qty, back-calculate the missing fill from Kotak's amount data:

        missing_value = kotak_total_amt - sum(known_fill_values)
        missing_price = missing_value / gap_qty

    Seed fills are tagged with fill_id='SEED' and are idempotent (ON CONFLICT).
    Returns the number of seed fills created.
    """
    engine = get_engine(db_url)
    seeds: list[dict] = []

    for pos in positions:
        if not pos.get("isOpen", True) or pos.get("netQty", 0) == 0:
            continue

        symbol = pos.get("symbol", "")
        net_qty = pos.get("netQty", 0)
        if not symbol:
            continue

        fifo = await compute_fifo_pnl(db_url, symbol, ucc=ucc)
        fifo_open = fifo["open_qty"]

        # Gap: position has more quantity than trade_logs accounts for
        gap = abs(net_qty) - abs(fifo_open)
        if gap <= 0:
            continue  # trade_logs already covers the full position

        # Determine the missing fill's side and back-calculate its price.
        # net_qty > 0 → long position → missing fill is a BUY
        # net_qty < 0 → short position → missing fill is a SELL
        if net_qty > 0:
            side = "BUY"
            total_amt = pos.get("totalBuyAmt", 0)
        else:
            side = "SELL"
            total_amt = pos.get("totalSellAmt", 0)

        # Sum values of fills we already have on the entry side
        try:
            async with engine.begin() as conn:
                result = await conn.execute(
                    text(
                        "SELECT COALESCE(SUM(value), 0) FROM trade_logs "
                        "WHERE symbol = :sym AND side = :side AND ucc = :ucc"
                    ),
                    {"sym": symbol, "side": side, "ucc": ucc},
                )
                known_value = float(result.scalar())
        except Exception:
            known_value = 0.0

        missing_value = total_amt - known_value
        if missing_value <= 0 or gap <= 0:
            continue

        missing_price = missing_value / gap
        adj = pos.get("multiplier", 1)
        if adj and adj != 0:
            missing_price = missing_price / adj

        # Parse symbol for metadata
        m = re.match(r"^([A-Z]+)\s+(\d{6})\s+([\d.]+)\s+(CE|PE)$", symbol)
        underlying = m.group(1) if m else None
        expiry_date = None
        strike = None
        opt_tp = None
        if m:
            raw = m.group(2)
            expiry_date = date(2000 + int(raw[:2]), int(raw[2:4]), int(raw[4:6]))
            try:
                strike = float(m.group(3))
            except ValueError:
                pass
            opt_tp = m.group(4)

        seeds.append({
            "time": datetime.now(timezone.utc),
            "ucc": ucc,
            "symbol": symbol,
            "trading_symbol": pos.get("tradingSymbol", symbol),
            "underlying": underlying,
            "expiry": expiry_date,
            "strike": strike,
            "option_type": opt_tp,
            "side": side,
            "quantity": gap,
            "price": round(missing_price, 2),
            "value": round(missing_value, 2),
            "order_id": "SEED",
            "fill_id": f"SEED_{symbol}",
            "exchange": pos.get("exchange", ""),
            "product_type": pos.get("productType", ""),
            "multiplier": pos.get("multiplier", 1) or 1,
        })

    if not seeds:
        return 0

    insert_sql = text("""
        INSERT INTO trade_logs (
            time, ucc, symbol, trading_symbol, underlying, expiry, strike,
            option_type, side, quantity, price, value, order_id, fill_id,
            exchange, product_type, multiplier
        )
        VALUES (
            :time, :ucc, :symbol, :trading_symbol, :underlying, :expiry, :strike,
            :option_type, :side, :quantity, :price, :value, :order_id, :fill_id,
            :exchange, :product_type, :multiplier
        )
        ON CONFLICT (time, ucc, fill_id, order_id) DO NOTHING
    """)

    try:
        async with engine.begin() as conn:
            await conn.execute(insert_sql, seeds)
        log.info("trade_logger.seeded", count=len(seeds),
                 symbols=[s["symbol"] for s in seeds])
        return len(seeds)
    except Exception as exc:
        log.warning("trade_logger.seed_failed", error=str(exc)[:200])
        return 0


async def compute_portfolio_fifo_pnl(db_url: str, ucc: str = "") -> dict:
    """Compute FIFO P&L for all symbols with trade history.

    Returns:
        {
            "total_realized_pnl": float,
            "positions": {symbol: {realized_pnl, open_qty, avg_entry_price}},
        }
    """
    engine = get_engine(db_url)

    query = text("SELECT DISTINCT symbol FROM trade_logs WHERE ucc = :ucc")

    try:
        async with engine.begin() as conn:
            result = await conn.execute(query, {"ucc": ucc})
            symbols = [row[0] for row in result.fetchall()]
    except Exception as exc:
        log.warning("portfolio_fifo.query_failed", error=str(exc)[:200])
        return {"total_realized_pnl": 0.0, "positions": {}}

    total = 0.0
    positions = {}
    for sym in symbols:
        pnl = await compute_fifo_pnl(db_url, sym, ucc=ucc)
        positions[sym] = pnl
        total += pnl["realized_pnl"]

    return {
        "total_realized_pnl": round(total, 2),
        "positions": positions,
    }
