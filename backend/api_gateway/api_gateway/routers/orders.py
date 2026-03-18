"""Order routes – proxy requests to the order service via httpx."""

from __future__ import annotations

import asyncio
import json as _json
import re
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from api_gateway.config import settings

router = APIRouter(prefix="/api/v1", tags=["orders"])
log = structlog.get_logger()


class ModifyOrderRequest(BaseModel):
    quantity: int = Field(..., ge=1)
    price: float = Field(default=0, ge=0)
    trigger_price: float = Field(default=0, ge=0)
    disclosed_quantity: int = Field(default=0, ge=0)
    validity: str = "DAY"
    order_type: str


class PlaceOrderLeg(BaseModel):
    trading_symbol: str | None = None
    underlying: str | None = None
    expiry: str | None = None
    strike: float | None = None
    option_type: str | None = None  # "CE" or "PE"
    transaction_type: str  # "B" or "S"
    quantity: int = Field(..., ge=1)
    order_type: str = "MKT"  # "L", "MKT", "SL", "SL-M"
    product: str = "NRML"
    price: float = 0
    trigger_price: float = 0
    disclosed_quantity: int = 0
    tag: str | None = None


class PlaceOrdersRequest(BaseModel):
    orders: list[PlaceOrderLeg]


class PlaceOrderResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    index: int
    success: bool
    order_number: str | None = None
    error: str | None = None
    trading_symbol: str | None = None


