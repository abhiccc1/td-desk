"""Order service – FastAPI application entry-point."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

import structlog
from fastapi import FastAPI

from shared.health import router as health_router
from shared.logging import setup_logging
from shared.redis_client import subscribe

from order_service.config import settings
from order_service.router import router as orders_router

log = structlog.get_logger()


async def _command_listener() -> None:
    """Listen on ``orders:commands`` for incoming command messages."""
    async for channel, event in subscribe(settings.redis_url, ["orders:commands"]):
        log.info(
            "order_service.command_received",
            channel=channel,
            event_type=event.event_type,
            source_service=event.source_service,
        )
        # TODO: dispatch command (cancel basket, amend order, etc.)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging(settings.service_name)
    log.info("order_service.startup", service=settings.service_name)

    # Start background Redis command listener
    import asyncio

    task = asyncio.create_task(_command_listener())

    yield

    task.cancel()
    log.info("order_service.shutdown")


app = FastAPI(
    title="TD-Desk Order Service",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(orders_router)
