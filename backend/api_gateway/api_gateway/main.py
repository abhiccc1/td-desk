"""API Gateway – FastAPI application entry-point."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from shared.accounts import load_accounts
from shared.health import router as health_router
from shared.live_session import clear_live_kotak_credentials, get_active_ucc, get_live_kotak_credentials
from shared.logging import setup_logging

from api_gateway.config import settings
from api_gateway.routers import analytics, auth, historical, market_data, orders, paper_trading
from api_gateway.websockets import handlers as ws_handlers
from api_gateway.websockets.fan_out import start_fan_out
from api_gateway.websockets.manager import ConnectionManager

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging(settings.service_name)
    clear_live_kotak_credentials()

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

    # Periodic trade report poller — persists fills to trade_logs during market hours
    trade_poll_task = asyncio.create_task(
        _poll_trade_report()
    )

    # Cache static instrument data (lot sizes, underlyings) to Redis once
    from shared.instruments import cache_instruments_to_redis
    await cache_instruments_to_redis(settings.redis_url)

    # Ensure paper-trading tables exist on existing deployments (init.sql only
    # runs on a fresh DB volume). Isolated from live trading.
    from shared.paper_trading import ensure_paper_tables
    await ensure_paper_tables(settings.timescaledb_url)

    # Load broker account profiles, then tag any pre-multi-account trade history
    # with the sole configured account before anything queries it.
    accounts = load_accounts(
        settings.kotak_accounts,
        legacy_consumer_key=settings.kotak_consumer_key,
    )
    app.state.kotak_accounts = accounts

    from shared.migrations import ensure_trade_log_account_column
    await ensure_trade_log_account_column(
        settings.timescaledb_url, backfill_ucc=accounts.sole_ucc
    )

    # Auth managers are created per login attempt (one per account) and held
    # here only between the TOTP and MPIN steps — see routers/auth.py.
    app.state.kotak_auth_pending = {}

    yield

    trade_poll_task.cancel()
    fan_out_task.cancel()
    clear_live_kotak_credentials()
    for mgr in list(getattr(app.state, "kotak_auth_pending", {}).values()):
        await mgr.close()
    await app.state.http_client.aclose()


async def _poll_trade_report() -> None:
    """Periodically fetch today's trade fills from Kotak and persist to trade_logs.

    Runs every 60s during IST market hours (09:15–15:35; 09:00–23:59 when MCX
    underlyings are enabled), plus one final sweep at close to capture closing
    auction fills. Ensures no fill is lost even if
    the UI isn't open when a limit order executes.
    """
    from datetime import datetime, timedelta, timezone

    from shared.positions import fetch_trade_report
    from shared.schemas.auth import SessionState
    from shared.session_client import get_session
    from shared.trade_logger import persist_trade_fills

    from shared.instruments import get_instrument_master

    IST = timezone(timedelta(hours=5, minutes=30))
    MARKET_OPEN_H, MARKET_OPEN_M = 9, 15
    MARKET_CLOSE_H, MARKET_CLOSE_M = 15, 35
    im = get_instrument_master()
    if any(
        (cfg := im.get(name)) is not None and cfg.asset_class == "commodity"
        for name in im.tracked_names()
    ):
        # MCX trades 09:00 to 23:30/23:55 IST (US-DST dependent)
        MARKET_OPEN_H, MARKET_OPEN_M = 9, 0
        MARKET_CLOSE_H, MARKET_CLOSE_M = 23, 59
    POLL_INTERVAL = 60  # seconds

    await asyncio.sleep(10)  # let other services settle on startup

    while True:
        try:
            now = datetime.now(IST)
            hour, minute = now.hour, now.minute
            in_market = (
                (hour > MARKET_OPEN_H or (hour == MARKET_OPEN_H and minute >= MARKET_OPEN_M))
                and (hour < MARKET_CLOSE_H or (hour == MARKET_CLOSE_H and minute <= MARKET_CLOSE_M))
            )

            if not in_market:
                # Sleep until next market open
                next_open = now.replace(hour=MARKET_OPEN_H, minute=MARKET_OPEN_M, second=0, microsecond=0)
                if now >= next_open:
                    next_open += timedelta(days=1)
                wait = (next_open - now).total_seconds()
                log.debug("trade_poll.outside_hours", next_check=next_open.isoformat())
                await asyncio.sleep(min(wait, 3600))  # cap at 1h to re-check
                continue

            session = await get_session(settings.redis_url)
            live_creds = get_live_kotak_credentials()
            if (
                not session
                or session.state not in (SessionState.ACTIVE, SessionState.DEGRADED)
                or live_creds is None
            ):
                await asyncio.sleep(POLL_INTERVAL)
                continue

            access_token = live_creds.access_token.get_secret_value()
            sid = str(live_creds.extra.get("sid") or "")
            base_url = str(live_creds.extra.get("base_url") or session.base_url or "")
            if not access_token or not sid or not base_url:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            if not base_url.startswith("http"):
                base_url = f"https://{base_url}"
            base_url = base_url.rstrip("/")

            raw = await fetch_trade_report(base_url, access_token, sid)
            if raw:
                count = await persist_trade_fills(
                    settings.timescaledb_url, raw, get_active_ucc()
                )
                if count > 0:
                    log.info("trade_poll.persisted", fills=count)

        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("trade_poll.error")

        await asyncio.sleep(POLL_INTERVAL)


app = FastAPI(
    title="TD-Desk API Gateway",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    # Allow any private LAN origin (e.g. http://192.168.x.x:3000) and the
    # td.desk hostname so the app can be reached from other devices.
    allow_origin_regex=r"^https?://((192\.168|10\.|172\.(1[6-9]|2\d|3[01]))[\d.]+|([\w-]+\.)?td\.desk)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(health_router)
app.include_router(market_data.router)
app.include_router(analytics.router)
app.include_router(orders.router)
app.include_router(paper_trading.router)
app.include_router(historical.router)
app.include_router(auth.router)

# WebSocket
app.include_router(ws_handlers.router)
