"""Position token subscriber — subscribes only the instrument tokens for open positions.

Listens to ``subscribe:positions`` Redis channel for position symbol updates,
resolves each to a Kotak instrument token via the scrip master cache, and
subscribes those tokens on a dedicated Kotak WS channel (16).  This gives
every open position live tick data regardless of which option chain the user
is viewing.
"""

from __future__ import annotations

import re

import orjson
import structlog

from shared.instruments import InstrumentMaster, get_instrument_master
from shared.redis_client import get_redis

from market_data_service.scrip_master import ScripMasterResult

logger = structlog.get_logger()

_POSITION_CHANNEL = 16

# Parse "NIFTY 260319 22000 CE" → (underlying, YYMMDD, strike, optionType)
_SYM_RE = re.compile(
    r"^(?P<underlying>[A-Z]+)\s+(?P<expiry>\d{6})\s+(?P<strike>[\d.]+)\s+(?P<ot>CE|PE)$"
)


class PositionSubscriber:
    """Subscribe position instrument tokens on a dedicated Kotak WS channel."""

    def __init__(
        self,
        connector,
        scrip: ScripMasterResult,
        redis_url: str,
        instruments: InstrumentMaster | None = None,
        aggregator=None,
        subscription_manager=None,
    ) -> None:
        self._connector = connector
        self._scrip = scrip
        self._redis_url = redis_url
        self._im = instruments or get_instrument_master()
        self._current_tokens: set[str] = set()
        self._aggregator = aggregator
        self._subscription_manager = subscription_manager
        self._position_ue_keys: set[tuple[str, str]] = set()

    async def start(self) -> None:
        """Subscribe to Redis channel and process position updates.

        Retries forever — a transient Redis failure must not silently kill
        the watcher for the rest of the session.
        """
        import asyncio

        while True:
            try:
                async with get_redis(self._redis_url) as client:
                    pubsub = client.pubsub()
                    await pubsub.subscribe("subscribe:positions")
                    logger.info("position_subscriber.started")
                    async for message in pubsub.listen():
                        if message["type"] != "message":
                            continue
                        try:
                            positions = orjson.loads(message["data"])
                            await self._process(positions)
                        except Exception:
                            logger.exception("position_subscriber.process_error")
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("position_subscriber.failed_retrying")
                await asyncio.sleep(5)

    async def _process(self, positions: list[dict]) -> None:
        """Resolve position symbols to tokens and subscribe if changed."""
        tokens: list[str] = []
        token_to_sym: dict[str, str] = {}

        for pos in positions:
            symbol = pos.get("symbol", "")
            match = _SYM_RE.match(symbol)
            if not match:
                continue

            underlying = match.group("underlying")
            expiry_raw = match.group("expiry")  # YYMMDD
            strike = match.group("strike")
            ot = match.group("ot")

            # Convert YYMMDD → YYYY-MM-DD for Redis key lookup
            try:
                expiry = f"20{expiry_raw[:2]}-{expiry_raw[2:4]}-{expiry_raw[4:6]}"
            except (IndexError, ValueError):
                continue

            # Strip trailing .0 from strike for key lookup
            strike_key = strike
            try:
                sv = float(strike)
                strike_key = str(int(sv)) if sv == int(sv) else strike
            except ValueError:
                pass

            field = f"{strike_key}:{ot}"

            # Look up token from scrip master (in-memory first, then Redis)
            token = self._scrip.scrip_tokens.get(underlying, {}).get(expiry, {}).get(field)
            if not token:
                # Fallback: check Redis cache
                try:
                    async with get_redis(self._redis_url) as client:
                        token = await client.hget(
                            f"cache:scrip:token:{underlying}:{expiry}", field
                        )
                except Exception:
                    pass

            if not token:
                logger.debug(
                    "position_subscriber.token_not_found",
                    symbol=symbol, field=field,
                )
                continue

            # Determine segment from instrument master
            cfg = self._im.get(underlying)
            if cfg is None:
                # Never guess a segment: an NSE-prefixed MCX token would
                # subscribe to an unrelated contract.
                logger.warning("position_subscriber.unknown_underlying", symbol=symbol)
                continue

            sub_token = f"{cfg.segment}|{token}"
            tokens.append(sub_token)
            token_to_sym[token] = symbol

        new_set = set(tokens)
        new_keys: set[tuple[str, str]] = set()
        for pos in positions:
            symbol = pos.get("symbol", "")
            match = _SYM_RE.match(symbol)
            if match:
                u = match.group("underlying")
                e_raw = match.group("expiry")
                try:
                    e = f"20{e_raw[:2]}-{e_raw[2:4]}-{e_raw[4:6]}"
                    new_keys.add((u, e))
                except (IndexError, ValueError):
                    pass

        old_keys = self._position_ue_keys
        if new_set == self._current_tokens and new_keys == old_keys:
            return  # No change — skip resubscribe

        self._current_tokens = new_set

        if self._aggregator is not None:
            for key in new_keys - old_keys:
                self._aggregator.register_position_key(*key)
            for key in old_keys - new_keys:
                self._aggregator.unregister_position_key(*key)

        if self._subscription_manager is not None:
            for key in new_keys - old_keys:
                await self._subscription_manager.ensure_subscribed(*key, prewarm=True)
            for key in old_keys - new_keys:
                self._subscription_manager.release_prewarm(*key)

        self._position_ue_keys = new_keys

        if not tokens:
            logger.info("position_subscriber.no_tokens", reason="no_open_positions")
            return

        # Update connector's token→symbol mapping for tick parsing
        for tok, sym in token_to_sym.items():
            self._connector.token_to_symbol[tok] = sym

        await self._connector.subscribe_channel(tokens, _POSITION_CHANNEL)
        logger.info(
            "position_subscriber.subscribed",
            channel=_POSITION_CHANNEL,
            tokens=len(tokens),
            symbols=[pos.get("symbol") for pos in positions[:5]],
        )

    async def resubscribe(self) -> None:
        """Replay the current position tokens (after a socket reconnect)."""
        if self._current_tokens:
            await self._connector.subscribe_channel(
                sorted(self._current_tokens), _POSITION_CHANNEL
            )
            logger.info(
                "position_subscriber.resubscribed", tokens=len(self._current_tokens)
            )
