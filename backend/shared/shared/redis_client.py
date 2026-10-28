"""Async Redis connection factory with Pub/Sub helpers."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import orjson
import redis.asyncio as aioredis
import structlog

from shared.schemas.events import RedisEvent

log = structlog.get_logger()


_pool: aioredis.ConnectionPool | None = None


def get_pool(redis_url: str) -> aioredis.ConnectionPool:
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(
            redis_url,
            decode_responses=True,
            # redis-py 8.0 changed the default socket_timeout from None to 5s. That 5s
            # read timeout fires on blocking pubsub.listen() calls (which legitimately
            # block until a message arrives), tearing down every pub/sub consumer
            # (session watcher, fan-out, quant subscriber) every 5s. Force it back to
            # None and rely on TCP keepalive to detect genuinely dead connections.
            socket_timeout=None,
            socket_keepalive=True,
        )
    return _pool


@asynccontextmanager
async def get_redis(redis_url: str) -> AsyncGenerator[aioredis.Redis, None]:
    pool = get_pool(redis_url)
    client = aioredis.Redis(connection_pool=pool)
    try:
        yield client
    finally:
        await client.aclose()


async def publish_event(redis_url: str, channel: str, event: RedisEvent) -> None:
    async with get_redis(redis_url) as client:
        await client.publish(channel, event.model_dump_json())


async def subscribe(
    redis_url: str, channels: list[str], pattern: bool = False
) -> AsyncGenerator[tuple[str, RedisEvent], None]:
    """Subscribe to Redis channels and yield (channel, event) tuples."""
    pool = get_pool(redis_url)
    client = aioredis.Redis(connection_pool=pool)
    pubsub = client.pubsub()

    if pattern:
        await pubsub.psubscribe(*channels)
    else:
        await pubsub.subscribe(*channels)

    try:
        async for message in pubsub.listen():
            if message["type"] in ("message", "pmessage"):
                channel_name = message.get("channel", message.get("pattern", ""))
                event = RedisEvent.model_validate_json(message["data"])
                yield channel_name, event
    finally:
        await pubsub.unsubscribe()
        await client.aclose()


async def subscribe_raw(
    redis_url: str, channels: list[str], pattern: bool = False
) -> AsyncGenerator[tuple[str, dict], None]:
    """Fast subscribe path — yields (channel, raw dict) without Pydantic validation."""
    pool = get_pool(redis_url)
    client = aioredis.Redis(connection_pool=pool)
    pubsub = client.pubsub()

    if pattern:
        await pubsub.psubscribe(*channels)
    else:
        await pubsub.subscribe(*channels)

    try:
        async for message in pubsub.listen():
            if message["type"] in ("message", "pmessage"):
                channel_name = message.get("channel", message.get("pattern", ""))
                data = message["data"]
                parsed = orjson.loads(data) if isinstance(data, (str, bytes)) else data
                yield channel_name, parsed
    finally:
        await pubsub.unsubscribe()
        await client.aclose()


async def cache_set(redis_url: str, key: str, value: str, ttl: int = 30) -> None:
    try:
        async with get_redis(redis_url) as client:
            await client.set(key, value, ex=ttl)
    except (ConnectionError, TimeoutError, OSError, aioredis.RedisError) as exc:
        log.warning("redis.cache_set_failed", key=key, error=str(exc))
        return


async def cache_get(redis_url: str, key: str) -> str | None:
    try:
        async with get_redis(redis_url) as client:
            return await client.get(key)
    except (ConnectionError, TimeoutError, OSError, aioredis.RedisError) as exc:
        log.warning("redis.cache_get_failed", key=key, error=str(exc))
        return None


async def cache_hset(redis_url: str, key: str, mapping: dict, ttl: int = 30) -> None:
    try:
        async with get_redis(redis_url) as client:
            pipe = client.pipeline()
            pipe.hset(key, mapping=mapping)
            pipe.expire(key, ttl)
            await pipe.execute()
    except (ConnectionError, TimeoutError, OSError, aioredis.RedisError) as exc:
        log.warning("redis.cache_hset_failed", key=key, error=str(exc))
        return


async def cache_hgetall(redis_url: str, key: str) -> dict:
    try:
        async with get_redis(redis_url) as client:
            return await client.hgetall(key)
    except (ConnectionError, TimeoutError, OSError, aioredis.RedisError) as exc:
        log.warning("redis.cache_hgetall_failed", key=key, error=str(exc))
        return {}
