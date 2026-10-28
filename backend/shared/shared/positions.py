"""Kotak position fetching and transformation.

Extracts positions from the Kotak REST API and computes P&L using the official
Kotak formula.  LTP enrichment is handled by the frontend from live chain ticks.

Also fetches the Trade Report (``/quick/user/trades``) for fill-level data and
uses actual fill prices to compute a more accurate realized P&L.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime as _dt
from typing import Any

import httpx
import structlog

from shared.instruments import exchange_from_segment

logger = structlog.get_logger()


async def fetch_kotak_positions(
    base_url: str,
    access_token: str,
    sid: str,
) -> dict | None:
    """Fetch positions from Kotak REST API, transform, and return result.

    Returns ``{"positions": [...], "realizedPnl": float}`` or ``None`` on failure.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                f"{base_url}/quick/user/positions",
                headers={
                    "Auth": access_token,
                    "Sid": sid,
                    "neo-fin-key": "neotradeapi",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            data = resp.json()
        except Exception as exc:
            logger.warning("positions.kotak_fetch_failed", error=str(exc))
            return None

    if str(data.get("stat", "")).lower() != "ok" or "data" not in data:
        logger.warning("positions.kotak_error", stat=data.get("stat"), msg=data.get("emsg"))
        return None

    _debug_dump_carry_forward(data["data"])

    return transform_kotak_positions(data["data"])


def _debug_dump_carry_forward(raw_positions: list[dict]) -> None:
    """TEMPORARY (Step 0 verification): dump raw carry-forward rows.

    Determines whether Kotak values ``cfBuyAmt``/``cfSellAmt`` at the previous
    day's close (netwise) or at the original entry price (holdingwise). For any
    row with a non-zero carry-forward bucket we log the raw amounts alongside the
    implied carry-forward average price so it can be compared against yesterday's
    settlement close and the actual opening price.

    Remove once the convention is confirmed and recorded in docs/PROGRESS.md.
    """
    for p in raw_positions:
        cf_buy_qty = int(p.get("cfBuyQty", "0") or "0")
        cf_sell_qty = int(p.get("cfSellQty", "0") or "0")
        if cf_buy_qty == 0 and cf_sell_qty == 0:
            continue

        multiplier = int(p.get("multiplier", "1") or "1")
        gen_num = int(p.get("genNum", "1") or "1")
        gen_den = int(p.get("genDen", "1") or "1")
        prc_num = int(p.get("prcNum", "1") or "1")
        prc_den = int(p.get("prcDen", "1") or "1")
        adj = multiplier * (gen_num / gen_den) * (prc_num / prc_den)

        cf_buy_amt = float(p.get("cfBuyAmt", "0") or "0")
        cf_sell_amt = float(p.get("cfSellAmt", "0") or "0")
        cf_buy_avg = cf_buy_amt / (cf_buy_qty * adj) if cf_buy_qty and adj else None
        cf_sell_avg = cf_sell_amt / (cf_sell_qty * adj) if cf_sell_qty and adj else None

        logger.warning(
            "positions.cf_convention_probe",
            trdSym=p.get("trdSym"),
            cfBuyQty=cf_buy_qty,
            cfSellQty=cf_sell_qty,
            cfBuyAmt=cf_buy_amt,
            cfSellAmt=cf_sell_amt,
            impliedCfBuyAvg=round(cf_buy_avg, 4) if cf_buy_avg is not None else None,
            impliedCfSellAvg=round(cf_sell_avg, 4) if cf_sell_avg is not None else None,
            adj=adj,
            hint="compare implied avg to (a) yesterday's close and (b) your entry price",
        )


def transform_kotak_positions(
    raw_positions: list[dict],
) -> dict:
    """Transform raw Kotak position dicts into our standard format.

    LTP is set to 0 — the frontend computes unrealized P&L from live chain ticks.

    Kotak P&L formula (official docs):
      Realized  = sum(TotalSellAmt - TotalBuyAmt) for positions where netQty == 0
      Booked    = TotalSellAmt - TotalBuyAmt per position
    """
    positions = []
    realized_pnl = 0.0

    for p in raw_positions:
        fl_buy = int(p.get("flBuyQty", "0") or "0")
        fl_sell = int(p.get("flSellQty", "0") or "0")
        cf_buy_qty = int(p.get("cfBuyQty", "0") or "0")
        cf_sell_qty = int(p.get("cfSellQty", "0") or "0")

        total_buy_qty = cf_buy_qty + fl_buy
        total_sell_qty = cf_sell_qty + fl_sell
        net_qty = total_buy_qty - total_sell_qty

        buy_amt = float(p.get("buyAmt", "0") or "0")
        sell_amt = float(p.get("sellAmt", "0") or "0")
        cf_buy_amt = float(p.get("cfBuyAmt", "0") or "0")
        cf_sell_amt = float(p.get("cfSellAmt", "0") or "0")
        total_buy_amt = buy_amt + cf_buy_amt
        total_sell_amt = sell_amt + cf_sell_amt

        booked = total_sell_amt - total_buy_amt
        if net_qty == 0:
            realized_pnl += booked

        # Kotak avg price formula with multiplier/precision adjustments
        multiplier = int(p.get("multiplier", "1") or "1")
        gen_num = int(p.get("genNum", "1") or "1")
        gen_den = int(p.get("genDen", "1") or "1")
        prc_num = int(p.get("prcNum", "1") or "1")
        prc_den = int(p.get("prcDen", "1") or "1")
        precision = int(p.get("precision", "2") or "2")
        adj = multiplier * (gen_num / gen_den) * (prc_num / prc_den)

        if total_buy_qty > total_sell_qty:
            avg_price = total_buy_amt / (total_buy_qty * adj) if total_buy_qty > 0 else 0
        elif total_sell_qty > total_buy_qty:
            avg_price = total_sell_amt / (total_sell_qty * adj) if total_sell_qty > 0 else 0
        else:
            avg_price = 0
        avg_price = round(avg_price, precision)

        trd_sym = p.get("trdSym", "")
        sym = p.get("sym", "")
        ex_seg = p.get("exSeg", "")
        prod = p.get("prod", "NRML")
        opt_tp = p.get("optTp", "")
        stk_prc = p.get("stkPrc", "0")
        exp_dt = p.get("expDt", "")
        lot_sz = int(p.get("lotSz", "1") or "1")

        symbol = trd_sym
        exchange = exchange_from_segment(ex_seg)

        # Build cache-compatible symbol: "NIFTY 260317 23800 CE"
        cache_sym = _build_cache_symbol(symbol, sym, opt_tp, stk_prc, exp_dt)

        # ₹ per unit qty per ₹1 price. Kotak's buy/sell amounts already carry
        # `adj`, so it is the multiplier consistent with bookedPnl; cross-check
        # against the scrip-master-verified config (GOLD 100, GOLDM 0.1).
        _check_value_multiplier(sym or trd_sym, adj)

        buy_avg = round(total_buy_amt / (total_buy_qty * adj), precision) if total_buy_qty > 0 else 0
        sell_avg = round(total_sell_amt / (total_sell_qty * adj), precision) if total_sell_qty > 0 else 0
        cf_qty = cf_buy_qty - cf_sell_qty

        positions.append({
            "symbol": cache_sym,
            "exchange": exchange,
            "tradingSymbol": trd_sym,
            "productType": prod,
            "optionType": opt_tp,
            "strikePrice": stk_prc,
            "expiry": exp_dt,
            "lotSize": lot_sz,
            "totalBuyQty": total_buy_qty,
            "totalSellQty": total_sell_qty,
            "netQty": net_qty,
            "carryForwardQty": cf_qty,
            "quantity": net_qty,
            "side": "BUY" if net_qty > 0 else ("SELL" if net_qty < 0 else "CLOSED"),
            "isOpen": net_qty != 0,
            "totalBuyAmt": round(total_buy_amt, 2),
            "totalSellAmt": round(total_sell_amt, 2),
            "buyAvgPrice": buy_avg,
            "sellAvgPrice": sell_avg,
            "avgPrice": avg_price,
            "ltp": 0,
            "pnl": round(booked, 2),
            "unrealizedPnl": 0,
            "bookedPnl": round(booked, 2),
            "multiplier": multiplier,
            "valueMultiplier": adj,
            "precision": precision,
        })

    return {
        "positions": positions,
        "realizedPnl": round(realized_pnl, 2),
    }


def _check_value_multiplier(symbol: str, adj: float) -> None:
    """Warn when Kotak's price adjustment disagrees with the instrument config."""
    m = re.match(r"^([A-Z]+)", symbol or "")
    if not m:
        return
    from shared.instruments import get_instrument_master

    try:
        cfg = get_instrument_master().get(m.group(1))
    except OSError:
        return
    if cfg is not None and abs(cfg.unit_multiplier - adj) > 1e-9:
        logger.warning(
            "positions.value_multiplier_mismatch",
            symbol=symbol, kotak_adj=adj, config_unit_multiplier=cfg.unit_multiplier,
        )


async def fetch_trade_report(
    base_url: str,
    access_token: str,
    sid: str,
) -> list[dict] | None:
    """Fetch today's trade fills from Kotak ``/quick/user/trades``.

    Returns a list of raw trade-fill dicts, or ``None`` on failure.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                f"{base_url}/quick/user/trades",
                headers={
                    "Auth": access_token,
                    "Sid": sid,
                    "neo-fin-key": "neotradeapi",
                    "accept": "application/json",
                },
            )
            data = resp.json()
        except Exception as exc:
            logger.warning("trades.kotak_fetch_failed", error=str(exc))
            return None

    if str(data.get("stat", "")).lower() != "ok" or "data" not in data:
        logger.debug("trades.kotak_empty", stat=data.get("stat"))
        return []

    return data["data"]


def compute_realized_from_trades(raw_trades: list[dict]) -> float:
    """Compute realized P&L from actual trade fills.

    Groups fills by trading symbol, sums buy/sell values, and computes
    realized P&L for symbols where net quantity is zero (fully closed today).
    This uses actual execution prices and avoids carry-forward settlement
    adjustments.
    """
    by_sym: dict[str, dict] = defaultdict(lambda: {
        "buy_qty": 0, "buy_val": 0.0, "sell_qty": 0, "sell_val": 0.0,
    })

    for t in raw_trades:
        key = t.get("trdSym", "")
        qty = int(t.get("fldQty", "0") or "0")
        prc = float(t.get("avgPrc", "0") or "0")
        multiplier = int(t.get("multiplier", "1") or "1")
        gen_num = int(t.get("genNum", "1") or "1")
        gen_den = int(t.get("genDen", "1") or "1")
        prc_num = int(t.get("prcNum", "1") or "1")
        prc_den = int(t.get("prcDen", "1") or "1")
        adj = multiplier * (gen_num / gen_den) * (prc_num / prc_den)
        val = qty * prc * adj

        if t.get("trnsTp") == "B":
            by_sym[key]["buy_qty"] += qty
            by_sym[key]["buy_val"] += val
        else:
            by_sym[key]["sell_qty"] += qty
            by_sym[key]["sell_val"] += val

    realized = 0.0
    for d in by_sym.values():
        if d["buy_qty"] == d["sell_qty"]:
            realized += d["sell_val"] - d["buy_val"]
    return round(realized, 2)


def enrich_positions_with_trades(
    positions: list[dict],
    raw_trades: list[dict],
) -> float:
    """Use trade fills to compute more accurate per-position P&L.

    For positions fully closed with both legs in today's fills, replaces the
    positions-API booked P&L with the trade-fill-based P&L.

    For carry-forward positions (only one leg in today's fills), keeps the
    positions-API P&L since the original entry price isn't in today's report.

    Returns the corrected total realized P&L.
    """
    # Build per-symbol trade summary
    by_sym: dict[str, dict] = defaultdict(lambda: {
        "buy_qty": 0, "buy_val": 0.0, "sell_qty": 0, "sell_val": 0.0,
    })
    for t in raw_trades:
        key = t.get("trdSym", "")
        qty = int(t.get("fldQty", "0") or "0")
        prc = float(t.get("avgPrc", "0") or "0")
        multiplier = int(t.get("multiplier", "1") or "1")
        gen_num = int(t.get("genNum", "1") or "1")
        gen_den = int(t.get("genDen", "1") or "1")
        prc_num = int(t.get("prcNum", "1") or "1")
        prc_den = int(t.get("prcDen", "1") or "1")
        adj = multiplier * (gen_num / gen_den) * (prc_num / prc_den)
        val = qty * prc * adj

        if t.get("trnsTp") == "B":
            by_sym[key]["buy_qty"] += qty
            by_sym[key]["buy_val"] += val
        else:
            by_sym[key]["sell_qty"] += qty
            by_sym[key]["sell_val"] += val

    realized = 0.0
    for pos in positions:
        # Only process closed positions (netQty == 0)
        if pos.get("netQty", 0) != 0:
            continue

        trd_sym = pos.get("tradingSymbol", "")
        trade = by_sym.get(trd_sym)

        if trade and trade["buy_qty"] == trade["sell_qty"] and trade["buy_qty"] > 0:
            # Both legs in today's trade report — use fill prices
            fill_pnl = round(trade["sell_val"] - trade["buy_val"], 2)
            pos["pnl"] = fill_pnl
            pos["bookedPnl"] = fill_pnl
            realized += fill_pnl
        else:
            # Carry-forward: one leg is from a previous day.
            # Keep positions-API booked P&L (includes CF settlement amounts).
            realized += pos.get("bookedPnl", 0)

    return round(realized, 2)


def _select_latest_cycle_fills(
    fills: list[dict[str, Any]],
    *,
    buy_qty: int,
    sell_qty: int,
) -> list[dict[str, Any]] | None:
    """Pick the most recent fills that make up the current position cycle.

    Kotak's position row quantities reflect only the latest active/closed cycle
    for a symbol, while trade_logs may contain older round-trips for the same
    contract. Walking backwards lets us isolate the fills that correspond to the
    current row and ignore earlier completed cycles.
    """
    needed_buy = max(buy_qty, 0)
    needed_sell = max(sell_qty, 0)
    selected: list[dict[str, Any]] = []

    for fill in reversed(fills):
        side = str(fill.get("side", "")).upper()
        qty = int(fill.get("quantity", 0) or 0)
        if qty <= 0:
            continue

        if side == "BUY" and needed_buy > 0:
            take = min(qty, needed_buy)
            selected.append({**fill, "quantity": take})
            needed_buy -= take
        elif side == "SELL" and needed_sell > 0:
            take = min(qty, needed_sell)
            selected.append({**fill, "quantity": take})
            needed_sell -= take

        if needed_buy == 0 and needed_sell == 0:
            break

    if needed_buy != 0 or needed_sell != 0:
        return None

    selected.reverse()
    return selected


def _compute_cycle_realized_pnl(fills: list[dict[str, Any]]) -> float:
    """Compute realized P&L for a single isolated fill cycle."""
    buy_queue: list[tuple[int, float, float]] = []
    sell_queue: list[tuple[int, float, float]] = []
    realized = 0.0

    for fill in fills:
        side = str(fill.get("side", "")).upper()
        qty = int(fill.get("quantity", 0) or 0)
        price = float(fill.get("price", 0) or 0)
        multiplier = float(fill.get("multiplier", 1) or 1)
        if qty <= 0 or price <= 0:
            continue

        if side == "BUY":
            remaining = qty
            while remaining > 0 and sell_queue:
                open_qty, open_price, open_multiplier = sell_queue[0]
                matched = min(remaining, open_qty)
                realized += matched * (open_price - price) * open_multiplier
                remaining -= matched
                if matched == open_qty:
                    sell_queue.pop(0)
                else:
                    sell_queue[0] = (open_qty - matched, open_price, open_multiplier)
            if remaining > 0:
                buy_queue.append((remaining, price, multiplier))
        elif side == "SELL":
            remaining = qty
            while remaining > 0 and buy_queue:
                open_qty, open_price, open_multiplier = buy_queue[0]
                matched = min(remaining, open_qty)
                realized += matched * (price - open_price) * open_multiplier
                remaining -= matched
                if matched == open_qty:
                    buy_queue.pop(0)
                else:
                    buy_queue[0] = (open_qty - matched, open_price, open_multiplier)
            if remaining > 0:
                sell_queue.append((remaining, price, multiplier))

    return round(realized, 2)


def _compute_snapshot_realized_component(pos: dict[str, Any]) -> float:
    """Estimate realized P&L embedded in a position row from broker snapshot fields.

    For carry-forward rows, ``totalSellAmt - totalBuyAmt`` mixes realized P&L
    with the premium/cost of any still-open quantity. Adding back the open
    position cost basis isolates the realized component already crystallized in
    the row.
    """
    total_sell_amt = float(pos.get("totalSellAmt", 0) or 0)
    total_buy_amt = float(pos.get("totalBuyAmt", 0) or 0)
    net_qty = int(pos.get("netQty", 0) or 0)
    avg_price = float(pos.get("avgPrice", 0) or 0)
    adj = float(pos.get("multiplier", 1) or 1)
    return round((total_sell_amt - total_buy_amt) + (net_qty * avg_price * adj), 2)


async def enrich_positions_with_trade_history(
    db_url: str,
    positions: list[dict],
    ucc: str = "",
) -> float | None:
    """Compute realized P&L across all rows using row-scoped fill history.

    Closed rows contribute their full realized P&L. Open rows can still contain
    a realized component from partially closed quantity; this function includes
    that component in the total while leaving ``bookedPnl`` unchanged for open
    rows so row-level MTM rendering keeps working.

    Carry-forward rows are special: broker snapshots reset cost basis using the
    carry-forward bucket, so original execution fills can over/understate the
    already crystallized portion. For those rows we prefer the broker-style
    snapshot decomposition.

    Returns ``None`` if trade history could not be queried.
    """
    from sqlalchemy import text
    from shared.db import get_engine

    engine = get_engine(db_url)
    query = text("""
        SELECT side, quantity, price, multiplier
        FROM trade_logs
        WHERE symbol = :symbol AND ucc = :ucc
        ORDER BY time ASC
    """)

    realized = 0.0

    try:
        async with engine.begin() as conn:
            for pos in positions:
                buy_qty = int(pos.get("totalBuyQty", 0) or 0)
                sell_qty = int(pos.get("totalSellQty", 0) or 0)
                symbol = str(pos.get("symbol", "") or "")
                net_qty = int(pos.get("netQty", 0) or 0)

                if not symbol or buy_qty <= 0 or sell_qty <= 0:
                    row_realized = float(pos.get("bookedPnl", 0) or 0) if net_qty == 0 else 0.0
                    pos["realizedPnlComponent"] = round(row_realized, 2)
                    realized += row_realized
                    continue

                result = await conn.execute(query, {"symbol": symbol, "ucc": ucc})
                fills = [
                    {
                        "side": row[0],
                        "quantity": row[1],
                        "price": row[2],
                        "multiplier": row[3] or pos.get("multiplier", 1) or 1,
                    }
                    for row in result.fetchall()
                ]

                row_realized: float | None = None
                cf_qty = int(pos.get("carryForwardQty", 0) or 0)
                if net_qty == 0:
                    if cf_qty != 0:
                        row_realized = _compute_snapshot_realized_component(pos)
                    else:
                        latest_cycle = _select_latest_cycle_fills(
                            fills,
                            buy_qty=buy_qty,
                            sell_qty=sell_qty,
                        )
                        if latest_cycle is not None:
                            row_realized = _compute_cycle_realized_pnl(latest_cycle)
                elif cf_qty != 0:
                    # For carry-forward rows that are still open, broker booked P&L
                    # mixes realized close-out with fresh open premium. Full-history
                    # FIFO isolates the portion already crystallized.
                    row_realized = _compute_cycle_realized_pnl(fills)
                else:
                    # Pure intraday open rows can have matched buy/sell fills but the
                    # broker headline realized P&L keeps them out until the row closes.
                    row_realized = 0.0

                if row_realized is None:
                    row_realized = float(pos.get("bookedPnl", 0) or 0) if net_qty == 0 else 0.0

                if net_qty == 0:
                    pos["bookedPnl"] = round(row_realized, 2)
                    pos["pnl"] = round(row_realized, 2)
                pos["realizedPnlComponent"] = round(row_realized, 2)
                realized += row_realized
    except Exception as exc:
        logger.warning("positions.trade_history_enrichment_failed", error=str(exc)[:200])
        return None

    return round(realized, 2)


def _build_position_records(positions: list[dict]) -> list[dict]:
    """Convert camelCase position dicts into DB column records."""
    records = []
    for p in positions:
        trd = p.get("tradingSymbol", "")
        if not trd:
            continue
        records.append({
            "trading_symbol": trd,
            "symbol": p.get("symbol", trd),
            "exchange": p.get("exchange", ""),
            "product_type": p.get("productType", ""),
            "option_type": p.get("optionType", ""),
            "strike_price": str(p.get("strikePrice", "")),
            "expiry": p.get("expiry", ""),
            "lot_size": p.get("lotSize", 1),
            "total_buy_qty": p.get("totalBuyQty", 0),
            "total_sell_qty": p.get("totalSellQty", 0),
            "net_qty": p.get("netQty", 0),
            "cf_qty": p.get("carryForwardQty", 0),
            "side": p.get("side", ""),
            "is_open": p.get("isOpen", True),
            "total_buy_amt": p.get("totalBuyAmt", 0),
            "total_sell_amt": p.get("totalSellAmt", 0),
            "buy_avg_price": p.get("buyAvgPrice", 0),
            "sell_avg_price": p.get("sellAvgPrice", 0),
            "avg_price": p.get("avgPrice", 0),
            "booked_pnl": p.get("bookedPnl", 0),
            "multiplier": p.get("multiplier", 1),
            "precision": p.get("precision", 2),
        })
    return records


async def save_positions(db_url: str, positions: list[dict]) -> None:
    """Full snapshot replace: DELETE all → INSERT fresh in one transaction.

    Uses a PostgreSQL advisory lock to serialize concurrent callers so two
    overlapping saves never interleave their DELETE/INSERT statements.
    """
    from sqlalchemy import text
    from shared.db import get_engine

    engine = get_engine(db_url)
    records = _build_position_records(positions)

    insert_sql = text("""
        INSERT INTO positions (
            trading_symbol, symbol, exchange, product_type, option_type,
            strike_price, expiry, lot_size, total_buy_qty, total_sell_qty,
            net_qty, cf_qty, side, is_open, total_buy_amt, total_sell_amt,
            buy_avg_price, sell_avg_price, avg_price, booked_pnl,
            multiplier, precision, updated_at
        ) VALUES (
            :trading_symbol, :symbol, :exchange, :product_type, :option_type,
            :strike_price, :expiry, :lot_size, :total_buy_qty, :total_sell_qty,
            :net_qty, :cf_qty, :side, :is_open, :total_buy_amt, :total_sell_amt,
            :buy_avg_price, :sell_avg_price, :avg_price, :booked_pnl,
            :multiplier, :precision, now()
        )
    """)

    # Advisory lock key — unique to positions table writes
    _LOCK_ID = 900_001

    try:
        async with engine.begin() as conn:
            # Serialize concurrent position saves at the DB level
            await conn.execute(text(f"SELECT pg_advisory_xact_lock({_LOCK_ID})"))
            await conn.execute(text("DELETE FROM positions"))
            if records:
                await conn.execute(insert_sql, records)
        logger.debug("positions.saved", count=len(records))
    except Exception as exc:
        logger.warning("positions.save_failed", error=str(exc)[:200])


async def load_positions(db_url: str) -> list[dict]:
    """Load current positions from the DB."""
    from sqlalchemy import text
    from shared.db import get_engine

    engine = get_engine(db_url)

    try:
        async with engine.begin() as conn:
            result = await conn.execute(text(
                "SELECT * FROM positions ORDER BY is_open DESC, trading_symbol"
            ))
            rows = result.fetchall()
            columns = result.keys()
    except Exception as exc:
        logger.warning("positions.load_failed", error=str(exc)[:200])
        return []

    positions = []
    for row in rows:
        r = dict(zip(columns, row))
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
            "precision": r["precision"],
        })

    return positions


async def reconcile_positions(
    db_url: str,
    fresh_positions: list[dict],
) -> list[str]:
    """Atomically: read old state → compute diff → overwrite with fresh snapshot.

    All three steps run inside a single transaction with an advisory lock, so no
    concurrent save_positions can slip in between the read and the write.
    """
    from sqlalchemy import text
    from shared.db import get_engine

    engine = get_engine(db_url)
    records = _build_position_records(fresh_positions)

    insert_sql = text("""
        INSERT INTO positions (
            trading_symbol, symbol, exchange, product_type, option_type,
            strike_price, expiry, lot_size, total_buy_qty, total_sell_qty,
            net_qty, cf_qty, side, is_open, total_buy_amt, total_sell_amt,
            buy_avg_price, sell_avg_price, avg_price, booked_pnl,
            multiplier, precision, updated_at
        ) VALUES (
            :trading_symbol, :symbol, :exchange, :product_type, :option_type,
            :strike_price, :expiry, :lot_size, :total_buy_qty, :total_sell_qty,
            :net_qty, :cf_qty, :side, :is_open, :total_buy_amt, :total_sell_amt,
            :buy_avg_price, :sell_avg_price, :avg_price, :booked_pnl,
            :multiplier, :precision, now()
        )
    """)

    _LOCK_ID = 900_001
    diffs: list[str] = []

    try:
        async with engine.begin() as conn:
            # Hold lock for the entire read-diff-write cycle
            await conn.execute(text(f"SELECT pg_advisory_xact_lock({_LOCK_ID})"))

            # Read old state
            result = await conn.execute(text(
                "SELECT trading_symbol, net_qty, side FROM positions"
            ))
            old_rows = {r[0]: {"netQty": r[1], "side": r[2]} for r in result.fetchall()}

            # Compute diff
            fresh_syms: set[str] = set()
            for p in fresh_positions:
                trd = p.get("tradingSymbol", "")
                if not trd:
                    continue
                fresh_syms.add(trd)
                prev = old_rows.get(trd)
                if prev is None:
                    diffs.append(f"NEW {trd} qty={p.get('netQty')}")
                else:
                    if prev["netQty"] != p.get("netQty"):
                        diffs.append(f"QTY {trd} {prev['netQty']} → {p.get('netQty')}")
                    if prev["side"] != p.get("side"):
                        diffs.append(f"SIDE {trd} {prev['side']} → {p.get('side')}")

            for sym in old_rows:
                if sym not in fresh_syms:
                    diffs.append(f"GONE {sym} (closed or expired)")

            # Overwrite: delete all → insert fresh
            await conn.execute(text("DELETE FROM positions"))
            if records:
                await conn.execute(insert_sql, records)

        logger.debug("positions.reconciled", count=len(records), diffs=len(diffs))
    except Exception as exc:
        logger.warning("positions.reconcile_failed", error=str(exc)[:200])

    return diffs


def _build_cache_symbol(
    trd_sym: str, sym: str, opt_tp: str, stk_prc: str, exp_dt: str
) -> str:
    """Build cache-compatible symbol like 'NIFTY 260317 23800 CE'."""
    if opt_tp and stk_prc and stk_prc != "0.00" and exp_dt:
        try:
            exp_clean = re.sub(r",\s*", " ", exp_dt.strip())
            exp_parsed = _dt.strptime(exp_clean, "%d %b %Y")
            exp_compact = exp_parsed.strftime("%y%m%d")
            strike_val = float(stk_prc)
            strike_str = str(int(strike_val)) if strike_val == int(strike_val) else str(strike_val)
            return f"{sym} {exp_compact} {strike_str} {opt_tp}"
        except Exception:
            pass
    return trd_sym
