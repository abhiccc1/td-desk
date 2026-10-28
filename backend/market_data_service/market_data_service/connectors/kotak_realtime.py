"""Kotak Order & Position streaming WebSocket connector.

Connects to ``wss://<baseurl>/realtime`` and receives real-time order lifecycle
events and position updates.  On position changes a debounced REST fetch
retrieves the full position set and publishes it to Redis for the frontend.

REST fetches are triggered ONLY by WS events (connect + position/order deltas),
never on a timer.  LTP enrichment is handled by the frontend from live chain ticks.

Transport is the SDK's async ``OrderFeedWebSocket`` (kotakneoapi v3): it sends
the same ``{type:cn,Authorization:...,Sid:...,src:WEB}`` handshake this module
used to build by hand, but typed as ``OrderUpdate``/``PositionUpdate`` and
driven by the service's own event loop rather than a daemon thread.
"""

from __future__ import annotations

import asyncio

import structlog
from neo_api_client.websocket.orderfeed import (
    OrderFeedWebSocket,
    OrderUpdate,
    PositionUpdate,
)

from shared.redis_client import get_redis
from shared.schemas.auth import BrokerCredentials
from shared.schemas.events import EventType, RedisEvent

logger = structlog.get_logger()

_DEBOUNCE_SECS = 0.5
# The SDK retries the initial connect (max_connect_retries) and auto-reconnects
# after a drop (max_reconnect_attempts). This is the outer wait used only once
# the SDK has exhausted both and given up, so it stays well above the SDK's own
# reconnect_delay to avoid compounding into a tight reconnect storm.
_RECONNECT_WAIT_S = 15.0

# Kotak ordSt values that should generate a frontend toast notification.
# "open" and "trigger pending" are intentionally excluded (redundant with placement toast).
_NOTIFY_STATUSES: dict[str, str] = {
    "complete": "FILLED",
    "rejected": "REJECTED",
    "cancelled": "CANCELLED",
}


