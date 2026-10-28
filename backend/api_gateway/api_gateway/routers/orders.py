"""Order routes – proxy requests to the order service via httpx."""

from __future__ import annotations

import asyncio
import json as _json
import os
import re
from typing import Any

import httpx
import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from shared.instruments import exchange_from_segment, get_instrument_master
from shared.live_session import get_active_ucc

from api_gateway.config import settings

router = APIRouter(prefix="/api/v1", tags=["orders"])
log = structlog.get_logger()

# SDK v3 validates order parameters client-side and rejects anything outside
# these sets — generic aliases ("NSE", "Limit", "CO", "GTC") that v2 silently
# resolved now come back as an opaque {"Error": ApiValueError(...)} dict. We
# mirror the allow-lists here so a bad value fails as a 422 at the boundary,
# naming the offending field, instead of surfacing as a failed order.
_VALID_SEGMENTS = frozenset({"nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"})
_VALID_ORDER_TYPES = frozenset({"L", "MKT", "SL", "SL-M"})
_VALID_PRODUCTS = frozenset({"CNC", "NRML", "MIS", "MTF"})
# mcx_fo is DAY-only; enforced per-segment in _validate_validity().
_VALID_VALIDITIES = frozenset({"DAY", "IOC"})
# Order types that carry a real limit price. v3 rejects price<=0 for these
# because the exchange would otherwise substitute a default and fill at a
# nonsense price.
_LIMIT_ORDER_TYPES = frozenset({"L", "SL"})


def _validate_order_type(v: str) -> str:
    if v not in _VALID_ORDER_TYPES:
        raise ValueError(f"order_type must be one of {sorted(_VALID_ORDER_TYPES)}, got {v!r}")
    return v


def _validate_product(v: str) -> str:
    if v not in _VALID_PRODUCTS:
        raise ValueError(f"product must be one of {sorted(_VALID_PRODUCTS)}, got {v!r}")
    return v


def _validate_segment(v: str | None) -> str | None:
    if v is not None and v not in _VALID_SEGMENTS:
        raise ValueError(f"exchange_segment must be one of {sorted(_VALID_SEGMENTS)}, got {v!r}")
    return v


def _validate_validity(v: str) -> str:
    if v not in _VALID_VALIDITIES:
        raise ValueError(f"validity must be one of {sorted(_VALID_VALIDITIES)}, got {v!r}")
    return v


class ModifyOrderRequest(BaseModel):
    # Send either quantity (units) or lots; with lots the backend converts
    # using its own lot size. Both → must agree.
    quantity: int | None = Field(default=None, ge=1)
    lots: int | None = Field(default=None, ge=1)
    price: float = Field(default=0, ge=0)
    trigger_price: float = Field(default=0, ge=0)
    disclosed_quantity: int = Field(default=0, ge=0)
    validity: str = "DAY"
    order_type: str
    trading_symbol: str
    transaction_type: str  # "B" or "S"
    # Retained for the caller's benefit (and for lot-size lookup); SDK v3's
    # modify_order() no longer accepts either of these.
    exchange_segment: str | None = None
    product: str = "NRML"
    instrument_token: str = ""

    _ck_order_type = field_validator("order_type")(_validate_order_type)
    _ck_validity = field_validator("validity")(_validate_validity)
    _ck_segment = field_validator("exchange_segment")(_validate_segment)

    @model_validator(mode="after")
    def _check_limit_price(self) -> ModifyOrderRequest:
        if self.order_type in _LIMIT_ORDER_TYPES and self.price <= 0:
            raise ValueError(f"price must be > 0 for a {self.order_type} order")
        return self


class PlaceOrderLeg(BaseModel):
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

    _ck_order_type = field_validator("order_type")(_validate_order_type)
    _ck_product = field_validator("product")(_validate_product)

    @model_validator(mode="after")
    def _check_limit_price(self) -> PlaceOrderLeg:
        if self.order_type in _LIMIT_ORDER_TYPES and self.price <= 0:
            raise ValueError(f"price must be > 0 for a {self.order_type} order")
        return self


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