class MarginPreviewLeg(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    index: int
    success: bool
    trading_symbol: str | None = None
    exchange_segment: str | None = None
    required_margin: float | None = None
    available_cash: float | None = None
    available_margin: float | None = None
    order_margin: float | None = None
    margin_used: float | None = None
    insufficient_fund: float | None = None
    validation: str | None = None
    error: str | None = None


class MarginPreviewResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    legs: list[MarginPreviewLeg]
    total_required_margin: float | None = None
    available_cash: float | None = None
    available_margin: float | None = None
    account_net: float | None = None
    account_margin_used: float | None = None
    raw_limits: dict[str, Any] | None = None


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _split_by_freeze(qty: int, freeze_qty: int, lot_size: int) -> list[int]:
    """Split quantity into chunks respecting freeze limit and lot size."""
    if freeze_qty <= 0 or qty <= freeze_qty:
        return [qty]
    chunks: list[int] = []
    remaining = qty
    while remaining > 0:
        chunk = min(remaining, freeze_qty)
        chunk = (chunk // lot_size) * lot_size
        if chunk <= 0:
            # Remaining is less than one lot — place exactly what's left
            chunk = remaining
        chunks.append(chunk)
        remaining -= chunk
    return chunks


async def _get_neo_client():
    """Initialize a NeoAPI client from cached Kotak credentials."""
    from neo_api_client import NeoAPI
    from shared.redis_client import cache_get

    creds_raw = await cache_get(settings.redis_url, "cache:auth:kotak")
    if not creds_raw:
        raise HTTPException(status_code=401, detail="Kotak session unavailable")

    creds = _json.loads(creds_raw)
    access_token = creds.get("access_token", "")
    sid = creds.get("extra", {}).get("sid", "")
    base_url = creds.get("extra", {}).get("base_url", "")

    if not access_token or not base_url:
        raise HTTPException(status_code=401, detail="Kotak session unavailable")

    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    environment = settings.kotak_environment or "prod"
    client = NeoAPI(
        consumer_key=settings.kotak_consumer_key,
        environment=environment,
        access_token=access_token,
    )
    # Inject authenticated session state — SDK guards on edit_token + edit_sid
    client.configuration.bearer_token = access_token
    client.configuration.edit_token = access_token
    client.configuration.edit_sid = sid
    client.configuration.edit_rid = creds.get("extra", {}).get("rid", "")
    client.configuration.serverId = creds.get("extra", {}).get("hsServerId", sid)
    client.configuration.sid = sid
    client.configuration.base_url = base_url

    return client


async def _resolve_order_legs(orders: list[PlaceOrderLeg]) -> tuple[list[dict[str, Any]], list[PlaceOrderResult]]:
    from shared.redis_client import get_redis
    from shared.instruments import get_instrument_master

    im = get_instrument_master()
    resolved_legs: list[dict[str, Any]] = []
    errors: list[PlaceOrderResult] = []

    for i, leg in enumerate(orders):
        trading_symbol = leg.trading_symbol
        underlying = leg.underlying
        exchange_segment = ""
        scrip_token = ""

        if not trading_symbol:
            if not (leg.underlying and leg.expiry and leg.strike and leg.option_type):
                errors.append(PlaceOrderResult(
                    index=i,
                    success=False,
                    error="Missing required fields: underlying, expiry, strike, option_type",
                ))
                continue
            underlying = leg.underlying.upper()
            strike_key = int(leg.strike) if leg.strike == int(leg.strike) else leg.strike
            field = f"{strike_key}:{leg.option_type}"
            async with get_redis(settings.redis_url) as redis_client:
                trading_symbol = await redis_client.hget(
                    f"cache:scrip:trdsym:{underlying}:{leg.expiry}", field
                )
                scrip_token = await redis_client.hget(
                    f"cache:scrip:token:{underlying}:{leg.expiry}", field
                ) or ""
            if not trading_symbol:
                errors.append(PlaceOrderResult(
                    index=i,
                    success=False,
                    error=f"Trading symbol not found for {underlying} {leg.expiry} {strike_key} {leg.option_type}",
                ))
                continue
        else:
            m = re.match(r"^([A-Z]+)", trading_symbol)
            if m:
                underlying = m.group(1)
            # Resolve numeric scrip token via reverse lookup
            async with get_redis(settings.redis_url) as redis_client:
                scrip_token = await redis_client.hget("cache:scrip:sym2tok", trading_symbol) or ""

        cfg = im.get(underlying or "")
        if cfg:
            exchange_segment = cfg.segment
        if not exchange_segment:
            exchange_segment = "nse_fo"

        resolved_legs.append({
            "original_index": i,
            "trading_symbol": trading_symbol,
            "scrip_token": scrip_token,
            "exchange_segment": exchange_segment,
            "transaction_type": leg.transaction_type,
            "quantity": leg.quantity,
            "order_type": leg.order_type,
            "product": leg.product,
            "price": leg.price,
            "trigger_price": leg.trigger_price,
            "disclosed_quantity": leg.disclosed_quantity,
            "tag": leg.tag,
        })

    return resolved_legs, errors


def _parse_json_response(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return {"raw": resp.text}


async def _load_kotak_session() -> tuple[str, dict[str, str]]:
    import json as _json

    from shared.redis_client import cache_get

    creds_raw = await cache_get(settings.redis_url, "cache:auth:kotak")
    if not creds_raw:
        raise HTTPException(status_code=401, detail="Kotak session unavailable")

    creds = _json.loads(creds_raw)
    base_url = creds.get("extra", {}).get("base_url", "")
    access_token = creds.get("access_token", "")
    sid = creds.get("extra", {}).get("sid", "")

    if not base_url or not access_token:
        raise HTTPException(status_code=401, detail="Kotak session unavailable")
    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"

    return base_url.rstrip("/"), {
        "Auth": access_token,
        "Sid": sid,
        "neo-fin-key": "neotradeapi",
    }


async def _kotak_request(
    request: Request,
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
) -> Any:
    base_url, headers = await _load_kotak_session()
    client = _client(request)

    try:
        resp = await client.request(
            method,
            f"{base_url}/{path.lstrip('/')}",
            headers=headers,
            json=json,
            timeout=10.0,
        )
    except httpx.RequestError as exc:
        log.error("orders.kotak_request_failed", method=method, path=path, error=str(exc))
        raise HTTPException(status_code=502, detail="Kotak order endpoint unavailable")

    payload = _parse_json_response(resp)
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=payload)

    if isinstance(payload, dict) and str(payload.get("stat", "")).lower() not in {"", "ok"}:
        raise HTTPException(status_code=400, detail=payload)

    return payload


def _client(request: Request) -> httpx.AsyncClient:
    """Retrieve the shared httpx client from app state."""
    return request.app.state.http_client


async def _proxy(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    **kwargs: Any,
) -> Any:
    """Forward a request to the order service and return the JSON response."""
    url = f"{settings.order_service_url}{path}"
    try:
        resp = await client.request(method, url, **kwargs)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=exc.response.text,
        )
    except httpx.RequestError as exc:
        log.error("orders.proxy_error", url=url, error=str(exc))
        raise HTTPException(status_code=502, detail="Order service unavailable")


@router.post("/basket")
async def create_basket(request: Request):
    return await _proxy(_client(request), "POST", "/api/v1/basket")


@router.post("/basket/{basket_id}/leg")
async def add_leg(basket_id: str, request: Request):
    body = await request.json()
    return await _proxy(
        _client(request), "POST", f"/api/v1/basket/{basket_id}/leg", json=body
    )


@router.delete("/basket/{basket_id}/leg/{order_id}")
async def remove_leg(basket_id: str, order_id: str, request: Request):
    return await _proxy(
        _client(request), "DELETE", f"/api/v1/basket/{basket_id}/leg/{order_id}"
    )


@router.post("/basket/{basket_id}/submit")
async def submit_basket(basket_id: str, request: Request):
    return await _proxy(
        _client(request), "POST", f"/api/v1/basket/{basket_id}/submit"
    )


@router.post("/place-orders")
async def place_orders(body: PlaceOrdersRequest, request: Request):
    """Place one or more orders via Kotak Neo SDK.

    Handles new orders, square-off, and partial exit.
    BUY orders are placed before SELL orders.
    Orders exceeding freeze quantity limits are split automatically.
    """
    from shared.redis_client import cache_hgetall

    if not body.orders:
        raise HTTPException(status_code=400, detail="No orders provided")

    neo_client = await _get_neo_client()

    # Load freeze quantities and lot sizes from Redis
    freeze_map: dict[str, int] = {}
    lot_map: dict[str, int] = {}
    raw_fq = await cache_hgetall(settings.redis_url, "cache:freeze_quantities")
    if raw_fq:
        freeze_map = {k: int(v) for k, v in raw_fq.items()}
    raw_lots = await cache_hgetall(settings.redis_url, "cache:lot_sizes")
    if raw_lots:
        lot_map = {k: int(v) for k, v in raw_lots.items()}

    results: list[PlaceOrderResult] = []
    resolved_legs, resolve_errors = await _resolve_order_legs(body.orders)
    results.extend(resolve_errors)
    expanded_legs: list[dict[str, Any]] = []

    for rl in resolved_legs:
        underlying = ""
        m = re.match(r"^([A-Z]+)", rl["trading_symbol"])
        if m:
            underlying = m.group(1)
        # Determine freeze qty and lot size
        freeze_qty = freeze_map.get(underlying, 0)
        lot_size = lot_map.get(underlying, 1)
        if lot_size < 1:
            lot_size = 1

        # Split by freeze quantity
        qty_chunks = _split_by_freeze(rl["quantity"], freeze_qty, lot_size)

        for chunk_qty in qty_chunks:
            expanded_legs.append({
                "original_index": rl["original_index"],
                "trading_symbol": rl["trading_symbol"],
                "exchange_segment": rl["exchange_segment"],
                "transaction_type": rl["transaction_type"],
                "quantity": chunk_qty,
                "order_type": rl["order_type"],
                "product": rl["product"],
                "price": rl["price"],
                "trigger_price": rl["trigger_price"],
                "disclosed_quantity": rl["disclosed_quantity"],
                "tag": rl["tag"],
            })

    # Sort: BUY orders first, then SELL
    buy_legs = [rl for rl in expanded_legs if rl["transaction_type"] == "B"]
    sell_legs = [rl for rl in expanded_legs if rl["transaction_type"] == "S"]
    ordered = buy_legs + sell_legs

    # Track whether any BUY failed (skip SELLs if so)
    buy_failed = False
    placed_indices: set[int] = set()

    for rl in ordered:
        idx = rl["original_index"]

        if buy_failed and rl["transaction_type"] == "S":
            if idx not in placed_indices:
                results.append(PlaceOrderResult(
                    index=idx, success=False,
                    error="Skipped SELL — a preceding BUY order failed",
                    trading_symbol=rl["trading_symbol"],
                ))
                placed_indices.add(idx)
            continue

        try:
            result = await asyncio.to_thread(
                neo_client.place_order,
                exchange_segment=rl["exchange_segment"],
                product=rl["product"],
                order_type=rl["order_type"],
                quantity=str(rl["quantity"]),
                validity="DAY",
                trading_symbol=rl["trading_symbol"],
                transaction_type=rl["transaction_type"],
                price=str(rl["price"]),
                trigger_price=str(rl["trigger_price"]),
                amo="NO",
                disclosed_quantity=str(rl["disclosed_quantity"]),
                market_protection="0",
                pf="N",
                tag=rl["tag"] or None,
            )
            log.info("orders.place_order_result", index=idx, result=result)

            # Parse SDK response
            order_number = None
            error_msg = None
            if isinstance(result, dict):
                stat = str(result.get("stat", "")).lower()
                if stat == "ok":
                    order_number = result.get("nOrdNo") or result.get("data", {}).get("nOrdNo")
                else:
                    error_msg = result.get("errMsg") or result.get("message") or str(result)
            else:
                error_msg = str(result)

            if error_msg and not order_number:
                if rl["transaction_type"] == "B":
                    buy_failed = True
                results.append(PlaceOrderResult(
                    index=idx, success=False, error=error_msg,
                    trading_symbol=rl["trading_symbol"],
                ))
            else:
                results.append(PlaceOrderResult(
                    index=idx, success=True, order_number=order_number,
                    trading_symbol=rl["trading_symbol"],
                ))
            placed_indices.add(idx)

        except Exception as exc:
            log.error("orders.place_order_error", index=idx, error=str(exc))
            if rl["transaction_type"] == "B":
                buy_failed = True
            results.append(PlaceOrderResult(
                index=idx, success=False, error=str(exc),
                trading_symbol=rl["trading_symbol"],
            ))
            placed_indices.add(idx)

    # Sort results by original index
    results.sort(key=lambda r: r.index)
    return results


@router.post("/margin-preview", response_model=MarginPreviewResponse)
async def margin_preview(body: PlaceOrdersRequest, request: Request):
    """Estimate per-leg margin via Kotak /quick/user/check-margin REST API."""
    if not body.orders:
        raise HTTPException(status_code=400, detail="No orders provided")

    resolved_legs, resolve_errors = await _resolve_order_legs(body.orders)

    preview_legs: list[MarginPreviewLeg] = [
        MarginPreviewLeg(
            index=error.index,
            success=False,
            trading_symbol=error.trading_symbol,
            error=error.error,
        )
        for error in resolve_errors
    ]

    base_url, headers = await _load_kotak_session()
    client = _client(request)

    margin_headers = {**headers, "Content-Type": "application/x-www-form-urlencoded"}
    for rl in resolved_legs:
        try:
            jdata = _json.dumps({
                "actId": "",
                "brkName": "kotak",
                "brnchId": "kotak",
                "exSeg": rl["exchange_segment"],
                "prc": str(rl["price"]),
                "prcTp": rl["order_type"],
                "prod": rl["product"],
                "qty": str(rl["quantity"]),
                "tok": rl.get("scrip_token", ""),
                "trnsTp": rl["transaction_type"],
                "slAbsOrTks": "",
                "sqrOffAbsOrTks": "",
                "slVal": "",
                "sqrOffVal": "",
                "ordSrc": "",
            })
            resp = await client.post(
                f"{base_url}/quick/user/check-margin",
                headers=margin_headers,
                content=f"jData={jdata}",
                timeout=10.0,
            )
            data = resp.json() if resp.status_code == 200 else {}
            stat = str(data.get("stat", "")).lower()
            if stat == "ok":
                preview_legs.append(MarginPreviewLeg(
                    index=rl["original_index"],
                    success=True,
                    trading_symbol=rl["trading_symbol"],
                    exchange_segment=rl["exchange_segment"],
                    required_margin=_safe_float(data.get("reqdMrgn")),
                    available_cash=_safe_float(data.get("avlCash")),
                    available_margin=_safe_float(data.get("avlMrgn")),
                    order_margin=_safe_float(data.get("ordMrgn")),
                    margin_used=_safe_float(data.get("mrgnUsd")) or _safe_float(data.get("totMrgnUsd")),
                    insufficient_fund=_safe_float(data.get("insufFund")),
                    validation=data.get("rmsVldtd"),
                ))
            else:
                preview_legs.append(MarginPreviewLeg(
                    index=rl["original_index"],
                    success=False,
                    trading_symbol=rl["trading_symbol"],
                    exchange_segment=rl["exchange_segment"],
                    error=data.get("errMsg") or data.get("message") or str(data),
                ))
        except Exception as exc:
            preview_legs.append(MarginPreviewLeg(
                index=rl["original_index"],
                success=False,
                trading_symbol=rl["trading_symbol"],
                exchange_segment=rl["exchange_segment"],
                error=str(exc),
            ))

    preview_legs.sort(key=lambda leg: leg.index)

    # Fetch account limits
    limits_data: dict[str, Any] | None = None
    try:
        limits_jdata = _json.dumps({"seg": "ALL", "exch": "ALL", "prod": "ALL"})
        limits_resp = await client.post(
            f"{base_url}/quick/user/limits",
            headers=margin_headers,
            content=f"jData={limits_jdata}",
            timeout=10.0,
        )
        if limits_resp.status_code == 200:
            limits_data = limits_resp.json()
    except Exception:
        pass

    successful_legs = [leg for leg in preview_legs if leg.success]
    total_order_margin = sum(leg.order_margin or 0 for leg in successful_legs)

    return MarginPreviewResponse(
        legs=preview_legs,
        total_required_margin=round(total_order_margin, 2) if successful_legs else None,
        available_cash=_safe_float(limits_data.get("Net")) if limits_data else None,
        available_margin=_safe_float(limits_data.get("Net")) if limits_data else None,
        account_net=_safe_float(limits_data.get("Net")) if limits_data else None,
        account_margin_used=_safe_float(limits_data.get("MarginUsed")) or _safe_float(limits_data.get("MarginUsedPrsnt")) if limits_data else None,
        raw_limits=limits_data,
    )


@router.get("/order-book")
async def get_order_book(request: Request):
    """Fetch full order book from Kotak, split into open and closed."""
    try:
        data = await _kotak_request(request, "GET", "/quick/user/orders")
    except HTTPException as exc:
        log.warning("orders.kotak_fetch_failed", error=str(exc))
        return {"open": [], "closed": []}

    if str(data.get("stat", "")).lower() != "ok" or "data" not in data:
        return {"open": [], "closed": []}

    OPEN_STATUSES = {"open", "open pending", "trigger pending",
                     "validation pending", "put order req received",
                     "after market order req received", "modified"}

    open_orders = []
    closed_orders = []

    for o in data["data"]:
        ex_seg = str(o.get("exSeg", "") or o.get("exchange", ""))
        exchange = (
            "NSE" if "nse" in ex_seg.lower()
            else "BSE" if "bse" in ex_seg.lower()
            else ex_seg.upper()
        )
        row = {
            "orderId": o.get("nOrdNo", ""),
            "tradingSymbol": o.get("trdSym", ""),
            "symbol": o.get("sym", ""),
            "exchange": exchange,
            "side": "BUY" if o.get("trnsTp") == "B" else "SELL",
            "quantity": int(o.get("qty", "0") or "0"),
            "filledQty": int(o.get("fldQty", "0") or "0"),
            "unfilledQty": int(o.get("unFldSz", "0") or "0"),
            "disclosedQty": int(o.get("dQty", "0") or "0"),
            "price": float(o.get("prc", "0") or "0"),
            "triggerPrice": float(o.get("trgPrc", "0") or "0"),
            "avgPrice": float(o.get("avgPrc", "0") or "0"),
            "orderType": o.get("prcTp", ""),
            "productType": o.get("prod", ""),
            "validity": o.get("validity", "") or o.get("vlDt", ""),
            "status": o.get("ordSt", ""),
            "optionType": o.get("optTp", ""),
            "strikePrice": o.get("stkPrc", ""),
            "expiry": o.get("expDt", ""),
            "time": o.get("ordDtTm", ""),
        }

        if str(o.get("ordSt", "")).lower() in OPEN_STATUSES:
            open_orders.append(row)
        else:
            closed_orders.append(row)

    # Sort both by time descending (most recent first)
    open_orders.sort(key=lambda x: x.get("time", ""), reverse=True)
    closed_orders.sort(key=lambda x: x.get("time", ""), reverse=True)

    return {"open": open_orders, "closed": closed_orders}


@router.post("/orders/{order_id}/cancel")
async def cancel_order(order_id: str, request: Request):
    payload = await _kotak_request(
        request,
        "POST",
        "/quick/order/cancel",
        json={
            "order_id": order_id,
            "amo": "NO",
        },
    )
    return {"ok": True, "result": payload}


@router.post("/orders/{order_id}/modify")
async def modify_order(
    order_id: str,
    body: ModifyOrderRequest,
    request: Request,
):
    payload = await _kotak_request(
        request,
        "POST",
        "/quick/order/vr/modify",
        json={
            "order_id": order_id,
            "price": str(body.price),
            "quantity": str(body.quantity),
            "disclosed_quantity": str(body.disclosed_quantity),
            "trigger_price": str(body.trigger_price),
            "validity": body.validity,
            "order_type": body.order_type,
        },
    )
    return {"ok": True, "result": payload}


@router.get("/positions")
async def get_positions(request: Request):
    """Fetch positions from Kotak API, enrich with trade fills and cached LTP."""
    import json as _json
    from shared.positions import (
        enrich_positions_with_trades,
        fetch_kotak_positions,
        fetch_trade_report,
    )
    from shared.redis_client import cache_get

    creds_raw = await cache_get(settings.redis_url, "cache:auth:kotak")
    if not creds_raw:
        return []

    creds = _json.loads(creds_raw)
    base_url = creds.get("extra", {}).get("base_url", "")
    access_token = creds.get("access_token", "")
    sid = creds.get("extra", {}).get("sid", "")

    if not base_url or not access_token:
        return []
    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    result = await fetch_kotak_positions(base_url, access_token, sid)
    if not result:
        return []

    # Fetch trade report and use actual fill prices for realized P&L
    trades = await fetch_trade_report(base_url, access_token, sid)
    if trades:
        corrected_realized = enrich_positions_with_trades(
            result["positions"], trades
        )
        result["realizedPnl"] = corrected_realized

    # Inline LTP enrichment for the initial REST response so the UI isn't
    # all zeros before the option chain WebSocket delivers live ticks.
    for pos in result.get("positions", []):
        sym = pos.get("symbol", "")
        if not sym:
            continue
        ltp_raw = await cache_get(settings.redis_url, f"cache:ltp:{sym}")
        if not ltp_raw:
            continue
        try:
            tick = _json.loads(ltp_raw)
            ltp = float(tick.get("ltp", 0))
        except (ValueError, _json.JSONDecodeError):
            continue
        if ltp > 0:
            pos["ltp"] = ltp
            net_qty = pos.get("netQty", 0)
            adj = pos.get("multiplier", 1)
            unrealized = net_qty * ltp * adj
            pos["unrealizedPnl"] = round(unrealized, 2)
            pos["pnl"] = round(pos.get("bookedPnl", 0) + unrealized, 2)

    return result


@router.get("/trade-report")
async def get_trade_report(request: Request):
    """Fetch today's trade fills from Kotak, grouped by symbol with P&L."""
    import json as _json
    from shared.positions import compute_realized_from_trades, fetch_trade_report
    from shared.redis_client import cache_get

    creds_raw = await cache_get(settings.redis_url, "cache:auth:kotak")
    if not creds_raw:
        return {"trades": [], "realizedPnl": 0}

    creds = _json.loads(creds_raw)
    base_url = creds.get("extra", {}).get("base_url", "")
    access_token = creds.get("access_token", "")
    sid = creds.get("extra", {}).get("sid", "")

    if not base_url or not access_token:
        return {"trades": [], "realizedPnl": 0}
    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    raw = await fetch_trade_report(base_url, access_token, sid)
    if not raw:
        return {"trades": [], "realizedPnl": 0}

    # Transform fills into frontend-friendly format
    trades = []
    for t in raw:
        trades.append({
            "orderId": t.get("nOrdNo", ""),
            "fillId": t.get("flId", ""),
            "tradingSymbol": t.get("trdSym", ""),
            "symbol": t.get("sym", ""),
            "side": "BUY" if t.get("trnsTp") == "B" else "SELL",
            "quantity": int(t.get("fldQty", "0") or "0"),
            "price": float(t.get("avgPrc", "0") or "0"),
            "value": int(t.get("fldQty", "0") or "0") * float(t.get("avgPrc", "0") or "0"),
            "orderType": t.get("prcTp", ""),
            "productType": t.get("prod", ""),
            "optionType": t.get("optTp", ""),
            "strikePrice": t.get("stkPrc", ""),
            "expiry": t.get("expDt", ""),
            "exchange": t.get("exSeg", ""),
            "fillTime": t.get("flTm", ""),
            "fillDate": t.get("flDt", ""),
        })

    trades.sort(key=lambda x: x.get("fillTime", ""), reverse=True)

    return {
        "trades": trades,
        "realizedPnl": compute_realized_from_trades(raw),
    }
