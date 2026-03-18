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

import httpx
import structlog

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

    return transform_kotak_positions(data["data"])


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
        exchange = "NSE" if "nse" in ex_seg else "BSE" if "bse" in ex_seg else ex_seg.upper()

        # Build cache-compatible symbol: "NIFTY 260317 23800 CE"
        cache_sym = _build_cache_symbol(symbol, sym, opt_tp, stk_prc, exp_dt)

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
            "precision": precision,
        })

    return {
        "positions": positions,
        "realizedPnl": round(realized_pnl, 2),
    }


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
