"""Shared health check router for all FastAPI services."""

import redis.asyncio as aioredis
from fastapi import APIRouter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    return {"status": "ok"}


async def check_redis(redis_url: str) -> bool:
    try:
        client = aioredis.from_url(redis_url)
        await client.ping()
        await client.aclose()
        return True
    except Exception:
        return False


async def check_db(engine: AsyncEngine) -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
