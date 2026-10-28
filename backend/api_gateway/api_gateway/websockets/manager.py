"""WebSocket connection manager – tracks topic subscriptions and broadcasts."""

from __future__ import annotations

import asyncio
from collections import defaultdict

import structlog
from fastapi import WebSocket

log = structlog.get_logger()

# Per-client outbound queue depth. Chain snapshots supersede each other, so
# dropping the oldest under backpressure loses nothing the next message
# doesn't replace. Keep this small: messages can be full-chain snapshots
# (hundreds of KB), and a throttled background tab holds a full queue —
# 200-deep queues pinned the gateway against its memory limit (frozen
# event loop, 2026-07-15).
_QUEUE_MAX = 50
_SEND_TIMEOUT_S = 10.0


class ConnectionManager:
    """Track WebSocket connections and their topic subscriptions.

    Each client gets a bounded outbound queue drained by its own writer task,
    so one slow client can never block fan-out to the others (the old
    gather-on-send design stalled every topic for every client behind the
    slowest socket).
    """

    def __init__(self) -> None:
        # topic -> set of connected websockets
        self._subscriptions: dict[str, set[WebSocket]] = defaultdict(set)
        # websocket -> set of topics it is subscribed to
        self._ws_topics: dict[WebSocket, set[str]] = defaultdict(set)
        self._queues: dict[WebSocket, asyncio.Queue[str]] = {}
        self._writers: dict[WebSocket, asyncio.Task] = {}
        # websocket -> {(underlying, expiry) -> (throttle_ms, analytics tiers)}.
        # Demand is stored per client and reduced across clients: min() on the
        # cadence and union on the tiers, so one tab can never slow down or
        # starve another, and a client that disappears takes only its own claim.
        self._ws_demand: dict[
            WebSocket, dict[tuple[str, str], tuple[int, frozenset[str]]]
        ] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=_QUEUE_MAX)
        async with self._lock:
            self._queues[ws] = queue
            self._writers[ws] = asyncio.create_task(self._writer(ws, queue))
        log.info("ws_manager.connect", client=ws.client)

    async def disconnect(self, ws: WebSocket) -> list[str]:
        removed_topics: list[str]
        async with self._lock:
            topics = self._ws_topics.pop(ws, set())
            removed_topics = list(topics)
            for topic in topics:
                self._subscriptions[topic].discard(ws)
                if not self._subscriptions[topic]:
                    del self._subscriptions[topic]
            self._queues.pop(ws, None)
            self._ws_demand.pop(ws, None)
            writer = self._writers.pop(ws, None)
        if writer is not None and writer is not asyncio.current_task():
            writer.cancel()
        log.info("ws_manager.disconnect", client=ws.client)
        return removed_topics

    async def subscribe(self, ws: WebSocket, topics: list[str]) -> list[str]:
        first_subscriptions: list[str] = []
        async with self._lock:
            for topic in topics:
                was_empty = not self._subscriptions[topic]
                self._subscriptions[topic].add(ws)
                self._ws_topics[ws].add(topic)
                if was_empty:
                    first_subscriptions.append(topic)
        log.info("ws_manager.subscribe", topics=topics, client=ws.client)
        return first_subscriptions

    async def unsubscribe(self, ws: WebSocket, topics: list[str]) -> None:
        async with self._lock:
            for topic in topics:
                self._subscriptions[topic].discard(ws)
                if not self._subscriptions[topic]:
                    del self._subscriptions[topic]
                self._ws_topics[ws].discard(topic)
        log.info("ws_manager.unsubscribe", topics=topics, client=ws.client)

    async def set_demand(
        self, ws: WebSocket, keys: dict[tuple[str, str], tuple[int, frozenset[str]]]
    ) -> dict[tuple[str, str], tuple[int, frozenset[str] | None]]:
        """Record one client's demand and return the effective level per chain.

        *keys* is the client's complete current demand, not a delta: chains it
        omits are dropped. Stating demand in full each time means a lost or
        reordered message can't leave a stale claim pinning a chain at the
        active rate forever.
        """
        async with self._lock:
            previous = set(self._ws_demand.get(ws, {}))
            self._ws_demand[ws] = dict(keys)
            affected = previous | set(keys)
            return {key: self._effective_demand(key) for key in affected}

    async def release_demand(
        self, ws: WebSocket
    ) -> dict[tuple[str, str], tuple[int, frozenset[str] | None]]:
        """Drop a client's claims and report the effective demand left behind.

        Called on disconnect so the remaining clients' union is republished at
        once. Without it a quotes-only client (the mobile app) dropping off
        would leave its narrow tier in force, starving a desktop client of the
        Greeks it had asked for until something else restated demand.
        """
        async with self._lock:
            claimed = set(self._ws_demand.pop(ws, {}))
            return {key: self._effective_demand(key) for key in claimed}

    async def effective_demand(
        self, key: tuple[str, str]
    ) -> tuple[int, frozenset[str] | None]:
        """Effective (cadence, tiers) for a chain; (0, None) if unclaimed."""
        async with self._lock:
            return self._effective_demand(key)

    def _effective_demand(
        self, key: tuple[str, str]
    ) -> tuple[int, frozenset[str] | None]:
        """Fastest cadence and the union of tiers across connected clients.

        (0, None) means nobody asserted anything — the market-data service then
        falls back to the active rate and every analytics tier rather than
        guessing. An empty tier set is a different statement: the clients render
        quotes only, so no analytics are worth computing at all.
        """
        claims = [
            demand[key] for demand in self._ws_demand.values() if key in demand
        ]
        if not claims:
            return 0, None
        throttle = min(throttle for throttle, _ in claims)
        tiers: frozenset[str] = frozenset()
        for _, claimed_tiers in claims:
            tiers |= claimed_tiers
        return throttle, tiers

    async def broadcast(self, topic: str, data: str) -> None:
        """Enqueue *data* for every WebSocket subscribed to *topic*. Never blocks."""
        async with self._lock:
            queues = [
                self._queues[ws]
                for ws in self._subscriptions.get(topic, set())
                if ws in self._queues
            ]

        for queue in queues:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                # Drop the oldest message; the client is behind and newer
                # market data supersedes it anyway.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(data)
                except asyncio.QueueFull:
                    pass

    async def _writer(self, ws: WebSocket, queue: asyncio.Queue[str]) -> None:
        """Drain one client's queue. A send that errors or stalls past the
        timeout marks the client dead and disconnects it."""
        try:
            while True:
                data = await queue.get()
                await asyncio.wait_for(ws.send_text(data), timeout=_SEND_TIMEOUT_S)
        except asyncio.CancelledError:
            return
        except Exception:
            log.warning("ws_manager.writer_dead", client=ws.client)
            asyncio.create_task(self.disconnect(ws))

    async def has_market_stream(self, underlying: str, expiry: str) -> bool:
        """Return whether any client still needs the chain-snapshot pipeline.

        Keyed on ticks:chain only. ticks:option is the raw per-strike stream,
        published straight from the tick handler and unaffected by releasing a
        chain view — and it is pinned on the client for any expiry holding an
        open position. Counting it here meant that for anyone with a position
        on, the chain could never be released: it stayed at the active rate
        (snapshot build + full IV/Greeks solve, 40x/second) for the life of the
        session, no matter what the UI was doing. Positions keep their LTP from
        ticks:option and their Greeks from the independent 5s position-snapshot
        pipeline, neither of which this gates.
        """
        topic = f"ticks:chain:{underlying}:{expiry}"
        async with self._lock:
            return bool(self._subscriptions.get(topic))
