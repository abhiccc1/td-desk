"""WebSocket endpoint – accepts connections and dispatches subscribe/unsubscribe."""

from __future__ import annotations

import orjson
import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api_gateway.market_subscriptions import request_market_subscription
from api_gateway.websockets.manager import ConnectionManager

router = APIRouter()
log = structlog.get_logger()


# Shared manager instance (set by main.py lifespan)
manager: ConnectionManager = ConnectionManager()


@router.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    """WebSocket endpoint.

    After connect the client sends JSON messages::

        {"action": "subscribe",   "topics": ["ticks:chain:NIFTY:2026-03-19", ...]}
        {"action": "unsubscribe", "topics": ["ticks:chain:NIFTY:2026-03-19"]}
    """
    await manager.connect(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = orjson.loads(raw)
            except orjson.JSONDecodeError:
                await ws.send_text(orjson.dumps({"error": "invalid JSON"}).decode())
                continue

            action = msg.get("action")
            topics = msg.get("topics", [])

            if action == "subscribe" and topics:
                first_topics = await manager.subscribe(ws, topics)
                await ws.send_text(orjson.dumps({"subscribed": topics}).decode())

                # Signal market data service for any chain topics
                for topic in first_topics:
                    if topic.startswith("ticks:chain:") or topic.startswith("ticks:option:"):
                        parts = topic.split(":")
                        if len(parts) == 4:
                            await request_market_subscription(parts[2], parts[3])
            elif action == "unsubscribe" and topics:
                await manager.unsubscribe(ws, topics)
                await ws.send_text(orjson.dumps({"unsubscribed": topics}).decode())
            else:
                await ws.send_text(orjson.dumps({"error": "unknown action"}).decode())
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        log.exception("ws_stream.error")
        await manager.disconnect(ws)
