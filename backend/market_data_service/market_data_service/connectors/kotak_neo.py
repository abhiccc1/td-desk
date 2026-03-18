"""Kotak Neo WebSocket connector using vendored SDK binary protocol.

Uses the official Kotak Neo HSWebSocketLib (vendored in kotak_sdk/) which handles
the binary framing protocol for auth, subscriptions, and tick data parsing.
Bridges the sync websocket-client callbacks into our async tick pipeline.
"""

from __future__ import annotations

import asyncio
import json
import threading

import orjson
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

import structlog

from shared.schemas.auth import BrokerCredentials
from shared.schemas.tick import TickData

from market_data_service.config import MarketDataSettings
from market_data_service.connectors.kotak_sdk import HSWebSocket

logger = structlog.get_logger()

_WS_URL = "wss://mlhsm.kotaksecurities.com"


class KotakNeoConnector:
    """Kotak Neo connector using the vendored SDK's binary protocol handler."""

    def __init__(
        self,
        settings: MarketDataSettings,
        credentials: BrokerCredentials,
        spot_tokens: dict[str, str] | None = None,
    ) -> None:
        self._settings = settings
        self._credentials = credentials
        self.token_to_symbol: dict[str, str] = {}
        self._tick_queue: asyncio.Queue[TickData] = asyncio.Queue(maxsize=50000)
        self._hs_ws: HSWebSocket | None = None
        self._connected = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        # Static OHLC data per symbol (captured from first tick snapshot)
        self._static_data: dict[str, dict] = {}
        self._static_data_lock = threading.Lock()
        # Reverse lookup: token string → underlying name (for index ticks)
        self._token_to_index: dict[str, str] = {}
        if spot_tokens:
            self._token_to_index = {tok: name for name, tok in spot_tokens.items()}

    async def connect(self) -> None:
        """Start the Kotak HSM WebSocket via the SDK library."""
        jwt = self._credentials.access_token.get_secret_value()
        sid = self._credentials.extra.get("sid", "")
        self._loop = asyncio.get_running_loop()

        logger.info("kotak_neo.connecting", token_len=len(jwt), sid=sid[:20])

        self._hs_ws = HSWebSocket()

        def on_open():
            logger.info("kotak_neo.sdk_open, sending auth via hs_send")
            # SDK requires auth to be sent explicitly in on_open (like NeoWebSocket does)
            auth_msg = json.dumps({
                "type": "cn",
                "Authorization": jwt,
                "Sid": sid,
            })
            self._hs_ws.hs_send(auth_msg)
            self._connected.set()

        _msg_count = {"n": 0, "idx": 0}

        def on_message(message):
            """SDK delivers decoded JSON (string or list) after binary parsing."""
            _msg_count["n"] += 1
            c = _msg_count["n"]
            if c <= 5 or c % 5000 == 0:
                sample = str(message)[:300] if isinstance(message, str) else repr(message)[:300]
                logger.info("kotak_neo.on_message", count=c, type=type(message).__name__, sample=sample)

            # Log any message containing index value field "iv"
            raw = str(message)
            if '"iv"' in raw or "'iv'" in raw:
                _msg_count["idx"] += 1
                if _msg_count["idx"] <= 5:
                    logger.info("kotak_neo.index_tick", count=_msg_count["idx"], sample=raw[:300])
            try:
                if isinstance(message, str):
                    data = orjson.loads(message)
                elif isinstance(message, list):
                    data = message
                elif isinstance(message, dict):
                    data = [message]
                else:
                    return

                items = data if isinstance(data, list) else [data]
                for item in items:
                    if isinstance(item, dict):
                        self._enqueue_tick(item)
            except (orjson.JSONDecodeError, TypeError) as e:
                logger.debug("kotak_neo.parse_skip", error=str(e))

        def on_error(error):
            logger.error("kotak_neo.sdk_error", error=str(error))

        def on_close(close_msg=None):
            logger.warning("kotak_neo.sdk_closed", msg=str(close_msg))
            self._connected.clear()

        # SDK's open_connection calls run_forever() which is blocking,
        # so run it in a daemon thread (matching how NeoWebSocket uses it)
        ws_thread = threading.Thread(
            target=self._hs_ws.open_connection,
            args=(_WS_URL, jwt, sid, on_open, on_message, on_error, on_close),
            daemon=True,
        )
        ws_thread.start()

        # Wait for connection to be established
        if not self._connected.wait(timeout=15):
            logger.warning("kotak_neo.connect_timeout")

    async def subscribe_channel(self, tokens: list[str], channel: int) -> None:
        """Subscribe a list of tokens on a specific Kotak channel number."""
        if self._hs_ws is None or not self._connected.is_set():
            logger.warning("kotak_neo.subscribe_not_connected")
            return

        scrips_str = "&".join(tokens)
        sub_json = json.dumps({
            "type": "mws",
            "scrips": scrips_str,
            "channelnum": channel,
        })
        self._hs_ws.hs_send(sub_json)
        logger.info("kotak_neo.subscribed_channel", count=len(tokens), channel=channel)

    async def stream(self) -> AsyncGenerator[TickData, None]:
        """Yield TickData from the SDK's WebSocket feed. Does NOT auto-subscribe."""
        await self.connect()
        logger.info("kotak_neo.streaming")
        while True:
            tick = await self._tick_queue.get()
            yield tick

    async def disconnect(self) -> None:
        self._connected.clear()
        logger.info("kotak_neo.disconnected")

    def _enqueue_tick(self, data: dict) -> None:
        """Convert a decoded tick dict to TickData and enqueue."""
        # SDK returns: scrip data uses "ltp", index data uses "iv" (index value)
        token = data.get("tk") or data.get("token")
        ltp = data.get("ltp") or data.get("iv")  # "iv" = index value in INDEX_MAPPING
        if token is None or ltp is None:
            return

        symbol = self.token_to_symbol.get(str(token))
        if symbol is None:
            symbol = self._token_to_index.get(str(token), str(token))

        # Capture static OHLC data from the first snapshot for each symbol.
        # Scrip fields: op (open), h (high), lo (low), c (prev close), cng (change), nc (% change)
        # Index fields: openingPrice, highPrice, lowPrice, ic (prev close), cng, nc
        self._capture_static(symbol, data)

        try:
            ts_val = data.get("ft") or data.get("exchange_timestamp")
            timestamp = (
                datetime.fromtimestamp(int(ts_val), tz=timezone.utc)
                if ts_val else datetime.now(timezone.utc)
            )
            tick = TickData(
                symbol=symbol,
                exchange="NSE",
                ltp=float(ltp),
                bid=float(data["bp"]) if "bp" in data else None,
                ask=float(data["sp"]) if "sp" in data else None,
                volume=int(data["v"]) if "v" in data else None,
                oi=int(data["oi"]) if "oi" in data else None,
                timestamp=timestamp,
            )
            if self._loop is not None:
                self._loop.call_soon_threadsafe(self._enqueue_async_tick, tick)
        except (ValueError, TypeError, KeyError):
            pass

    def _enqueue_async_tick(self, tick: TickData) -> None:
        """Push a tick into the asyncio queue from the websocket thread."""
        try:
            self._tick_queue.put_nowait(tick)
        except asyncio.QueueFull:
            logger.warning("kotak_neo.tick_queue_full", symbol=tick.symbol)

    def _capture_static(self, symbol: str, data: dict) -> None:
        """Capture day open, prev close, high, low from tick data (once per symbol)."""
        # Only capture if we have meaningful static fields
        prev_close = _float(data.get("c")) or _float(data.get("ic"))
        if prev_close is None or prev_close <= 0:
            return

        with self._static_data_lock:
            existing = self._static_data.get(symbol)
            if existing and existing.get("prevClose", 0) > 0:
                # Already have static data — just update high/low which can change intraday
                h = _float(data.get("h")) or _float(data.get("highPrice"))
                lo = _float(data.get("lo")) or _float(data.get("lowPrice"))
                if h and h > 0:
                    existing["high"] = h
                if lo and lo > 0:
                    existing["low"] = lo
                return

            self._static_data[symbol] = {
                "symbol": symbol,
                "open": _float(data.get("op")) or _float(data.get("openingPrice")) or 0,
                "high": _float(data.get("h")) or _float(data.get("highPrice")) or 0,
                "low": _float(data.get("lo")) or _float(data.get("lowPrice")) or 0,
                "prevClose": prev_close,
                "change": _float(data.get("cng")) or 0,
                "pctChange": _float(data.get("nc")) or 0,
            }

    def get_static_data(self) -> dict[str, dict]:
        """Return a snapshot of static data for all symbols."""
        with self._static_data_lock:
            return dict(self._static_data)


def _float(v) -> float | None:
    """Safely convert to float."""
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None
