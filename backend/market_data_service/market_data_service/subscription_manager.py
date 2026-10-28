"""On-demand subscription manager for Kotak Neo WebSocket.

Subscribes to option chain tokens only when requested (by the frontend
selecting an underlying+expiry). Uses LRU eviction when the Kotak channel
limit is reached.
"""

from __future__ import annotations

import math

import structlog

from shared.instruments import InstrumentMaster, get_instrument_master

logger = structlog.get_logger()

_INDEX_OHLC_CHANNEL = 1
_FIRST_OPTION_CHANNEL = 3
_MAX_CHANNEL = 15  # Kotak allows channels 2-16; channel 16 reserved for position tokens
_TOKENS_PER_CHANNEL = 100


class SubscriptionManager:
    def __init__(self, connector, scrip, instruments: InstrumentMaster | None = None, aggregator=None) -> None:
        self._connector = connector
        self._scrip = scrip
        self._im = instruments or get_instrument_master()
        self._aggregator = aggregator
        # (underlying, expiry) -> list of channel numbers used
        self._active: dict[tuple[str, str], list[int]] = {}
        # Chains whose subscribe frames could not be sent (socket down at the
        # time); retried by the feed watchdog once the socket is back.
        self._pending_send: set[tuple[str, str]] = set()
        # Separate reasons a chain should stay warm
        self._ui_views: set[tuple[str, str]] = set()
        self._prewarmed: set[tuple[str, str]] = set()
        # LRU order: most recently used at end
        self._lru: list[tuple[str, str]] = []
        self._next_channel = _FIRST_OPTION_CHANNEL
        self._free_channels: list[int] = []

    @property
    def has_pending_sends(self) -> bool:
        return bool(self._pending_send)

    def _index_tokens(self) -> list[str]:
        """Index subscriptions, addressed by NAME rather than spot token.

        The SFeed index channel is keyed by the broker's index name
        ("Nifty 50", "NIFTY MID SELECT"); passing the numeric spot token is
        accepted and ACKed but delivers nothing. Futures-underlying (MCX)
        chains carry their own future token in the per-expiry token list, so
        only cash indices appear here.
        """
        tokens = []
        for name, index_name in self._im.index_names().items():
            cfg = self._im.get(name)
            if cfg:
                tokens.append(f"{cfg.spot_segment}|{index_name}")
        return tokens

    async def subscribe_indices(self) -> bool:
        """Subscribe to index spot prices on the index channel.

        A single index message carries LTP *and* open/high/low/prevClose, so
        unlike the old mws+ifs pair this needs only one subscription per index.
        """
        index_tokens = self._index_tokens()
        ok = True
        for i in range(0, len(index_tokens), _TOKENS_PER_CHANNEL):
            batch = index_tokens[i : i + _TOKENS_PER_CHANNEL]
            if not await self._connector.subscribe_index_channel(batch, _INDEX_OHLC_CHANNEL):
                ok = False

        logger.info("sub_mgr.indices_subscribed", count=len(index_tokens), ok=ok)
        return ok

    async def ensure_subscribed(
        self,
        underlying: str,
        expiry: str,
        *,
        prewarm: bool = False,
        throttle_ms: int | None = None,
    ) -> bool:
        """Subscribe to underlying+expiry if not already active. Returns True if newly subscribed."""
        key = (underlying, expiry)

        if key in self._active:
            self._mark_view(key, prewarm=prewarm, throttle_ms=throttle_ms)
            # Already subscribed — bump LRU
            if key in self._lru:
                self._lru.remove(key)
            self._lru.append(key)
            # Re-send mws for UI views: Kotak re-delivers a SNAP for every
            # scrip, so the chain paints immediately instead of waiting for
            # each strike's next natural tick. Also repairs subscriptions
            # dropped while the socket was down (pending sends).
            if not prewarm or key in self._pending_send:
                await self._send_chain(key)
            return False

        tokens = self._scrip.tokens.get(underlying, {}).get(expiry, [])
        if not tokens:
            logger.warning("sub_mgr.no_tokens", underlying=underlying, expiry=expiry)
            return False

        channels_needed = math.ceil(len(tokens) / _TOKENS_PER_CHANNEL)
        channels = await self._allocate_channels(channels_needed)

        self._active[key] = channels
        self._mark_view(key, prewarm=prewarm, throttle_ms=throttle_ms)
        self._lru.append(key)

        sent = await self._send_chain(key)

        logger.info(
            "sub_mgr.subscribed",
            underlying=underlying,
            expiry=expiry,
            tokens=len(tokens),
            channels=channels,
            prewarm=prewarm,
            sent=sent,
        )
        return True

    async def _send_chain(self, key: tuple[str, str]) -> bool:
        """(Re-)send the mws subscribe frames for an active chain. Tracks failures."""
        tokens = self._scrip.tokens.get(key[0], {}).get(key[1], [])
        channels = self._active.get(key, [])
        ok = bool(channels)
        for i, ch in enumerate(channels):
            batch = tokens[i * _TOKENS_PER_CHANNEL : (i + 1) * _TOKENS_PER_CHANNEL]
            if not await self._connector.subscribe_channel(batch, ch):
                ok = False
        if ok:
            self._pending_send.discard(key)
        else:
            self._pending_send.add(key)
            logger.warning("sub_mgr.send_deferred", underlying=key[0], expiry=key[1])
        return ok

    async def resubscribe_all(self) -> None:
        """Replay indices + every active chain (after a socket reconnect)."""
        await self.subscribe_indices()
        for key in list(self._active):
            await self._send_chain(key)
        logger.info("sub_mgr.resubscribed_all", chains=len(self._active))

    async def retry_pending(self) -> None:
        """Retry chains whose subscribe frames were dropped while disconnected."""
        for key in list(self._pending_send):
            await self._send_chain(key)

    def release_view(self, underlying: str, expiry: str) -> None:
        """Stop emitting chain snapshots when the frontend no longer views a chain."""
        self._release_view((underlying, expiry), prewarm=False)

    def release_prewarm(self, underlying: str, expiry: str) -> None:
        """Release a background prewarm view for a chain."""
        self._release_view((underlying, expiry), prewarm=True)

    async def _allocate_channels(self, count: int) -> list[int]:
        """Allocate `count` channels: free pool first, then fresh, then LRU eviction."""
        channels: list[int] = []
        for _ in range(count):
            if self._free_channels:
                channels.append(self._free_channels.pop())
            elif self._next_channel <= _MAX_CHANNEL:
                channels.append(self._next_channel)
                self._next_channel += 1
            else:
                # Evict the LRU combo and reuse one of its channels
                channels.append(await self._evict_one_channel())
        return channels

    async def _evict_one_channel(self) -> int:
        """Evict the oldest combo, unsubscribe it broker-side, and return one channel."""
        if not self._lru:
            return _MAX_CHANNEL  # fallback

        evict_key = self._lru.pop(0)
        freed = self._active.pop(evict_key, [])
        self._pending_send.discard(evict_key)

        # Unsubscribe the evicted scrips from Kotak. Without this the broker
        # keeps streaming them (channel numbers are only pause/resume groups),
        # accumulating toward the per-connection scrip cap over long sessions.
        tokens = self._scrip.tokens.get(evict_key[0], {}).get(evict_key[1], [])
        for i, ch in enumerate(freed):
            batch = tokens[i * _TOKENS_PER_CHANNEL : (i + 1) * _TOKENS_PER_CHANNEL]
            await self._connector.unsubscribe_channel(batch, ch)

        if self._aggregator is not None:
            self._aggregator.unregister_chain_key(*evict_key)
        self._ui_views.discard(evict_key)
        self._prewarmed.discard(evict_key)

        logger.info("sub_mgr.evict", evicted=evict_key, freed_channels=freed)
        if freed:
            # Reuse one channel now, return the rest to the free pool
            self._free_channels.extend(freed[1:])
            return freed[0]
        return _MAX_CHANNEL

    def apply_demand(
        self,
        underlying: str,
        expiry: str,
        throttle_ms: int,
        analytics: list[str] | None,
    ) -> None:
        """Apply a client demand claim to a chain.

        The analytics tier is recorded unconditionally — position snapshots
        carry it too, and they outlive the UI's chain view. The cadence applies
        only to a chain the UI is actually viewing: a demand message must never
        be able to *start* snapshot emission, or a client stating demand for an
        expiry it merely holds positions in would spin up the full chain feed
        for a chain nobody is looking at. Subscribing carries its own rate.
        """
        if self._aggregator is None:
            return
        self._aggregator.set_chain_analytics(underlying, expiry, analytics)
        if (underlying, expiry) in self._ui_views:
            self._aggregator.set_chain_rate(underlying, expiry, throttle_ms)

    def _mark_view(
        self, key: tuple[str, str], *, prewarm: bool, throttle_ms: int | None = None
    ) -> None:
        """Record a reason to keep a chain warm.

        Only a UI view drives the chain-snapshot pipeline. A prewarm keeps the
        broker subscription and the aggregator's tick accumulation alive — so a
        position's strikes stay subscribed and a viewer who opens the chain
        repaints instantly — but it deliberately does *not* register the chain
        key: position data reaches the UI through the raw ticks:option stream
        and the independent 5s position-snapshot pipeline, neither of which
        needs full-rate chain snapshots.
        """
        if prewarm:
            self._prewarmed.add(key)
            return

        had_view = key in self._ui_views
        self._ui_views.add(key)

        if self._aggregator is None:
            return
        if not had_view:
            self._aggregator.register_chain_key(*key, throttle_ms=throttle_ms)
        elif throttle_ms is not None:
            # Already registered — a re-asserted subscribe still carries the
            # current demand level, so apply it rather than dropping it.
            self._aggregator.set_chain_rate(*key, throttle_ms)

    def _release_view(self, key: tuple[str, str], *, prewarm: bool) -> None:
        """Drop one reason to keep a chain warm.

        Releasing the UI view stops chain snapshots even when a prewarm
        remains. Gating this on the prewarm too meant that any expiry holding
        an open position kept emitting full-rate snapshots — and running the
        whole IV/Greeks/SVI/model pipeline behind them — for the life of the
        service, with no clients connected at all.
        """
        if prewarm:
            self._prewarmed.discard(key)
        else:
            self._ui_views.discard(key)
            if self._aggregator is not None:
                self._aggregator.unregister_chain_key(*key)

        logger.info(
            "sub_mgr.view_released",
            underlying=key[0],
            expiry=key[1],
            prewarm=prewarm,
            still_prewarmed=key in self._prewarmed,
        )