def _as_int(v) -> int:
    """Coerce an SDK field to int. The order feed types some numeric fields as
    str and others as int, and either can be None."""
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _as_float(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


class KotakRealtimeConnector:
    """Streams order/position events from the Kotak realtime WebSocket."""

    def __init__(
        self,
        credentials: BrokerCredentials,
        redis_url: str,
        db_url: str = "",
    ) -> None:
        self._db_url = db_url
        base_url = credentials.extra.get("base_url", "")
        if base_url.startswith("http"):
            base_url = base_url.split("://", 1)[1]
        base_url = base_url.rstrip("/")

        self._ws_url = f"wss://{base_url}/realtime"
        self._rest_base = f"https://{base_url}"
        self._token = credentials.access_token.get_secret_value()
        self._sid = credentials.extra.get("sid", "")
        # Bound to the account this connector was built for, so a connector left
        # over from a previous account can never write under the new one's UCC.
        self._ucc = str(credentials.extra.get("ucc") or "")
        self._redis_url = redis_url
        self._connected = asyncio.Event()
        self._debounce_task: asyncio.Task | None = None
        self._fetch_lock: asyncio.Lock | None = None
        self._should_stop = False
        self._task: asyncio.Task | None = None
        # Fire-and-forget publishes/fetches. asyncio only holds a weak
        # reference to a running task, so without this they can be garbage
        # collected mid-flight and silently dropped.
        self._bg_tasks: set[asyncio.Task] = set()

    def _spawn(self, coro) -> None:
        """Run a coroutine in the background, keeping a strong reference."""
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    def stop(self) -> None:
        """Signal the feed to stop and close the connection.

        Stays synchronous because callers invoke it from both sync teardown
        paths and the event loop; cancelling the tasks is enough to unwind the
        `async with` in `_run`.
        """
        self._should_stop = True
        self._connected.clear()
        if self._debounce_task is not None:
            self._debounce_task.cancel()
            self._debounce_task = None
        if self._task is not None:
            self._task.cancel()
            self._task = None
        logger.info("kotak_realtime.stopped")

    async def start(self) -> None:
        """Launch the feed task — never blocks the event loop."""
        self._fetch_lock = asyncio.Lock()
        self._should_stop = False
        self._connected.clear()

        self._task = asyncio.create_task(self._run())

        # Bounded wait so a dead broker doesn't stall service startup; the task
        # keeps retrying in the background either way.
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=15.0)
        except asyncio.TimeoutError:
            logger.warning("kotak_realtime.connect_timeout")

    # ---- WebSocket (async task on the service event loop) ----

    async def _run(self) -> None:
        """Connect, stream typed order/position updates, reconnect on failure."""
        while not self._should_stop:
            try:
                feed = OrderFeedWebSocket(
                    base_url=self._rest_base,
                    auth=self._token,
                    sid=self._sid,
                    # base_url would derive the same endpoint, but we already
                    # normalised it in __init__ — pass it so the two can't drift.
                    url=self._ws_url,
                )
                async with feed:
                    self._connected.set()
                    logger.info("kotak_realtime.connected", url=self._ws_url)
                    # Reconciliation: REST fetch → compare to DB → overwrite
                    self._dispatch_position_refresh(reconcile=True)

                    async for msg in feed:
                        if isinstance(msg, PositionUpdate):
                            logger.debug(
                                "kotak_realtime.position_delta", sym=msg.data.symbol
                            )
                            self._schedule_position_refresh()
                        elif isinstance(msg, OrderUpdate):
                            logger.info(
                                "kotak_realtime.order_event",
                                sym=msg.data.symbol,
                                status=msg.data.order_status,
                            )
                            self._dispatch_order_event(msg.data)
                            self._schedule_position_refresh()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("kotak_realtime.error", error=str(exc))
            finally:
                self._connected.clear()

            if self._should_stop:
                break
            logger.warning("kotak_realtime.closed", retry_in_s=_RECONNECT_WAIT_S)
            try:
                await asyncio.sleep(_RECONNECT_WAIT_S)
            except asyncio.CancelledError:
                raise

    # ---- position refresh logic ----

    def _schedule_position_refresh(self) -> None:
        """Debounce event-driven fetches — multi-leg fills send several deltas."""
        if self._debounce_task is not None:
            self._debounce_task.cancel()
        self._debounce_task = asyncio.create_task(self._debounced_refresh())
        self._bg_tasks.add(self._debounce_task)
        self._debounce_task.add_done_callback(self._bg_tasks.discard)

    async def _debounced_refresh(self) -> None:
        try:
            await asyncio.sleep(_DEBOUNCE_SECS)
        except asyncio.CancelledError:
            return
        self._dispatch_position_refresh()

    def _dispatch_order_event(self, data) -> None:
        """Immediately publish an order lifecycle event to Redis (no debounce).

        ``data`` is the SDK's typed ``OrderData``. It is declared with
        ``extra="allow"``, so wire fields the model doesn't name (notably the
        rejection reason) survive on ``model_extra``.
        """
        ord_st = (data.order_status or "").lower().strip()
        status = _NOTIFY_STATUSES.get(ord_st)
        if status is None:
            return

        extra = data.model_extra or {}

        total_qty = _as_int(data.quantity)
        # The SDK maps filled quantity from "fldQty"; this feed has also been
        # observed sending "fQty". Fall back so a partial fill isn't silently
        # reported as a complete one.
        filled_qty = _as_int(data.filled_quantity)
        if filled_qty == 0:
            filled_qty = _as_int(extra.get("fQty"))
        if status == "FILLED" and 0 < filled_qty < total_qty:
            status = "PARTIAL_FILL"

        side = "BUY" if data.transaction_type == "B" else "SELL"

        payload = {
            "orderNumber": data.order_id or "",
            "symbol": data.symbol or "",
            "tradingSymbol": data.trading_symbol or "",
            "status": status,
            "side": side,
            "totalQty": total_qty,
            "filledQty": filled_qty,
            "avgPrice": _as_float(data.average_price),
            "rejectionReason": extra.get("rejRsn") or "",
            "priceType": data.price_type or "",
        }

        self._spawn(self._publish_order_event(payload))

    async def _publish_order_event(self, payload: dict) -> None:
        """Publish order lifecycle event to Redis channel."""
        from shared.redis_client import publish_event

        event = RedisEvent(
            event_type=EventType.ORDER_EVENT,
            source_service="market_data_service",
            payload=payload,
        )
        try:
            await publish_event(self._redis_url, "orders:events:default", event)
            logger.info(
                "kotak_realtime.order_event_published",
                status=payload["status"],
                symbol=payload["symbol"],
                order=payload["orderNumber"],
            )
        except Exception:
            logger.debug("kotak_realtime.order_event_publish_failed")

    def _dispatch_position_refresh(self, reconcile: bool = False) -> None:
        self._spawn(self._fetch_and_publish_positions(reconcile=reconcile))

    async def _fetch_and_publish_positions(self, reconcile: bool = False) -> None:
        # Serialize: skip if another fetch is already in progress
        if self._fetch_lock is not None:
            if self._fetch_lock.locked():
                logger.debug("kotak_realtime.fetch_skipped", reason="already_in_progress")
                return
            async with self._fetch_lock:
                await self._do_fetch_and_publish(reconcile)
        else:
            await self._do_fetch_and_publish(reconcile)

    async def _do_fetch_and_publish(self, reconcile: bool = False) -> None:
        from shared.positions import (
            enrich_positions_with_trade_history,
            enrich_positions_with_trades,
            fetch_kotak_positions,
            fetch_trade_report,
            reconcile_positions,
            save_positions,
        )
        from shared.redis_client import publish_event

        try:
            result = await fetch_kotak_positions(
                self._rest_base, self._token, self._sid
            )
        except Exception:
            logger.exception("kotak_realtime.fetch_error")
            return

        if result is None:
            return

        # Enrich with trade report for accurate realized P&L
        try:
            trades = await fetch_trade_report(
                self._rest_base, self._token, self._sid
            )
            if trades is not None:
                if trades:
                    result["realizedPnl"] = enrich_positions_with_trades(
                        result["positions"], trades
                    )
                    # Persist trade fills
                    if self._db_url:
                        from shared.trade_logger import persist_trade_fills
                        await persist_trade_fills(self._db_url, trades, self._ucc)

                if self._db_url:
                    corrected_realized = await enrich_positions_with_trade_history(
                        self._db_url,
                        result["positions"],
                        self._ucc,
                    )
                    if corrected_realized is not None:
                        result["realizedPnl"] = corrected_realized
        except Exception:
            logger.debug("kotak_realtime.trade_report_skipped")

        # Override avgPrice with FIFO entry price from trade_logs for CF positions
        if self._db_url:
            try:
                from shared.trade_logger import compute_fifo_pnl, seed_missing_fills
                await seed_missing_fills(self._db_url, result["positions"], self._ucc)
                for pos in result.get("positions", []):
                    if not pos.get("isOpen", True):
                        continue
                    fifo = await compute_fifo_pnl(self._db_url, pos["symbol"], ucc=self._ucc)
                    if fifo["total_fills"] > 0 and fifo["avg_entry_price"] > 0:
                        pos["avgPrice"] = fifo["avg_entry_price"]
            except Exception:
                logger.debug("kotak_realtime.fifo_enrichment_skipped")

        # Persist positions to DB
        if self._db_url:
            try:
                if reconcile:
                    diffs = await reconcile_positions(
                        self._db_url, result["positions"]
                    )
                    if diffs:
                        logger.info("kotak_realtime.reconciled", diffs=diffs)
                    else:
                        logger.info("kotak_realtime.reconciled", diffs="no_changes")
                else:
                    await save_positions(self._db_url, result["positions"])
            except Exception:
                logger.exception("kotak_realtime.db_save_error")

        event = RedisEvent(
            event_type=EventType.ORDER_UPDATE,
            source_service="market_data_service",
            payload=result,
        )
        await publish_event(self._redis_url, "orders:updates:default", event)

        # Notify PositionSubscriber with open position symbols for targeted token subscription
        import orjson
        open_symbols = [
            {"symbol": p["symbol"], "tradingSymbol": p.get("tradingSymbol", "")}
            for p in result.get("positions", [])
            if p.get("isOpen", True) and p.get("netQty", 0) != 0
        ]
        try:
            async with get_redis(self._redis_url) as client:
                await client.publish("subscribe:positions", orjson.dumps(open_symbols))
        except Exception:
            logger.debug("kotak_realtime.position_subscribe_publish_failed")

        logger.debug(
            "kotak_realtime.positions_published",
            count=len(result.get("positions", [])),
        )
