"""Snapshot aggregator — builds throttled option chain snapshots from ticks."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

import orjson
import structlog

from shared.redis_client import cache_set, publish_event
from shared.schemas.events import EventType, RedisEvent
from shared.schemas.tick import OptionChainSnapshot, OptionStrike, TickData

from market_data_service.config import MarketDataSettings

logger = structlog.get_logger()

# Pattern: UNDERLYING YYMMDD STRIKE CE/PE  (e.g. "NIFTY 260319 22000 CE")
_OPTION_RE = re.compile(
    r"^(?P<underlying>[A-Z]+)\s*(?P<expiry>\d{6})\s*(?P<strike>[\d.]+)\s*(?P<side>CE|PE)$"
)


def _yymmdd_to_iso(yymmdd: str) -> str:
    """Convert 'YYMMDD' to 'YYYY-MM-DD'."""
    try:
        dt = datetime.strptime(yymmdd, "%y%m%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return yymmdd


class SnapshotAggregator:
    """Collects ticks and periodically emits throttled OptionChainSnapshot events."""

    def __init__(self, settings: MarketDataSettings) -> None:
        self._redis_url = settings.redis_url
        self._service_name = settings.service_name
        self._throttle_s = settings.snapshot_throttle_ms / 1000.0

        # Keyed by (underlying, expiry) -> {strike -> {"CE": TickData, "PE": TickData}}
        self._accum: dict[
            tuple[str, str],
            dict[float, dict[str, TickData]],
        ] = {}

        # Tracks the underlying LTP separately (non-option instrument)
        self._underlying_ltp: dict[str, float] = {}

        # Last emit time per (underlying, expiry)
        self._last_emit: dict[tuple[str, str], float] = {}

    def _parse_symbol(self, symbol: str) -> tuple[str, str, float, str] | None:
        """Return (underlying, expiry, strike, side) or None if not an option."""
        m = _OPTION_RE.match(symbol)
        if m is None:
            return None
        return (
            m.group("underlying"),
            m.group("expiry"),
            float(m.group("strike")),
            m.group("side"),
        )

    async def process_tick(self, tick: TickData) -> None:
        """Ingest a tick, accumulate it, and emit a snapshot if throttle has elapsed."""
        parsed = self._parse_symbol(tick.symbol)

        if parsed is None:
            # Not an option tick — track underlying LTP for snapshots
            self._underlying_ltp[tick.symbol] = tick.ltp
            return

        underlying, expiry_raw, strike, side = parsed
        expiry = _yymmdd_to_iso(expiry_raw)
        key = (underlying, expiry)

        strikes = self._accum.setdefault(key, {})
        strike_entry = strikes.setdefault(strike, {})
        strike_entry[side] = tick

        now = asyncio.get_event_loop().time()
        last = self._last_emit.get(key, 0.0)

        if now - last >= self._throttle_s:
            await self._emit_snapshot(underlying, expiry)
            self._last_emit[key] = now

    async def _emit_snapshot(self, underlying: str, expiry: str) -> None:
        """Build and publish an OptionChainSnapshot from accumulated ticks."""
        key = (underlying, expiry)
        strikes_map = self._accum.get(key)
        if not strikes_map:
            return

        option_strikes: list[OptionStrike] = []
        exchange = ""
        source_timestamp: datetime | None = None

        for strike_val in sorted(strikes_map):
            sides = strikes_map[strike_val]
            call_tick = sides.get("CE")
            put_tick = sides.get("PE")

            if not exchange:
                exchange = (call_tick or put_tick or TickData(symbol="", exchange="", ltp=0, timestamp=datetime.now(timezone.utc))).exchange

            option_strikes.append(
                OptionStrike(
                    strike=strike_val,
                    call=call_tick,
                    put=put_tick,
                )
            )

            for tick in (call_tick, put_tick):
                if tick is not None and (
                    source_timestamp is None or tick.timestamp > source_timestamp
                ):
                    source_timestamp = tick.timestamp

        underlying_price = self._underlying_ltp.get(underlying, 0.0)
        published_at = datetime.now(timezone.utc)

        snapshot = OptionChainSnapshot(
            underlying=underlying,
            underlying_price=underlying_price,
            expiry=expiry,
            exchange=exchange,
            strikes=option_strikes,
            timestamp=published_at,
            source_timestamp=source_timestamp,
        )
        snapshot_payload = snapshot.model_dump(mode="json", by_alias=True)
        snapshot_json = orjson.dumps(snapshot_payload).decode()

        # Publish event — use by_alias=True so WebSocket clients get camelCase keys
        event = RedisEvent(
            event_type=EventType.CHAIN_SNAPSHOT,
            source_service=self._service_name,
            payload=snapshot_payload,
        )
        channel = f"ticks:chain:{underlying}:{expiry}"
        await publish_event(self._redis_url, channel, event)

        # Cache the full snapshot JSON for the REST endpoint.
        snapshot_key = f"cache:chain:snapshot:{underlying}:{expiry}"
        await cache_set(
            self._redis_url,
            snapshot_key,
            snapshot_json,
        )

        logger.info(
            "option chain snapshot emitted",
            underlying=underlying,
            expiry=expiry,
            strikes=len(option_strikes),
            source_age_ms=(
                int((published_at - source_timestamp).total_seconds() * 1000)
                if source_timestamp is not None
                else None
            ),
        )
