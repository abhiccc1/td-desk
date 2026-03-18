"""WebSocket connection manager – tracks topic subscriptions and broadcasts."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict

import structlog
from fastapi import WebSocket

log = structlog.get_logger()


class ConnectionManager:
    """Track WebSocket connections and their topic subscriptions."""

    def __init__(self) -> None:
        # topic -> set of connected websockets
        self._subscriptions: dict[str, set[WebSocket]] = defaultdict(set)
        # websocket -> set of topics it is subscribed to
        self._ws_topics: dict[WebSocket, set[str]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        log.info("ws_manager.connect", client=ws.client)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            topics = self._ws_topics.pop(ws, set())
            for topic in topics:
                self._subscriptions[topic].discard(ws)
                if not self._subscriptions[topic]:
                    del self._subscriptions[topic]
        log.info("ws_manager.disconnect", client=ws.client)

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

    async def broadcast(self, topic: str, data: dict | str) -> None:
        """Send *data* to every WebSocket subscribed to *topic*."""
        payload = data if isinstance(data, str) else json.dumps(data)
        async with self._lock:
            subscribers = list(self._subscriptions.get(topic, set()))

        send_results = await asyncio.gather(
            *(ws.send_text(payload) for ws in subscribers),
            return_exceptions=True,
        )
        dead = [
            ws
            for ws, result in zip(subscribers, send_results, strict=False)
            if isinstance(result, Exception)
        ]

        # Clean up broken connections
        for ws in dead:
            await self.disconnect(ws)
