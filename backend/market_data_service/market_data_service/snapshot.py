"""Snapshot aggregator — builds throttled option chain snapshots from ticks."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

import orjson
import structlog

import redis.asyncio as aioredis

from shared.redis_client import get_pool
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


def _parity_spot_estimate(strikes_map: dict[float, dict[str, TickData]]) -> float:
    """Estimate the spot price via put-call parity: S ≈ K + C − P.

    Kotak's index feed never disseminates some underlyings (MIDCPNIFTY token
    26074 is valid but dead), so no spot tick ever arrives and the chain would
    publish underlyingPrice=0. The estimate is taken at the strike where
    |C − P| is smallest (nearest ATM), where the parity error and the ignored
    discounting term are negligible.
    """
    best_diff = float("inf")
    best_estimate = 0.0
    for strike, sides in strikes_map.items():
        call = sides.get("CE")
        put = sides.get("PE")
        if call is None or put is None or call.ltp <= 0 or put.ltp <= 0:
            continue
        diff = call.ltp - put.ltp
        if abs(diff) < best_diff:
            best_diff = abs(diff)
            best_estimate = strike + diff
    return best_estimate


class SnapshotAggregator:
    """Collects ticks and periodically emits throttled OptionChainSnapshot events."""

    def __init__(self, settings: MarketDataSettings) -> None:
        self._redis_url = settings.redis_url
        self._service_name = settings.service_name
        self._throttle_s = settings.snapshot_throttle_ms / 1000.0
        self._background_throttle_s = settings.snapshot_background_throttle_ms / 1000.0
        self._max_throttle_s = settings.snapshot_max_throttle_ms / 1000.0
        self._client = None  # persistent Redis client

        # Keyed by (underlying, expiry) -> {strike -> {"CE": TickData, "PE": TickData}}
        self._accum: dict[
            tuple[str, str],
            dict[float, dict[str, TickData]],
        ] = {}

        # Tracks the underlying LTP separately (non-option instrument)
        self._underlying_ltp: dict[str, float] = {}

        # Options-on-futures: underlying -> {option expiry -> future info}
        # (from ScripMasterResult.underlying_future). The future's tick symbol
        # is the key into _underlying_ltp for that expiry's chain.
        self._underlying_futures: dict[str, dict[str, dict[str, str]]] = {}

        # Last emit time per (underlying, expiry)
        self._last_emit: dict[tuple[str, str], float] = {}

        # Position pipeline tracking
        self._position_keys: set[tuple[str, str]] = set()  # (underlying, expiry) pairs from positions
        self._chain_keys: set[tuple[str, str]] = set()     # (underlying, expiry) pairs from UI subscription
        # Per-chain emit cadence asserted by the UI's demand signal. A key
        # absent here emits at the active rate — see _chain_throttle_s.
        self._chain_rates: dict[tuple[str, str], float] = {}
        # Analytics tiers the connected clients asked for, per chain. Rides on
        # the snapshot so quant_service runs only the indicators someone is
        # actually going to render. Kept independently of _chain_keys: position
        # snapshots outlive the UI's chain view and must carry the tier too.
        self._chain_analytics: dict[tuple[str, str], list[str]] = {}
        self._position_last_emit: dict[tuple[str, str], float] = {}
        self._position_throttle_s = 5.0  # 5s for position snapshots (vs ~100ms for chain)

    def reset(self) -> None:
        """Clear all accumulated state (used on connector rebuild)."""
        self._accum.clear()
        self._underlying_ltp.clear()
        self._last_emit.clear()
        self._position_keys.clear()
        self._chain_keys.clear()
        self._chain_rates.clear()
        self._chain_analytics.clear()
        self._position_last_emit.clear()
        logger.info("snapshot_aggregator.reset")

    def set_underlying_futures(self, mapping: dict[str, dict[str, dict[str, str]]]) -> None:
        self._underlying_futures = {u: dict(m) for u, m in mapping.items()}

    async def _get_client(self):
        if self._client is None:
            self._client = aioredis.Redis(connection_pool=get_pool(self._redis_url))
        return self._client

    def register_position_key(self, underlying: str, expiry: str) -> None:
        self._position_keys.add((underlying, expiry))

    def unregister_position_key(self, underlying: str, expiry: str) -> None:
        self._position_keys.discard((underlying, expiry))

    def register_chain_key(
        self, underlying: str, expiry: str, throttle_ms: int | None = None
    ) -> None:
        key = (underlying, expiry)
        self._chain_keys.add(key)
        if throttle_ms is not None:
            self._chain_rates[key] = self._clamp_throttle_s(throttle_ms)
        # Emit straight from accumulated ticks so a (re)subscribing viewer
        # gets a snapshot now instead of waiting for the chain's next tick.
        if self._accum.get(key):
            self._last_emit[key] = asyncio.get_event_loop().time()
            asyncio.create_task(self._emit_snapshot(underlying, expiry))

    def unregister_chain_key(self, underlying: str, expiry: str) -> None:
        key = (underlying, expiry)
        self._chain_keys.discard(key)
        self._last_emit.pop(key, None)
        self._chain_rates.pop(key, None)

    def set_chain_rate(self, underlying: str, expiry: str, throttle_ms: int) -> None:
        """Change a live chain's emit cadence without touching its subscription.

        Called when the UI's demand level changes (panel closed, tab hidden,
        user idle). Speeding a chain back up emits immediately rather than
        waiting out the slow interval the previous level had armed, so
        returning to the tab repaints at once.
        """
        key = (underlying, expiry)
        new_s = self._clamp_throttle_s(throttle_ms)
        previous_s = self._chain_throttle_s(key)
        self._chain_rates[key] = new_s

        if new_s < previous_s and key in self._chain_keys and self._accum.get(key):
            self._last_emit[key] = asyncio.get_event_loop().time()
            asyncio.create_task(self._emit_snapshot(*key))

        logger.info(
            "snapshot_aggregator.rate_changed",
            underlying=underlying,
            expiry=expiry,
            throttle_ms=round(new_s * 1000),
            previous_ms=round(previous_s * 1000),
        )

    def set_chain_analytics(
        self, underlying: str, expiry: str, analytics: list[str] | None
    ) -> None:
        """Record which analytics tiers this chain's consumers want.

        `None` clears the claim, so the chain falls back to running every tier.
        Not cleared by unregister_chain_key: a chain released by the UI can
        still be emitting position snapshots, and those need the tier just as
        much. It is cleared by reset(), and the gateway restates the union
        across connected clients whenever one connects, changes or drops.
        """
        key = (underlying, expiry)
        if analytics is None:
            self._chain_analytics.pop(key, None)
        else:
            self._chain_analytics[key] = list(analytics)

    def _clamp_throttle_s(self, throttle_ms: int) -> float:
        """Bound a requested cadence to [active, max] so a bad client value
        can neither hammer the pipeline nor silently freeze a chain."""
        return min(
            max(throttle_ms / 1000.0, self._throttle_s),
            self._max_throttle_s,
        )

    def _chain_throttle_s(self, key: tuple[str, str]) -> float:
        """Cadence for a chain. An unasserted key emits at the active rate:
        if the demand signal is missing we would rather burn CPU than show a
        stale chain to someone watching it."""
        return self._chain_rates.get(key, self._throttle_s)

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

        if key in self._chain_keys and now - last >= self._chain_throttle_s(key):
            await self._emit_snapshot(underlying, expiry)
            self._last_emit[key] = now

        # Position pipeline: emit a separate position_chain_snapshot when needed
        if key in self._position_keys:
            pos_last = self._position_last_emit.get(key, 0.0)
            if now - pos_last >= self._position_throttle_s:
                await self._emit_position_snapshot(underlying, expiry)
                self._position_last_emit[key] = now

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

        underlying_price = self._resolve_underlying_price(underlying, expiry, strikes_map)
        published_at = datetime.now(timezone.utc)

        snapshot = OptionChainSnapshot(
            underlying=underlying,
            underlying_price=underlying_price,
            expiry=expiry,
            exchange=exchange,
            strikes=option_strikes,
            timestamp=published_at,
            source_timestamp=source_timestamp,
            underlying_future=self._underlying_futures.get(underlying, {}).get(expiry),
            analytics=self._chain_analytics.get(key),
        )
        snapshot_payload = snapshot.model_dump(mode="json", by_alias=True)
        snapshot_json = orjson.dumps(snapshot_payload).decode()

        # Lightweight event envelope — skip Pydantic RedisEvent
        event_json = orjson.dumps({
            "event_type": "chain_snapshot",
            "source_service": self._service_name,
            "payload": snapshot_payload,
        }).decode()

        channel = f"ticks:chain:{underlying}:{expiry}"
        snapshot_key = f"cache:chain:snapshot:{underlying}:{expiry}"

        # Pipeline publish + cache in a single round-trip
        client = await self._get_client()
        pipe = client.pipeline(transaction=False)
        pipe.publish(channel, event_json)
        pipe.set(snapshot_key, snapshot_json, ex=30)
        await pipe.execute()

        # debug, not info: this fires at the chain's emit cadence (40/s at the
        # active rate), and structlog JSON rendering at that rate is itself a
        # measurable slice of the service's CPU.
        logger.debug(
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

    def _resolve_underlying_price(
        self, underlying: str, expiry: str, strikes_map: dict[float, dict[str, TickData]]
    ) -> float:
        """Live underlying LTP, falling back to a put-call parity estimate.

        Index options use the spot index tick; options on futures (MCX) use
        the specific future this expiry devolves into — never a different
        contract month. Parity covers feeds that never tick (MIDCPNIFTY) and
        is exact for futures options up to the e^{-rT} discount near ATM.
        """
        fut = self._underlying_futures.get(underlying, {}).get(expiry)
        if fut is not None:
            price = self._underlying_ltp.get(fut["symbol"], 0.0)
        else:
            price = self._underlying_ltp.get(underlying, 0.0)
        if price > 0:
            return price
        return _parity_spot_estimate(strikes_map)

    async def _emit_position_snapshot(self, underlying: str, expiry: str) -> None:
        """Emit a position-specific chain snapshot for the quant service."""
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

        underlying_price = self._resolve_underlying_price(underlying, expiry, strikes_map)

        snapshot = OptionChainSnapshot(
            underlying=underlying,
            underlying_price=underlying_price,
            expiry=expiry,
            exchange=exchange,
            strikes=option_strikes,
            timestamp=datetime.now(timezone.utc),
            source_timestamp=source_timestamp,
            underlying_future=self._underlying_futures.get(underlying, {}).get(expiry),
            analytics=self._chain_analytics.get(key),
        )
        snapshot_payload = snapshot.model_dump(mode="json", by_alias=True)

        event_json = orjson.dumps({
            "event_type": "position_chain_snapshot",
            "source_service": self._service_name,
            "payload": snapshot_payload,
        }).decode()

        channel = f"ticks:position_chain:{underlying}:{expiry}"

        client = await self._get_client()
        await client.publish(channel, event_json)

        logger.debug(
            "position chain snapshot emitted",
            underlying=underlying,
            expiry=expiry,
            strikes=len(option_strikes),
        )
