"""WebSocket endpoint – accepts connections and dispatches subscribe/unsubscribe."""

from __future__ import annotations

from datetime import datetime, timezone

import orjson
import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api_gateway.config import settings
from api_gateway.market_subscriptions import (
    request_market_demand,
    request_market_subscription,
    request_market_unsubscription,
)
from api_gateway.websockets.manager import ConnectionManager
from shared.redis_client import cache_get

router = APIRouter()
log = structlog.get_logger()


# Shared manager instance (set by main.py lifespan)
manager: ConnectionManager = ConnectionManager()

# Analytics tiers quant_service knows about, kept in sync with
# quant_service.indicators.registry. The gateway only relays them, so it needs
# the names solely to answer a client that didn't state any.
_ALL_ANALYTICS_TIERS: frozenset[str] = frozenset({"greeks", "models"})
_ALL_TIERS_SENTINEL = object()


async def _send_json(ws: WebSocket, payload: dict[str, object]) -> None:
    await ws.send_text(orjson.dumps(payload).decode())


async def _send_cached_snapshots(ws: WebSocket, topics: list[str]) -> None:
    """Push the cached chain snapshot for each chain topic immediately.

    Without this a new subscriber sees nothing until the next live tick emits
    a snapshot — seconds on illiquid chains.
    """
    for topic in topics:
        if not topic.startswith("ticks:chain:"):
            continue
        parts = topic.split(":")
        if len(parts) != 4:
            continue
        key = f"cache:chain:snapshot:{parts[2]}:{parts[3]}"
        try:
            raw = await cache_get(settings.redis_url, key)
            if raw:
                await ws.send_text(
                    orjson.dumps({"topic": topic, "payload": orjson.loads(raw)}).decode()
                )
        except Exception:
            log.exception("ws_stream.cached_snapshot_failed", topic=topic)


def _parse_demand(
    entries: object,
) -> dict[tuple[str, str], tuple[int, frozenset[str]]] | None:
    """Parse a demand body into {(underlying, expiry): (throttle_ms, tiers)}.

    Returns None for a malformed body so a bad message is rejected outright
    rather than read as "this client now demands nothing", which would slow
    every chain it is actually watching.

    A missing `analytics` key means the client predates the field, so it gets
    every tier; an explicitly empty list is a real claim — quotes only.
    """
    if not isinstance(entries, list):
        return None
    parsed: dict[tuple[str, str], tuple[int, frozenset[str]]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        underlying = entry.get("underlying")
        expiry = entry.get("expiry")
        throttle = entry.get("throttleMs")
        if not isinstance(underlying, str) or not isinstance(expiry, str):
            return None
        if not isinstance(throttle, (int, float)) or isinstance(throttle, bool):
            return None
        if throttle <= 0:
            return None

        raw_tiers = entry.get("analytics", _ALL_TIERS_SENTINEL)
        if raw_tiers is _ALL_TIERS_SENTINEL:
            tiers = _ALL_ANALYTICS_TIERS
        elif isinstance(raw_tiers, list) and all(
            isinstance(tier, str) for tier in raw_tiers
        ):
            tiers = frozenset(raw_tiers)
        else:
            return None

        parsed[(underlying, expiry)] = (int(throttle), tiers)
    return parsed


async def _publish_demand(
    effective: dict[tuple[str, str], tuple[int, frozenset[str] | None]],
) -> None:
    """Relay the effective demand for each affected chain to market-data.

    A chain with no claims left is skipped: stopping a chain nobody needs is
    the unsubscribe path's job, and republishing a zero here would only race
    with it.
    """
    for (underlying, expiry), (throttle_ms, tiers) in effective.items():
        if throttle_ms <= 0:
            continue
        await request_market_demand(
            underlying,
            expiry,
            throttle_ms,
            None if tiers is None else sorted(tiers),
        )


def _extract_market_keys(topics: list[str]) -> set[tuple[str, str]]:
    """Collapse topic subscriptions to unique (underlying, expiry) pairs."""
    keys: set[tuple[str, str]] = set()
    for topic in topics:
        if not (
            topic.startswith("ticks:chain:")
            or topic.startswith("ticks:option:")
        ):
            continue
        parts = topic.split(":")
        if len(parts) == 4:
            keys.add((parts[2], parts[3]))
    return keys


@router.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    """WebSocket endpoint.

    After connect the client sends JSON messages::

        {"action": "subscribe",   "topics": ["ticks:chain:NIFTY:2026-03-19", ...]}
        {"action": "unsubscribe", "topics": ["ticks:chain:NIFTY:2026-03-19"]}
    """
    await manager.connect(ws)
    await _send_json(ws, {
        "type": "ready",
        "serverTime": datetime.now(timezone.utc).isoformat(),
    })
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = orjson.loads(raw)
            except orjson.JSONDecodeError:
                await _send_json(ws, {"type": "error", "error": "invalid JSON"})
                continue

            action = msg.get("action")
            topics = [topic for topic in msg.get("topics", []) if isinstance(topic, str)]

            if action == "subscribe" and topics:
                first_topics = await manager.subscribe(ws, topics)
                passive = bool(msg.get("passive", False))
                await _send_json(ws, {
                    "type": "subscribed",
                    "topics": topics,
                    "passive": passive,
                })

                # Signal market data service for chain topics (skip if passive —
                # position tokens are already subscribed by PositionSubscriber)
                if not passive:
                    for underlying, expiry in _extract_market_keys(first_topics):
                        # Carry any already-known demand so a chain subscribed
                        # while the tab is hidden never starts at full rate.
                        throttle, _ = await manager.effective_demand(
                            (underlying, expiry)
                        )
                        await request_market_subscription(
                            underlying, expiry, throttle or None
                        )

                # Paint immediately from cache instead of waiting for the next tick
                await _send_cached_snapshots(ws, topics)
            elif action == "unsubscribe" and topics:
                await manager.unsubscribe(ws, topics)
                await _send_json(ws, {"type": "unsubscribed", "topics": topics})
                for underlying, expiry in _extract_market_keys(topics):
                    if not await manager.has_market_stream(underlying, expiry):
                        await request_market_unsubscription(underlying, expiry)
            elif action == "demand":
                parsed = _parse_demand(msg.get("chains"))
                if parsed is None:
                    await _send_json(ws, {"type": "error", "error": "invalid demand"})
                    continue
                await _publish_demand(await manager.set_demand(ws, parsed))
                await _send_json(ws, {"type": "demand_ack", "count": len(parsed)})
            elif action == "ping":
                ts = msg.get("ts")
                payload: dict[str, object] = {"type": "pong"}
                if isinstance(ts, (int, float)):
                    payload["ts"] = ts
                await _send_json(ws, payload)
            else:
                await _send_json(ws, {"type": "error", "error": "unknown action"})
    except WebSocketDisconnect:
        await _teardown(ws)
    except Exception:
        log.exception("ws_stream.error")
        await _teardown(ws)


async def _teardown(ws: WebSocket) -> None:
    """Release a departing client's topics and its demand claims.

    Demand is released first so the republish below reflects only the clients
    still connected: otherwise a quotes-only client (the mobile app) dropping
    off would leave its narrow analytics tier in force for whoever remains.
    """
    released = await manager.release_demand(ws)
    removed_topics = await manager.disconnect(ws)
    for underlying, expiry in _extract_market_keys(removed_topics):
        if not await manager.has_market_stream(underlying, expiry):
            await request_market_unsubscription(underlying, expiry)
            released.pop((underlying, expiry), None)
    await _publish_demand(released)
