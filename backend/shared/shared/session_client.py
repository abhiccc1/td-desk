"""Shared session client — read/write versioned Kotak session from Redis.

Replaces scattered cache_get("cache:auth:kotak") + json.loads() patterns
with a typed SessionBundle interface backed by a Redis hash.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import structlog
from fastapi import HTTPException

from shared.redis_client import get_pool, get_redis
from shared.schemas.auth import SessionBundle, SessionState

log = structlog.get_logger()

_SESSION_KEY = "session:kotak:current"
_VERSION_CHANNEL = "session:kotak:version_changed"
_STATUS_CHANNEL = "session:status"
_LEGACY_CACHE_KEY = "cache:auth:kotak"
_SESSION_TTL = 86400  # 24h


def _bundle_to_hash(bundle: SessionBundle) -> dict[str, str]:
    """Convert SessionBundle to a flat dict of strings for HSET."""
    return {
        "version": str(bundle.version),
        "state": bundle.state.value,
        "broker_name": bundle.broker_name,
        # Broker credentials stay in process memory only.
        "access_token": "",
        "sid": "",
        "server_id": bundle.server_id,
        "data_center": bundle.data_center,
        "base_url": bundle.base_url,
        "environment": bundle.environment,
        "authenticated_at": bundle.authenticated_at,
        "last_health_check": bundle.last_health_check,
        "health_check_ok": "1" if bundle.health_check_ok else "0",
    }


def _hash_to_bundle(data: dict[str, str]) -> SessionBundle:
    """Parse a Redis hash (all strings) into a SessionBundle."""
    return SessionBundle(
        version=int(data.get("version", "0")),
        state=SessionState(data.get("state", "unauthenticated")),
        broker_name=data.get("broker_name", "kotak"),
        access_token=data.get("access_token", ""),
        sid=data.get("sid", ""),
        server_id=data.get("server_id", ""),
        data_center=data.get("data_center", ""),
        base_url=data.get("base_url", ""),
        environment=data.get("environment", "prod"),
        authenticated_at=data.get("authenticated_at", ""),
        last_health_check=data.get("last_health_check", ""),
        health_check_ok=data.get("health_check_ok", "1") == "1",
    )


async def get_session(redis_url: str) -> SessionBundle | None:
    """Read the current session bundle from Redis. Returns None if missing."""
    try:
        async with get_redis(redis_url) as client:
            data = await client.hgetall(_SESSION_KEY)
            if not data:
                return None
            return _hash_to_bundle(data)
    except Exception as exc:
        log.warning("session_client.get_failed", error=str(exc))
        return None


async def get_session_or_raise(redis_url: str) -> SessionBundle:
    """Read session metadata or raise HTTP 401 if it is not currently active."""
    session = await get_session(redis_url)
    if not session or session.state not in (SessionState.ACTIVE, SessionState.DEGRADED):
        raise HTTPException(status_code=401, detail="Kotak session unavailable")
    if not session.base_url:
        raise HTTPException(status_code=401, detail="Kotak session unavailable")
    return session


async def store_session(redis_url: str, bundle: SessionBundle) -> None:
    """Atomically increment version, write session metadata, publish changes."""
    try:
        async with get_redis(redis_url) as client:
            pipe = client.pipeline()
            # Increment version
            pipe.hincrby(_SESSION_KEY, "version", 1)
            await pipe.execute()

            # Read new version
            new_version = await client.hget(_SESSION_KEY, "version")
            bundle.version = int(new_version)

            # Write all fields
            mapping = _bundle_to_hash(bundle)
            pipe = client.pipeline()
            pipe.hset(_SESSION_KEY, mapping=mapping)
            pipe.expire(_SESSION_KEY, _SESSION_TTL)
            pipe.delete(_LEGACY_CACHE_KEY)

            # Publish version change notification
            pipe.publish(_VERSION_CHANNEL, str(bundle.version))

            await pipe.execute()
            log.info("session_client.stored", version=bundle.version, state=bundle.state)
    except Exception as exc:
        log.error("session_client.store_failed", error=str(exc))
        raise


async def update_health_check_timestamp(redis_url: str, bundle: SessionBundle) -> None:
    """Update only the health check fields without bumping version."""
    try:
        async with get_redis(redis_url) as client:
            await client.hset(_SESSION_KEY, mapping={
                "last_health_check": bundle.last_health_check,
                "health_check_ok": "1" if bundle.health_check_ok else "0",
            })
    except Exception as exc:
        log.warning("session_client.health_update_failed", error=str(exc))


async def publish_session_status(redis_url: str, version: int, status: str) -> None:
    """Publish a session status event for the frontend (via fan-out)."""
    import orjson

    try:
        async with get_redis(redis_url) as client:
            payload = orjson.dumps({
                "event_type": "session_status",
                "source_service": "session",
                "payload": {"version": version, "status": status},
            }).decode()
            await client.publish(_STATUS_CHANNEL, payload)
    except Exception as exc:
        log.warning("session_client.status_publish_failed", error=str(exc))


async def watch_session_version(redis_url: str) -> AsyncGenerator[int, None]:
    """Yield session version numbers on changes.

    Combines pub/sub push with a 30s poll fallback for reliability.
    On startup, yields the current version immediately (bootstrap).
    """
    import redis.asyncio as aioredis

    pool = get_pool(redis_url)

    # Bootstrap: yield current version
    try:
        client = aioredis.Redis(connection_pool=pool)
        current = await client.hget(_SESSION_KEY, "version")
        if current:
            yield int(current)
        await client.aclose()
    except Exception:
        pass

    # Watch for changes via pub/sub + poll fallback
    while True:
        try:
            client = aioredis.Redis(connection_pool=pool)
            pubsub = client.pubsub()
            await pubsub.subscribe(_VERSION_CHANNEL)

            last_poll = asyncio.get_event_loop().time()

            async for message in pubsub.listen():
                if message["type"] == "message":
                    try:
                        yield int(message["data"])
                    except (ValueError, TypeError):
                        pass

                # Poll fallback every 30s
                now = asyncio.get_event_loop().time()
                if now - last_poll >= 30:
                    last_poll = now
                    try:
                        check_client = aioredis.Redis(connection_pool=pool)
                        ver = await check_client.hget(_SESSION_KEY, "version")
                        await check_client.aclose()
                        if ver:
                            yield int(ver)
                    except Exception:
                        pass

        except asyncio.CancelledError:
            return
        except Exception as exc:
            log.warning("session_client.watch_error", error=str(exc))
            await asyncio.sleep(5)
