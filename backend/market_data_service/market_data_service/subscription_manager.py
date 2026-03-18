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

_INDEX_CHANNEL = 2
_FIRST_OPTION_CHANNEL = 3
_MAX_CHANNEL = 16  # Kotak allows channels 2-16
_TOKENS_PER_CHANNEL = 100


class SubscriptionManager:
    def __init__(self, connector, scrip, instruments: InstrumentMaster | None = None) -> None:
        self._connector = connector
        self._scrip = scrip
        self._im = instruments or get_instrument_master()
        # (underlying, expiry) -> list of channel numbers used
        self._active: dict[tuple[str, str], list[int]] = {}
        # LRU order: most recently used at end
        self._lru: list[tuple[str, str]] = []
        self._next_channel = _FIRST_OPTION_CHANNEL

    async def subscribe_indices(self) -> None:
        """Subscribe to index spot prices via mws (for LTP) and ifs (for OHLC)."""
        import json

        index_tokens = []
        for name in self._im.enabled_underlyings():
            cfg = self._im.get(name)
            if cfg:
                index_tokens.append(f"{cfg.spot_segment}|{cfg.spot_token}")

        # mws subscription gives us LTP in scrip format
        await self._connector.subscribe_channel(index_tokens, _INDEX_CHANNEL)

        # ifs subscription gives us open/high/low/prevClose in index format
        if self._connector._hs_ws and self._connector._connected.is_set():
            scrips_str = "&".join(index_tokens)
            sub_json = json.dumps({
                "type": "ifs",
                "scrips": scrips_str,
                "channelnum": 1,  # dedicated channel for index feed
            })
            self._connector._hs_ws.hs_send(sub_json)

        logger.info("sub_mgr.indices_subscribed", count=len(index_tokens))

    async def ensure_subscribed(self, underlying: str, expiry: str) -> bool:
        """Subscribe to underlying+expiry if not already active. Returns True if newly subscribed."""
        key = (underlying, expiry)

        if key in self._active:
            # Already subscribed — bump LRU
            if key in self._lru:
                self._lru.remove(key)
            self._lru.append(key)
            return False

        tokens = self._scrip.tokens.get(underlying, {}).get(expiry, [])
        if not tokens:
            logger.warning("sub_mgr.no_tokens", underlying=underlying, expiry=expiry)
            return False

        channels_needed = math.ceil(len(tokens) / _TOKENS_PER_CHANNEL)
        channels = self._allocate_channels(channels_needed)

        # Subscribe in batches across allocated channels
        for i, ch in enumerate(channels):
            batch = tokens[i * _TOKENS_PER_CHANNEL : (i + 1) * _TOKENS_PER_CHANNEL]
            await self._connector.subscribe_channel(batch, ch)

        self._active[key] = channels
        self._lru.append(key)
        logger.info(
            "sub_mgr.subscribed",
            underlying=underlying,
            expiry=expiry,
            tokens=len(tokens),
            channels=channels,
        )
        return True

    def _allocate_channels(self, count: int) -> list[int]:
        """Allocate `count` consecutive channels, evicting LRU combos if needed."""
        channels: list[int] = []
        for _ in range(count):
            if self._next_channel <= _MAX_CHANNEL:
                channels.append(self._next_channel)
                self._next_channel += 1
            else:
                # Evict the LRU combo and reuse its channels
                ch = self._evict_one_channel()
                channels.append(ch)
        return channels

    def _evict_one_channel(self) -> int:
        """Evict the oldest combo and return one of its channels."""
        if not self._lru:
            return _MAX_CHANNEL  # fallback

        evict_key = self._lru.pop(0)
        freed = self._active.pop(evict_key, [])
        logger.info("sub_mgr.evict", evicted=evict_key, freed_channels=freed)
        if freed:
            # Return the first freed channel; put the rest back in a free pool
            # (For simplicity, we just return the first one. Multi-channel
            #  evictions will need multiple evict calls.)
            ch = freed[0]
            return ch
        return _MAX_CHANNEL