def _validate_commodity_leg(quantity: int, cfg: Any) -> str | None:
    """Reject MCX legs whose quantity isn't a whole number of lots."""
    if cfg.lot_size > 0 and quantity % cfg.lot_size != 0:
        return f"Quantity {quantity} is not a multiple of the {cfg.lot_size} lot size"
    return None


def _segment_for_trading_symbol(trading_symbol: str) -> str:
    """Exchange segment for a Kotak trading symbol via its underlying prefix."""
    m = re.match(r"^([A-Z]+)", trading_symbol or "")
    cfg = get_instrument_master().get(m.group(1)) if m else None
    return cfg.segment if cfg else "nse_fo"


def _mcx_live_orders_enabled() -> bool:
    """Opt-in switch for live MCX placement (margin preview and paper trading
    are unaffected). The mcx_fo quantity unit was verified as units (lots ×
    lLotSize) via check-margin on 2026-09-25; the gate stays until the live
    feed price scale is also confirmed."""
    return os.environ.get("MCX_LIVE_ORDERS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")


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
    """Initialize a NeoAPI client from the versioned session."""
    from neo_api_client import NeoAPI
    from shared.live_session import get_live_kotak_credentials
    from shared.schemas.auth import SessionState
    from shared.session_client import get_session

    session = await get_session(settings.redis_url)
    live_creds = get_live_kotak_credentials()
    if (
        not session
        or session.state not in (SessionState.ACTIVE, SessionState.DEGRADED)
        or live_creds is None
    ):
        raise HTTPException(status_code=401, detail="Kotak session unavailable")

    access_token = live_creds.access_token.get_secret_value()
    extra = live_creds.extra
    sid = str(extra.get("sid") or "")
    base_url = str(extra.get("base_url") or session.base_url or "")
    if not access_token or not sid or not base_url:
        raise HTTPException(status_code=401, detail="Kotak session unavailable")

    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    environment = settings.kotak_environment or "prod"
    # The key belongs to the account that logged in; fall back to the env var
    # for legacy single-account deployments.
    consumer_key = str(extra.get("consumer_key") or "") or settings.kotak_consumer_key

    def _build() -> NeoAPI:
        # NeoAPI() does synchronous network I/O in its constructor (requests,
        # no timeout). Running it on the event loop froze the entire gateway
        # (0% CPU, /health dead) whenever Kotak stalled — keep it in a thread
        # and bound it.
        client = NeoAPI(
            consumer_key=consumer_key,
            environment=environment,
            access_token=access_token,
        )
        # Inject authenticated session state — SDK guards on edit_token + edit_sid.
        # We authenticate out-of-band (shared.auth.kotak), so the SDK's own
        # totp_validate() never runs and never populates these itself.
        client.configuration.bearer_token = access_token
        client.configuration.edit_token = access_token
        client.configuration.edit_sid = sid
        client.configuration.edit_rid = ""
        client.configuration.sid = sid
        client.configuration.base_url = base_url
        # ucc/data_center are unused by the REST path but are what
        # create_websocket()/create_order_feed() read if we ever route the
        # feeds through this client.
        client.configuration.ucc = str(extra.get("ucc") or "")
        client.configuration.data_center = str(extra.get("data_center") or "") or None
        # NOTE: v2's `configuration.serverId` (sent as the `sId` query param) is
        # gone in v3 — no service reads it, and assigning it would be a silent
        # no-op rather than an error.
        return client

    try:
        return await asyncio.wait_for(asyncio.to_thread(_build), timeout=15.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Kotak SDK init timed out")


async def _resolve_order_legs(orders: list[PlaceOrderLeg]) -> tuple[list[dict[str, Any]], list[PlaceOrderResult]]:
    from shared.redis_client import get_redis
    from shared.instruments import get_instrument_master, order_quantity_from_lots

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
            # Untracked underlying (e.g. NSE stock option square-off). All
            # configured underlyings, MCX included, resolve above.
            log.warning("orders.segment_fallback", underlying=underlying,
                           trading_symbol=trading_symbol)
            exchange_segment = _segment_for_trading_symbol(trading_symbol or "")

        # The segment comes from instruments.json, not the client, so a bad
        # value here is a config error. SDK v3 rejects anything outside the
        # canonical set — catch it with a named leg error rather than letting
        # the whole batch fail on an opaque SDK dict.
        if exchange_segment not in _VALID_SEGMENTS:
            errors.append(PlaceOrderResult(
                index=i,
                success=False,
                trading_symbol=trading_symbol,
                error=(
                    f"Unsupported exchange segment {exchange_segment!r} for {underlying}; "
                    f"expected one of {sorted(_VALID_SEGMENTS)}"
                ),
            ))
            continue

        quantity, qty_error = await order_quantity_from_lots(
            settings.redis_url, underlying, leg.expiry, leg.quantity, leg.lots,
        )
        if qty_error or quantity is None:
            errors.append(PlaceOrderResult(index=i, success=False, trading_symbol=trading_symbol,
                                           error=qty_error or "Invalid quantity"))
            continue

        if cfg is not None and cfg.asset_class == "commodity":
            mcx_error = _validate_commodity_leg(quantity, cfg)
            if mcx_error:
                errors.append(PlaceOrderResult(index=i, success=False, error=mcx_error))
                continue

        resolved_legs.append({
            "original_index": i,
            "trading_symbol": trading_symbol,
            "scrip_token": scrip_token,
            "exchange_segment": exchange_segment,
            "transaction_type": leg.transaction_type,
            "quantity": quantity,
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
    from shared.live_session import get_live_kotak_credentials
    from shared.schemas.auth import SessionState
    from shared.session_client import get_session

    session = await get_session(settings.redis_url)
    live_creds = get_live_kotak_credentials()
    if (
        not session
        or session.state not in (SessionState.ACTIVE, SessionState.DEGRADED)
        or live_creds is None
    ):
        raise HTTPException(status_code=401, detail="Kotak session unavailable")

    access_token = live_creds.access_token.get_secret_value()
    sid = str(live_creds.extra.get("sid") or "")
    base_url = str(live_creds.extra.get("base_url") or session.base_url or "")
    if not access_token or not sid or not base_url:
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
        if rl["exchange_segment"] == "mcx_fo" and not _mcx_live_orders_enabled():
            results.append(PlaceOrderResult(
                index=rl["original_index"],
                success=False,
                error="Live MCX orders are disabled until the mcx_fo quantity unit is "
                      "verified (set MCX_LIVE_ORDERS_ENABLED=true); use paper trading",
            ))
            continue
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
            # Bounded: a hung SDK call must fail the request, not hold the
            # worker thread (and the user's order flow) forever.
            result = await asyncio.wait_for(asyncio.to_thread(
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
                tag=rl["tag"] or None,
            ), timeout=30.0)
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

    # Persist trade fills asynchronously — fetch trade report and write to trade_logs
    if any(r.success for r in results):
        base_url, headers = await _load_kotak_session()
        asyncio.create_task(
            _persist_trade_fills_background(
                base_url=base_url,
                access_token=headers["Auth"],
                sid=headers["Sid"],
                ucc=get_active_ucc(),
            )
        )

    return results


async def _persist_trade_fills_background(
    *, base_url: str, access_token: str, sid: str, ucc: str
) -> None:
    """Fetch today's trade report from Kotak and persist fills to trade_logs."""
    from shared.positions import fetch_trade_report
    from shared.trade_logger import persist_trade_fills

    try:
        # Small delay to let the order fill settle at the broker
        await asyncio.sleep(2)
        raw = await fetch_trade_report(base_url, access_token, sid)
        if raw:
            await persist_trade_fills(settings.timescaledb_url, raw, ucc)
    except Exception:
        log.exception("orders.persist_fills_background_error")


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


@router.get("/limits")
async def get_limits(request: Request):
    """Fetch account margin limits from Kotak Neo."""
    base_url, headers = await _load_kotak_session()
    client = _client(request)
    try:
        jdata = _json.dumps({"seg": "ALL", "exch": "ALL", "prod": "ALL"})
        resp = await client.post(
            f"{base_url}/quick/user/limits",
            headers=headers,
            content=f"jData={jdata}",
            timeout=10.0,
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Limits fetch failed")
        data = resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        log.error("limits.fetch_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Limits fetch failed")

    margin_used = (
        (_safe_float(data.get("UnrealizedMtomPrsnt")) or 0)
        + (_safe_float(data.get("ExposureMarginPrsnt")) or 0)
        + (_safe_float(data.get("FoSpanrgnNrmlPrsnt")) or 0)
    )

    return {
        "net": _safe_float(data.get("Net")),
        "marginUsed": margin_used,
        "collateral": _safe_float(data.get("CollateralValue")),
        "marginFromShares": _safe_float(data.get("Collateral")),
    }


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
        exchange = exchange_from_segment(ex_seg)
        row = {
            "orderId": o.get("nOrdNo", ""),
            "tradingSymbol": o.get("trdSym", ""),
            "symbol": o.get("sym", ""),
            "exchange": exchange,
            "exchangeSegment": ex_seg,
            "instrumentToken": o.get("tok", ""),
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
    neo_client = await _get_neo_client()
    result = await asyncio.wait_for(
        asyncio.get_event_loop().run_in_executor(
            None, lambda: neo_client.cancel_order(order_id=order_id)
        ),
        timeout=30.0,
    )
    if isinstance(result, dict) and result.get("Error"):
        raise HTTPException(status_code=400, detail=result)
    return {"ok": True, "result": result}


@router.post("/orders/{order_id}/modify")
async def modify_order(
    order_id: str,
    body: ModifyOrderRequest,
    request: Request,
):
    from shared.instruments import order_quantity_from_lots

    m = re.match(r"^([A-Z]+)", body.trading_symbol or "")
    quantity, qty_error = await order_quantity_from_lots(
        settings.redis_url, m.group(1) if m else None, None, body.quantity, body.lots,
    )
    if qty_error or quantity is None:
        raise HTTPException(status_code=400, detail=qty_error or "Invalid quantity")

    neo_client = await _get_neo_client()
    result = await asyncio.wait_for(
        asyncio.get_event_loop().run_in_executor(
        None,
        # SDK v3 dropped instrument_token/exchange_segment/product/
        # trading_symbol/transaction_type — the backend never required them for
        # a modify, and passing them now raises TypeError. The order number
        # alone identifies the order; the exchange keeps the rest.
        lambda: neo_client.modify_order(
            order_id=order_id,
            price=str(body.price),
            order_type=body.order_type,
            quantity=str(quantity),
            validity=body.validity,
            trigger_price=str(body.trigger_price),
            disclosed_quantity=str(body.disclosed_quantity),
        ),
        ),
        timeout=30.0,
    )
    if isinstance(result, dict) and result.get("Error"):
        raise HTTPException(status_code=400, detail=result)
    return {"ok": True, "result": result}


@router.get("/positions")
async def get_positions(request: Request):
    """Fetch positions from Kotak API, enrich with trade fills and cached LTP."""
    import json as _json
    from shared.positions import (
        enrich_positions_with_trade_history,
        enrich_positions_with_trades,
        fetch_kotak_positions,
        fetch_trade_report,
    )
    from shared.redis_client import cache_get

    try:
        base_url, headers = await _load_kotak_session()
    except HTTPException:
        return []

    access_token = headers["Auth"]
    sid = headers["Sid"]
    ucc = get_active_ucc()

    result = await fetch_kotak_positions(base_url, access_token, sid)
    if not result:
        return []

    # Fetch trade report and use actual fill prices for realized P&L
    trades = await fetch_trade_report(base_url, access_token, sid)
    if trades is not None:
        if trades:
            corrected_realized = enrich_positions_with_trades(
                result["positions"], trades
            )
            result["realizedPnl"] = corrected_realized

            # Persist fills to trade_logs for FIFO P&L history
            from shared.trade_logger import persist_trade_fills
            await persist_trade_fills(settings.timescaledb_url, trades, ucc)

        corrected_realized = await enrich_positions_with_trade_history(
            settings.timescaledb_url,
            result["positions"],
            ucc,
        )
        if corrected_realized is not None:
            result["realizedPnl"] = corrected_realized

    # Seed synthetic fills for CF positions where trade_logs has incomplete history
    # (e.g. system wasn't running when the position was opened)
    from shared.trade_logger import compute_fifo_pnl, seed_missing_fills
    await seed_missing_fills(settings.timescaledb_url, result["positions"], ucc)

    # Override avgPrice with FIFO entry price from trade_logs
    for pos in result.get("positions", []):
        if not pos.get("isOpen", True):
            continue
        fifo = await compute_fifo_pnl(settings.timescaledb_url, pos["symbol"], ucc=ucc)
        if fifo["total_fills"] > 0 and fifo["avg_entry_price"] > 0:
            pos["avgPrice"] = fifo["avg_entry_price"]

    # Save positions to DB (bootup snapshot) — awaited so DB is populated
    # before the WS reconciliation fires
    from shared.positions import save_positions
    await save_positions(settings.timescaledb_url, result["positions"])

    # Notify PositionSubscriber to subscribe tokens for live LTP
    import orjson
    from shared.redis_client import get_redis
    open_symbols = [
        {"symbol": p["symbol"], "tradingSymbol": p.get("tradingSymbol", "")}
        for p in result["positions"]
        if p.get("isOpen", True) and p.get("netQty", 0) != 0
    ]
    if open_symbols:
        async with get_redis(settings.redis_url) as client:
            await client.publish("subscribe:positions", orjson.dumps(open_symbols))

    # Inline LTP enrichment for the initial REST response so the UI isn't
    # all zeros before the option chain WebSocket delivers live ticks.
    for pos in result.get("positions", []):
        sym = pos.get("symbol", "")
        if not sym:
            continue
        ltp_raw = await cache_get(settings.redis_url, f"cache:ltp:{sym}")
        # LKGV fallback: if live LTP cache expired, use last known good value
        if not ltp_raw:
            ltp_raw = await cache_get(settings.redis_url, f"cache:lkgv:{sym}")
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
            total_pnl = pos.get("bookedPnl", 0) + (net_qty * ltp * adj)
            realized_component = pos.get("realizedPnlComponent", 0)
            pos["unrealizedPnl"] = round(total_pnl - realized_component, 2) if net_qty != 0 else 0.0
            pos["pnl"] = round(total_pnl, 2)

    return result


@router.get("/positions/raw")
async def get_positions_raw(request: Request):
    """Temporary local debug route for raw Kotak positions payload."""
    try:
        return await _kotak_request(request, "GET", "/quick/user/positions")
    except HTTPException:
        return []


@router.get("/trade-report")
async def get_trade_report(request: Request):
    """Fetch today's trade fills from Kotak, grouped by symbol with P&L."""
    from shared.positions import compute_realized_from_trades, fetch_trade_report

    try:
        base_url, headers = await _load_kotak_session()
    except HTTPException:
        return {"trades": [], "realizedPnl": 0}

    access_token = headers["Auth"]
    sid = headers["Sid"]

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
