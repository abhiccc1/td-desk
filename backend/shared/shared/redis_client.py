"""Async Redis connection factory with Pub/Sub helpers."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import redis.asyncio as aioredis

from shared.schemas.events import RedisEvent


_pool: aioredis.ConnectionPool | None = None


def get_pool(redis_url: str) -> aioredis.ConnectionPool:
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(redis_url, decode_responses=True)
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


async def cache_set(redis_url: str, key: str, value: str, ttl: int = 30) -> None:
    async with get_redis(redis_url) as client:
        await client.set(key, value, ex=ttl)


async def cache_get(redis_url: str, key: str) -> str | None:
    async with get_redis(redis_url) as client:
        return await client.get(key)


async def cache_hset(redis_url: str, key: str, mapping: dict, ttl: int = 30) -> None:
    async with get_redis(redis_url) as client:
        pipe = client.pipeline()
        pipe.hset(key, mapping=mapping)
        pipe.expire(key, ttl)
        await pipe.execute()


async def cache_hgetall(redis_url: str, key: str) -> dict:
    async with get_redis(redis_url) as client:
        return await client.hgetall(key)
