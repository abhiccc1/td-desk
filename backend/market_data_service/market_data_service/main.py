"""Market data service entry point."""

from __future__ import annotations

import asyncio
import signal

import structlog

from shared.logging import setup_logging
from shared.redis_client import get_redis
from shared.schemas.auth import BrokerCredentials

from market_data_service.config import MarketDataSettings
from market_data_service.connectors.kotak_neo import KotakNeoConnector
from market_data_service.publisher import TickPublisher
from market_data_service.snapshot import SnapshotAggregator

logger = structlog.get_logger()


async def _run_connector(
    connector: KotakNeoConnector,
    publisher: TickPublisher,
    aggregator: SnapshotAggregator,
) -> None:
    """Stream ticks from a single connector, feeding publisher and aggregator."""
    logger.info("starting connector stream", connector="KOTAK")
    async for tick in connector.stream():
        await publisher.publish_tick(tick)
        await aggregator.process_tick(tick)


async def _watch_kotak_auth(
    settings: MarketDataSettings,
    publisher: TickPublisher,
    aggregator: SnapshotAggregator,
) -> None:
    """Subscribe to Redis for Kotak auth events and lazily start the connector."""
    connector: KotakNeoConnector | None = None
    try:
        async with get_redis(settings.redis_url) as client:
            pubsub = client.pubsub()
            await pubsub.subscribe("auth:kotak:authenticated")
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue

                if connector is not None:
                    logger.info("kotak_neo connector already registered, skipping")
                    continue

                import json
                data = json.loads(message["data"])
                creds = BrokerCredentials(**data)

                # Download scrip master to get instrument tokens and expiry dates
                from shared.instruments import get_instrument_master
                from market_data_service.scrip_master import fetch_and_parse_scrip_master

                im = get_instrument_master()
                scrip = await fetch_and_parse_scrip_master(
                    creds, settings.redis_url,
                    consumer_key=settings.kotak_consumer_key,
                    instruments=im,
                )

                connector = KotakNeoConnector(settings, creds, spot_tokens=im.spot_tokens())
                connector.token_to_symbol = scrip.token_to_symbol
                logger.info("kotak_neo connector initialised via auth event")

                # Start streaming (no auto-subscribe — SubscriptionManager handles it)
                asyncio.create_task(
                    _run_connector(connector, publisher, aggregator)
                )

                # Set up on-demand subscription manager
                from market_data_service.subscription_manager import SubscriptionManager

                sub_mgr = SubscriptionManager(connector, scrip, instruments=im)

                # Subscribe to index spot prices after connection stabilises
                async def _init_indices():
                    await asyncio.sleep(2)
                    await sub_mgr.subscribe_indices()
                asyncio.create_task(_init_indices())

                # Listen for on-demand subscription requests from the API gateway
                asyncio.create_task(
                    _watch_subscribe_requests(settings, sub_mgr)
                )

                # Start Kotak realtime WS for order/position streaming
                from market_data_service.connectors.kotak_realtime import KotakRealtimeConnector

                realtime = KotakRealtimeConnector(creds, settings.redis_url)
                asyncio.create_task(realtime.start())

                # Periodically flush static OHLC data to Redis
                asyncio.create_task(
                    _flush_static_data(settings, connector)
                )
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("kotak auth watcher failed")


async def _flush_static_data(settings: MarketDataSettings, connector) -> None:
    """Periodically cache static OHLC data (open, prev close, high, low) to Redis."""
    import json
    from datetime import datetime, timezone
    from shared.redis_client import cache_set

    today_str = ""
    while True:
        await asyncio.sleep(5)
        try:
            now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            static = connector.get_static_data()
            if not static:
                continue

            # Cache per-symbol static data with date tag for invalidation
            for symbol, info in static.items():
                info["date"] = now_str
                key = f"cache:static:{symbol}"
                await cache_set(
                    settings.redis_url, key,
                    json.dumps(info),
                    ttl=86400,  # 24h — invalidated by date check
                )

            if now_str != today_str:
                today_str = now_str
                logger.info("static_data.flushed", symbols=len(static), date=now_str)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("static_data.flush_error")


async def _watch_subscribe_requests(
    settings: MarketDataSettings,
    sub_mgr,
) -> None:
    """Listen for on-demand subscription requests from the API gateway."""
    import json
    try:
        async with get_redis(settings.redis_url) as client:
            pubsub = client.pubsub()
            await pubsub.subscribe("subscribe:request")
            logger.info("subscribe_request.watcher_started")
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                    underlying = data["underlying"]
                    expiry = data["expiry"]
                    newly = await sub_mgr.ensure_subscribed(underlying, expiry)
                    if newly:
                        logger.info("subscribe_request.fulfilled", underlying=underlying, expiry=expiry)
                except (json.JSONDecodeError, KeyError):
                    logger.warning("subscribe_request.invalid")
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("subscribe_request.watcher_failed")


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

    await asyncio.gather(
        _watch_kotak_auth(settings, publisher, aggregator),
    )


if __name__ == "__main__":
    asyncio.run(main())
