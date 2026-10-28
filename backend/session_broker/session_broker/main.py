"""Session broker — asyncio health check loop for Kotak session management.

Monitors the active session via periodic REST probes. After consecutive
failures, marks the session as DEGRADED (version bump triggers downstream
connector rebuilds). Auto-recovers when the API comes back.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import structlog

from shared.live_session import (
    clear_live_kotak_credentials,
    get_live_kotak_credentials,
    parse_live_kotak_credentials,
    set_live_kotak_credentials,
)
from shared.logging import setup_logging
from shared.schemas.auth import SessionState
from shared.session_client import (
    get_session,
    publish_session_status,
    store_session,
    update_health_check_timestamp,
)

from session_broker.config import SessionBrokerSettings
from session_broker.health_check import SessionHealth, health_check_session

logger = structlog.get_logger()


async def _watch_auth_events(redis_url: str) -> None:
    """Cache live credentials from API Gateway auth events."""
    import json

    from shared.redis_client import get_redis

    try:
        async with get_redis(redis_url) as client:
            pubsub = client.pubsub()
            await pubsub.subscribe("auth:kotak:authenticated")
            logger.info("session_broker.auth_watcher_started")
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    creds = parse_live_kotak_credentials(message["data"])
                    set_live_kotak_credentials(creds)
                    logger.info("session_broker.live_credentials_updated")
                except (ValueError, json.JSONDecodeError, TypeError):
                    logger.warning("session_broker.auth_event_invalid")
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("session_broker.auth_watcher_failed")


async def main() -> None:
    settings = SessionBrokerSettings()
    setup_logging(level=settings.log_level, service_name=settings.service_name)
    logger.info("session_broker.starting", interval=settings.health_check_interval)
    clear_live_kotak_credentials()

    consecutive_failures = 0
    auth_task = asyncio.create_task(_watch_auth_events(settings.redis_url))

    while True:
        try:
            session = await get_session(settings.redis_url)

            if not session or session.state in (
                SessionState.UNAUTHENTICATED,
                SessionState.EXPIRED,
            ):
                await asyncio.sleep(10)
                continue

            live_creds = get_live_kotak_credentials()
            if live_creds is None:
                await asyncio.sleep(10)
                continue

            health = await health_check_session(session, live_creds)

            if health == SessionHealth.ACTIVE:
                if consecutive_failures > 0:
                    logger.info(
                        "session_broker.recovered",
                        after_failures=consecutive_failures,
                        version=session.version,
                    )
                    consecutive_failures = 0
                    if session.state == SessionState.DEGRADED:
                        session.state = SessionState.ACTIVE
                        session.health_check_ok = True
                        await store_session(settings.redis_url, session)
                        await publish_session_status(
                            settings.redis_url, session.version, "active"
                        )
                else:
                    consecutive_failures = 0
            elif health == SessionHealth.EXPIRED:
                consecutive_failures = 0
                if session.state != SessionState.EXPIRED:
                    clear_live_kotak_credentials()
                    session.state = SessionState.EXPIRED
                    session.access_token = ""
                    session.sid = ""
                    session.health_check_ok = False
                    await store_session(settings.redis_url, session)
                    await publish_session_status(
                        settings.redis_url, session.version, "expired"
                    )
                    logger.error("session_broker.expired", version=session.version)
            else:
                consecutive_failures += 1
                logger.warning(
                    "session_broker.health_fail",
                    consecutive=consecutive_failures,
                    threshold=settings.health_check_failures_threshold,
                    version=session.version,
                )
                if (
                    consecutive_failures >= settings.health_check_failures_threshold
                    and session.state == SessionState.ACTIVE
                ):
                    session.state = SessionState.DEGRADED
                    session.health_check_ok = False
                    await store_session(settings.redis_url, session)
                    await publish_session_status(
                        settings.redis_url, session.version, "degraded"
                    )
                    logger.error(
                        "session_broker.degraded",
                        version=session.version,
                        consecutive=consecutive_failures,
                    )

            # Update health check timestamp without version bump
            session.last_health_check = datetime.now(timezone.utc).isoformat()
            await update_health_check_timestamp(settings.redis_url, session)

        except asyncio.CancelledError:
            auth_task.cancel()
            await asyncio.gather(auth_task, return_exceptions=True)
            return
        except Exception:
            logger.exception("session_broker.loop_error")

        await asyncio.sleep(settings.health_check_interval)


if __name__ == "__main__":
    asyncio.run(main())
