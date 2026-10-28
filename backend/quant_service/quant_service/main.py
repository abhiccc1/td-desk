"""Quant service entry point."""

import asyncio

import structlog

from shared.logging import setup_logging

from quant_service.config import QuantSettings


async def _run() -> None:
    settings = QuantSettings()
    setup_logging(level=settings.log_level, service_name=settings.service_name)

    log = structlog.get_logger()
    log.info("quant_service.starting", environment=settings.environment)

    # Configure module-level settings before importing indicators
    from quant_service.indicators.greeks import set_risk_free_rate
    from quant_service.indicators.historical import set_db_url

    set_risk_free_rate(settings.risk_free_rate)
    set_db_url(settings.timescaledb_url)

    # Import indicators package to trigger registration
    import quant_service.indicators  # noqa: F401

    from quant_service.publisher import ResultPublisher
    from quant_service.subscriber import EventSubscriber

    publisher = ResultPublisher(redis_url=settings.redis_url)

    subscriber = EventSubscriber(
        redis_url=settings.redis_url,
        publisher=publisher,
    )

    log.info("quant_service.ready")

    try:
        await subscriber.run()
    except asyncio.CancelledError:
        log.info("quant_service.shutting_down")

    log.info("quant_service.stopped")


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
