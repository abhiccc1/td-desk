"""Async SQLAlchemy engine factory for TimescaleDB."""

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_engine: AsyncEngine | None = None


def get_engine(db_url: str, pool_size: int = 10) -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            db_url,
            pool_size=pool_size,
            pool_pre_ping=True,
            echo=False,
        )
    return _engine


async def close_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None
