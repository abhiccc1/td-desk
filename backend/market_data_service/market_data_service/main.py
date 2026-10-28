"""Market data service entry point."""

from __future__ import annotations

import asyncio
import signal

import structlog

from shared.logging import setup_logging

from market_data_service.config import MarketDataSettings
from market_data_service.publisher import TickPublisher
from market_data_service.session_watcher import SessionWatcher
from market_data_service.snapshot import SnapshotAggregator

logger = structlog.get_logger()


async def _run_scrip_master_download(settings: MarketDataSettings) -> bool:
    """Download and cache scrip master. Returns True on success."""
    from shared.instruments import get_instrument_master
    from shared.live_session import get_live_kotak_credentials

    from market_data_service.scrip_master import fetch_and_parse_scrip_master

    creds = get_live_kotak_credentials()
    if creds is None:
        logger.warning("scrip_master_cron.no_session", hint="Skipping — no live Kotak session")
        return False

    im = get_instrument_master()

    await fetch_and_parse_scrip_master(
        creds, settings.redis_url,
        consumer_key=str(creds.extra.get("consumer_key") or "") or settings.kotak_consumer_key,
        instruments=im,
    )
    logger.info("scrip_master_cron.refreshed")
    return True


async def _daily_scrip_master_refresh(settings: MarketDataSettings) -> None:
    """Re-download scrip master daily at 08:45 IST.

    On startup, checks if today's refresh has already run (via a Redis key).
    If not, triggers an immediate catch-up download before entering the
    daily schedule loop.
    """
    from datetime import datetime, timedelta, timezone
    from shared.redis_client import cache_get, cache_set

    IST = timezone(timedelta(hours=5, minutes=30))
    TARGET_HOUR, TARGET_MINUTE = 8, 45
    CRON_RAN_KEY = "cron:scrip_master:last_run_date"

    # --- Catch-up: if today's run was missed (e.g. service restarted after 08:45) ---
    now = datetime.now(IST)
    today_str = now.strftime("%Y-%m-%d")
    past_target = now.hour > TARGET_HOUR or (now.hour == TARGET_HOUR and now.minute >= TARGET_MINUTE)

    if past_target:
        last_run = await cache_get(settings.redis_url, CRON_RAN_KEY)
        if last_run != today_str:
            logger.info("scrip_master_cron.catchup", reason="missed today's scheduled run")
            try:
                if await _run_scrip_master_download(settings):
                    await cache_set(settings.redis_url, CRON_RAN_KEY, today_str, ttl=86400)
            except Exception:
                logger.exception("scrip_master_cron.catchup_failed")

    # --- Daily loop ---
    while True:
        try:
            now = datetime.now(IST)
            target = now.replace(hour=TARGET_HOUR, minute=TARGET_MINUTE, second=0, microsecond=0)
            if now >= target:
                target += timedelta(days=1)
            wait_seconds = (target - now).total_seconds()
            logger.info("scrip_master_cron.scheduled", next_run=target.isoformat(), wait_s=int(wait_seconds))
            await asyncio.sleep(wait_seconds)

            if await _run_scrip_master_download(settings):
                run_date = datetime.now(IST).strftime("%Y-%m-%d")
                await cache_set(settings.redis_url, CRON_RAN_KEY, run_date, ttl=86400)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("scrip_master_cron.failed")
            await asyncio.sleep(60)


async def _shutdown(loop: asyncio.AbstractEventLoop) -> None:
    """Cancel all running tasks for a clean shutdown."""
    logger.info("shutting down market data service")
    tasks = [t for t in asyncio.all_tasks(loop) if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    loop.stop()


async def main() -> None:
    """Set up components and run the Kotak-backed market-data pipeline."""
    settings = MarketDataSettings()
    setup_logging(level=settings.log_level, service_name=settings.service_name)

    logger.info(
        "market data service starting",
        environment=settings.environment,
        broker="KOTAK",
    )

    publisher = TickPublisher(settings)
    await publisher.start()
    aggregator = SnapshotAggregator(settings)

    # Register signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.ensure_future(_shutdown(loop)))

    watcher = SessionWatcher(settings, publisher, aggregator)
    await asyncio.gather(
        watcher.run(),
        _daily_scrip_master_refresh(settings),
    )


if __name__ == "__main__":
    asyncio.run(main())
