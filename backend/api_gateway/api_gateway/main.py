"""API Gateway – FastAPI application entry-point."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from shared.auth.kotak import KotakAuthManager
from shared.health import router as health_router
from shared.logging import setup_logging

from api_gateway.config import settings
from api_gateway.routers import analytics, auth, historical, market_data, orders
from api_gateway.websockets import handlers as ws_handlers
from api_gateway.websockets.fan_out import start_fan_out
from api_gateway.websockets.manager import ConnectionManager

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging(settings.service_name)
    log.info("api_gateway.startup", service=settings.service_name)

    # Expose settings on app.state for routers
    app.state.settings = settings

    # Shared httpx client for proxying to backend services
    app.state.http_client = httpx.AsyncClient(timeout=30.0)

    # Shared WebSocket connection manager
    manager = ConnectionManager()
    ws_handlers.manager = manager

    # Start Redis → WebSocket fan-out background task
    fan_out_task = asyncio.create_task(
        start_fan_out(manager, settings.redis_url)
    )

    # Cache static instrument data (lot sizes, underlyings) to Redis once
    from shared.instruments import cache_instruments_to_redis
    await cache_instruments_to_redis(settings.redis_url)

    # Init Kotak auth manager
    kotak_auth: KotakAuthManager | None = None
    if settings.kotak_consumer_key:
        kotak_auth = KotakAuthManager(
            consumer_key=settings.kotak_consumer_key,
            environment=settings.kotak_environment,
        )
        log.info("api_gateway.kotak_auth_ready", env=settings.kotak_environment)
    app.state.kotak_auth = kotak_auth

    yield

    fan_out_task.cancel()
    if kotak_auth is not None:
        await kotak_auth.close()
    await app.state.http_client.aclose()
    log.info("api_gateway.shutdown")


app = FastAPI(
    title="TD-Desk API Gateway",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(health_router)
app.include_router(market_data.router)
app.include_router(analytics.router)
app.include_router(orders.router)
app.include_router(historical.router)
app.include_router(auth.router)

# WebSocket
app.include_router(ws_handlers.router)
