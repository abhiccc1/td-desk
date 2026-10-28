"""Kotak Neo market-data connector built on the SDK's async SFeed client.

Replaces the vendored HSWebSocketLib binary decoder (and its daemon thread)
with ``neo_api_client.websocket.feed.SFeedWebSocket`` from kotakneoapi v3,
which delivers typed, pre-scaled Pydantic messages over the service's own
event loop.

The public surface is deliberately unchanged from the vendored-SDK version —
``SubscriptionManager`` still talks in terms of Kotak "channels". v3 has no
channel concept (channels were only ever pause/resume groups, which this
service never used), so the channel argument is accepted and ignored; the LRU
budget it drives still governs how many scrips we hold subscribed.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncGenerator
from datetime import datetime, timezone

import structlog
from neo_api_client.websocket.feed import (
    SFeedIndex,
    SFeedScrip,
    SFeedScripLite,
    SFeedWebSocket,
    WsToken,
)
from neo_api_client.websocket.feed.client import SFEED_WEBSOCKET_URL

from shared.schemas.auth import BrokerCredentials
from shared.schemas.tick import TickData

from market_data_service.config import MarketDataSettings

logger = structlog.get_logger()

# Sourced from the SDK rather than hardcoded: the published guide and the
# shipped default have disagreed on the path (/wsfeed vs /apifeed), and the
# SDK's value is the one its protocol handling is written against.
_WS_URL = SFEED_WEBSOCKET_URL
# v3 enforces a flat per-connection subscription cap instead of the old
# 15-channels × 100-scrips layout. 3000 is the SDK default and comfortably
# above what SubscriptionManager's LRU will hold (~1300).
_MAX_SUBSCRIPTIONS = 3000
# Outer retry, used only after the SDK exhausts its own connect retries and
# post-connect auto-reconnect.
_RECONNECT_WAIT_S = 10.0


def _parse_token(raw: str) -> WsToken | None:
    """Convert a ``"nse_cm|26000"`` subscription string into a WsToken."""
    seg, _, tok = raw.partition("|")
    if not seg or not tok:
        logger.warning("kotak_neo.bad_token", token=raw)
        return None
    return WsToken(seg, tok)


def _parse_tokens(raw_tokens: list[str]) -> list[WsToken]:
    return [t for t in (_parse_token(r) for r in raw_tokens) if t is not None]


class KotakNeoConnector:
    """Kotak Neo connector using the SDK's async SFeed WebSocket client."""

    def __init__(
        self,
        settings: MarketDataSettings,
        credentials: BrokerCredentials,
        spot_tokens: dict[str, str] | None = None,
        index_names: dict[str, str] | None = None,
    ) -> None:
        self._settings = settings
        self._credentials = credentials
        self.token_to_symbol: dict[str, str] = {}
        # token → exchange label ("NSE" | "BSE" | "MCX") for tick labelling
        self.token_exchange: dict[str, str] = {}
        self._tick_queue: asyncio.Queue[TickData] = asyncio.Queue(maxsize=50000)
        self._ws: SFeedWebSocket | None = None
        self._connected = asyncio.Event()
        self._reader: asyncio.Task | None = None
        self._should_stop = False
        # Incremented on every socket open. The SDK re-subscribes on its own
        # internal reconnect, but a full re-open (after it gives up and we
        # reconnect from scratch) loses everything — SessionWatcher compares
        # generations to detect that and replay subscriptions.
        self.generation: int = 0
        # Freshness watchdog timestamps (monotonic seconds). 0.0 = no tick of
        # that kind seen yet.
        self.last_tick_mono: float = 0.0
        self.last_index_tick_mono: float = 0.0
        # Static OHLC data per symbol (captured from first tick snapshot)
        self._static_data: dict[str, dict] = {}
        # Reverse lookup: token string → underlying name (for index ticks)
        self._token_to_index: dict[str, str] = {}
        if spot_tokens:
            self._token_to_index = {tok: name for name, tok in spot_tokens.items()}
        # SFeedIndex messages carry a synthetic `instrument_token` (a hash),
        # not our configured spot token — they can only be identified by the
        # broker's index `name`. Map that back to the underlying, and to the
        # spot token so the tick keeps its correct exchange label.
        self._index_name_to_underlying: dict[str, str] = {}
        self._index_name_to_token: dict[str, str] = {}
        for und, iname in (index_names or {}).items():
            self._index_name_to_underlying[iname] = und
            if spot_tokens and und in spot_tokens:
                self._index_name_to_token[iname] = spot_tokens[und]

    @property
    def connected(self) -> bool:
        """True while the underlying Kotak socket is open and authenticated."""
        return self._connected.is_set()

    async def connect(self) -> None:
        """Open the SFeed socket and start draining it into the tick queue."""
        if self._reader is not None:
            return

        self._should_stop = False
        self._reader = asyncio.create_task(self._run())

        # Bounded wait so a dead feed doesn't stall startup; the reader keeps
        # retrying in the background regardless.
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=15.0)
        except asyncio.TimeoutError:
            logger.warning("kotak_neo.connect_timeout")

    async def _run(self) -> None:
        jwt = self._credentials.access_token.get_secret_value()
        sid = self._credentials.extra.get("sid", "")
        ucc = str(self._credentials.extra.get("ucc") or "")

        while not self._should_stop:
            logger.info("kotak_neo.connecting", token_len=len(jwt), sid=sid[:20])
            try:
                ws = SFeedWebSocket(
                    access_token=jwt,
                    sid=sid,
                    ucc=ucc,
                    url=_WS_URL,
                    max_subscriptions=_MAX_SUBSCRIPTIONS,
                )
                async with ws:
                    self._ws = ws
                    self.generation += 1
                    self._connected.set()
                    logger.info("kotak_neo.connected", generation=self.generation)

                    async for message in ws:
                        self._handle_message(message)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("kotak_neo.feed_error", error=str(exc))
            finally:
                self._connected.clear()
                self._ws = None

            if self._should_stop:
                break
            logger.warning("kotak_neo.closed", retry_in_s=_RECONNECT_WAIT_S)
            await asyncio.sleep(_RECONNECT_WAIT_S)

    # ---- subscriptions ----
    #
    # `channel` is accepted for interface compatibility with the vendored-SDK
    # connector and ignored: v3 addresses subscriptions by token, not channel.

    async def subscribe_channel(self, tokens: list[str], channel: int) -> bool:
        """Subscribe tokens to the touch-line feed. Returns True if sent."""
        return await self._send("subscribe_scrips", tokens)

    async def unsubscribe_channel(self, tokens: list[str], channel: int) -> bool:
        """Unsubscribe tokens from the touch-line feed. Returns True if sent."""
        return await self._send("unsubscribe_scrips", tokens)

    async def subscribe_index_channel(self, tokens: list[str], channel: int) -> bool:
        """Subscribe index tokens to the index (OHLC) feed. Returns True if sent."""
        return await self._send("subscribe_index", tokens)

    async def _send(self, method: str, raw_tokens: list[str]) -> bool:
        if not raw_tokens:
            return True
        ws = self._ws
        if ws is None or not self._connected.is_set():
            logger.warning("kotak_neo.send_not_connected", method=method)
            return False

        tokens = _parse_tokens(raw_tokens)
        if not tokens:
            return False
        try:
            await getattr(ws, method)(tokens)
        except Exception:
            logger.exception("kotak_neo.send_failed", method=method)
            return False
        logger.info("kotak_neo.subscription_sent", method=method, count=len(tokens))
        return True

    async def stream(self) -> AsyncGenerator[TickData, None]:
        """Yield TickData from the SFeed socket. Does NOT auto-subscribe."""
        await self.connect()
        logger.info("kotak_neo.streaming")
        while True:
            tick = await self._tick_queue.get()
            yield tick

    async def disconnect(self) -> None:
        """Close the socket, drain the tick queue, and clear state."""
        self._should_stop = True
        self._connected.clear()
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):
                pass
            self._reader = None
        self._ws = None
        # Drain the tick queue to unblock any consumers waiting on get()
        while not self._tick_queue.empty():
            try:
                self._tick_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        logger.info("kotak_neo.disconnected")

    # ---- message handling ----

    def _handle_message(self, message) -> None:
        """Route a typed SFeed message into the tick pipeline."""
        if not isinstance(message, (SFeedScrip, SFeedScripLite, SFeedIndex)):
            # SFeedMarketStatus / SFeedCasChange carry no price for a tick.
            return

        token = message.instrument_token
        is_index = isinstance(message, SFeedIndex)
        if not token and not is_index:
            return

        # Freshness tracking: any tick proves the socket is alive; an index
        # tick proves the index subscription is still live.
        now_mono = time.monotonic()
        self.last_tick_mono = now_mono
        if is_index or token in self._token_to_index:
            self.last_index_tick_mono = now_mono

        if is_index:
            # Resolve by broker index name; the token is a synthetic hash.
            symbol = self._index_name_to_underlying.get(message.name)
            if symbol is None:
                logger.debug("kotak_neo.unmapped_index", name=message.name)
                return
            token = self._index_name_to_token.get(message.name, token)
        else:
            symbol = self.token_to_symbol.get(token)
            if symbol is None:
                symbol = self._token_to_index.get(token) or message.trading_symbol or token

        self._capture_static(symbol, message)

        ts = message.last_trade_time
        timestamp = (
            datetime.fromtimestamp(ts, tz=timezone.utc)
            if ts else datetime.now(timezone.utc)
        )

        # Prices arrive already divided by the exchange multiplier/precision,
        # exactly as the vendored decoder used to deliver them — no scaling here.
        bid = ask = volume = oi = None
        if isinstance(message, SFeedScrip):
            bid = message.buy[0].price if message.buy else None
            ask = message.sell[0].price if message.sell else None
            volume = message.volume_traded_today
            oi = message.open_interest

        # model_construct() skips Pydantic validation — safe because the SDK
        # already typed every field above.
        tick = TickData.model_construct(
            symbol=symbol,
            exchange=self.token_exchange.get(token, "NSE"),
            ltp=message.last_traded_price,
            bid=bid,
            ask=ask,
            volume=volume,
            oi=oi,
            timestamp=timestamp,
        )
        try:
            self._tick_queue.put_nowait(tick)
        except asyncio.QueueFull:
            logger.warning("kotak_neo.tick_queue_full", symbol=symbol)

    def _capture_static(self, symbol: str, message) -> None:
        """Capture day open, prev close, high, low (once per symbol)."""
        prev_close = message.close_price
        if not prev_close or prev_close <= 0:
            return

        # SFeedScripLite carries no OHLC — it can seed prevClose but must not
        # overwrite a full snapshot's open/high/low with zeros.
        if isinstance(message, SFeedScripLite):
            self._static_data.setdefault(symbol, {
                "symbol": symbol,
                "open": 0,
                "high": 0,
                "low": 0,
                "prevClose": prev_close,
                "change": message.net_change or 0,
                "pctChange": message.net_change_percent or 0,
            })
            return

        # SFeedIndex names its absolute change `change`; SFeedScrip `net_change`.
        change = getattr(message, "net_change", None)
        if change is None:
            change = getattr(message, "change", 0)

        existing = self._static_data.get(symbol)
        if existing and existing.get("prevClose", 0) > 0:
            # Already captured — only high/low move intraday.
            if message.high_price and message.high_price > 0:
                existing["high"] = message.high_price
            if message.low_price and message.low_price > 0:
                existing["low"] = message.low_price
            return

        self._static_data[symbol] = {
            "symbol": symbol,
            "open": message.open_price or 0,
            "high": message.high_price or 0,
            "low": message.low_price or 0,
            "prevClose": prev_close,
            "change": change or 0,
            "pctChange": message.net_change_percent or 0,
        }

    def get_static_data(self) -> dict[str, dict]:
        """Return a snapshot of static data for all symbols."""
        return dict(self._static_data)
