"""Kotak Order & Position streaming WebSocket connector.

Connects to ``wss://<baseurl>/realtime`` and receives real-time order lifecycle
events and position updates.  On position changes a debounced REST fetch
retrieves the full position set and publishes it to Redis for the frontend.

REST fetches are triggered ONLY by WS events (connect + position/order deltas),
never on a timer.  LTP enrichment is handled by the frontend from live chain ticks.
"""

from __future__ import annotations

import asyncio
import json
import threading

import structlog
import websocket

from shared.schemas.auth import BrokerCredentials
from shared.schemas.events import EventType, RedisEvent

logger = structlog.get_logger()

_DEBOUNCE_SECS = 0.5


class KotakRealtimeConnector:
    """Streams order/position events from the Kotak realtime WebSocket."""

    def __init__(
        self,
        credentials: BrokerCredentials,
        redis_url: str,
    ) -> None:
        base_url = credentials.extra.get("base_url", "")
        if base_url.startswith("http"):
            base_url = base_url.split("://", 1)[1]
        base_url = base_url.rstrip("/")

        self._ws_url = f"wss://{base_url}/realtime"
        self._rest_base = f"https://{base_url}"
        self._token = credentials.access_token.get_secret_value()
        self._sid = credentials.extra.get("sid", "")
        self._redis_url = redis_url
        self._loop: asyncio.AbstractEventLoop | None = None
        self._connected = threading.Event()
        self._debounce_timer: threading.Timer | None = None

    async def start(self) -> None:
        """Launch WS thread — never blocks the event loop."""
        self._loop = asyncio.get_running_loop()

        ws_thread = threading.Thread(target=self._run_ws, daemon=True)
        ws_thread.start()

        # Non-blocking wait for connection (check every 0.5 s, give up after 15 s)
        for _ in range(30):
            if self._connected.is_set():
                break
            await asyncio.sleep(0.5)
        else:
            logger.warning("kotak_realtime.connect_timeout")

    # ---- WebSocket (runs in daemon thread) ----

    def _run_ws(self) -> None:
        token = self._token
        sid = self._sid

        def on_open(ws):
            # Auth MUST be a raw string, NOT JSON
            auth = f"{{type:cn,Authorization:{token},Sid:{sid},src:WEB}}"
            ws.send(auth)
            self._connected.set()
            logger.info("kotak_realtime.connected", url=self._ws_url)
            # Immediate refresh on (re)connect to sync missed events
            self._dispatch_position_refresh()

        def on_message(ws, message):
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                return

            msg_type = data.get("type")
            if msg_type == "cn":
                logger.info("kotak_realtime.auth_ack", msg=data.get("msg"))
                return

            if msg_type == "position":
                logger.debug("kotak_realtime.position_delta", sym=data.get("data", {}).get("sym"))
                self._schedule_position_refresh()
            elif msg_type == "order":
                logger.info(
                    "kotak_realtime.order_event",
                    sym=data.get("data", {}).get("sym"),
                    status=data.get("data", {}).get("ordSt"),
                )
                self._schedule_position_refresh()

        def on_error(ws, error):
            logger.error("kotak_realtime.error", error=str(error))

        def on_close(ws, close_status, close_msg):
            logger.warning("kotak_realtime.closed", status=close_status)
            self._connected.clear()

        ws = websocket.WebSocketApp(
            self._ws_url,
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        # Auto-reconnect with 5 s delay
        ws.run_forever(ping_interval=30, ping_timeout=10, reconnect=5)

    # ---- position refresh logic ----

    def _schedule_position_refresh(self) -> None:
        """Debounce event-driven fetches — multi-leg fills send several deltas."""
        if self._debounce_timer is not None:
            self._debounce_timer.cancel()
        self._debounce_timer = threading.Timer(
            _DEBOUNCE_SECS,
            self._dispatch_position_refresh,
        )
        self._debounce_timer.start()

    def _dispatch_position_refresh(self) -> None:
        if self._loop is not None:
            asyncio.run_coroutine_threadsafe(
                self._fetch_and_publish_positions(), self._loop
            )

    async def _fetch_and_publish_positions(self) -> None:
        from shared.positions import (
            enrich_positions_with_trades,
            fetch_kotak_positions,
            fetch_trade_report,
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
            if trades:
                result["realizedPnl"] = enrich_positions_with_trades(
                    result["positions"], trades
                )
        except Exception:
            logger.debug("kotak_realtime.trade_report_skipped")

        event = RedisEvent(
            event_type=EventType.ORDER_UPDATE,
            source_service="market_data_service",
            payload=result,
        )
        await publish_event(self._redis_url, "orders:updates:default", event)
        logger.debug(
            "kotak_realtime.positions_published",
            count=len(result.get("positions", [])),
        )
