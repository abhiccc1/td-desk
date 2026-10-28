"""Event subscriber — listens on Redis channels and dispatches to indicators."""

import asyncio
from datetime import datetime, timezone

import structlog

from shared.redis_client import subscribe
from shared.schemas.events import EventType, RedisEvent

from quant_service.indicators.registry import get_indicators
from quant_service.publisher import ResultPublisher

log = structlog.get_logger()

# Channels to subscribe to (pattern-based)
SUBSCRIBE_PATTERNS: list[str] = [
    "ticks:raw:*",
    "ticks:chain:*",
    "ticks:position_chain:*",
]


def _parse_payload_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _payload_age_ms(payload: dict, field: str) -> int | None:
    dt = _parse_payload_timestamp(payload.get(field))
    if dt is None:
        return None
    return max(0, int((datetime.now(timezone.utc) - dt).total_seconds() * 1000))


class EventSubscriber:
    """Subscribe to Redis channels and fan-out events to registered indicators."""

    # Reconnect backoff bounds (seconds) for transient Redis/subscription failures.
    _INITIAL_BACKOFF_S = 1.0
    _MAX_BACKOFF_S = 30.0

    def __init__(
        self,
        redis_url: str,
        publisher: ResultPublisher,
    ) -> None:
        self._redis_url = redis_url
        self._publisher = publisher
        self._pending_chain_events: dict[tuple[str, str], RedisEvent] = {}
        self._chain_tasks: dict[tuple[str, str], asyncio.Task[None]] = {}

    async def run(self) -> None:
        """Main subscription loop — reconnects forever on transient Redis failures.

        Wraps the pub/sub subscription in a reconnect loop with exponential
        backoff so a dropped Redis connection (or any error surfacing from the
        subscription generator) is retried instead of crashing the service.
        CancelledError is re-raised so graceful shutdown still works.
        """
        log.info("subscriber.starting", patterns=SUBSCRIBE_PATTERNS)

        backoff = self._INITIAL_BACKOFF_S
        while True:
            try:
                async for channel, event in subscribe(
                    self._redis_url, SUBSCRIBE_PATTERNS, pattern=True
                ):
                    backoff = self._INITIAL_BACKOFF_S  # healthy message → reset backoff
                    try:
                        payload = event.payload if isinstance(event.payload, dict) else {}
                        log.debug(
                            "subscriber.received",
                            channel=channel,
                            event_type=event.event_type,
                            snapshot_age_ms=_payload_age_ms(payload, "sourceTimestamp"),
                            queue_age_ms=_payload_age_ms(payload, "timestamp"),
                        )

                        if event.event_type == EventType.CHAIN_SNAPSHOT:
                            self._enqueue_chain_snapshot(event)
                        else:
                            await self._dispatch(event)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        log.exception(
                            "subscriber.loop_error",
                            channel=channel,
                            event_type=event.event_type,
                        )
                        continue
            except asyncio.CancelledError:
                log.info("subscriber.cancelled")
                raise
            except Exception as exc:
                log.warning(
                    "subscriber.subscription_dropped",
                    error=str(exc),
                    error_type=type(exc).__name__,
                    retry_in_s=backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._MAX_BACKOFF_S)
                continue
            else:
                # subscribe() generator exhausted without error (e.g. unsubscribe).
                # Re-establish rather than exiting the service.
                log.warning("subscriber.subscription_ended", retry_in_s=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._MAX_BACKOFF_S)

    def _enqueue_chain_snapshot(self, event: RedisEvent) -> None:
        payload = event.payload
        underlying = payload.get("underlying", "")
        expiry = payload.get("expiry", "")
        if not underlying or not expiry:
            return

        key = (underlying, expiry)
        replaced = key in self._pending_chain_events
        self._pending_chain_events[key] = event

        task = self._chain_tasks.get(key)
        if task is None or task.done():
            self._chain_tasks[key] = asyncio.create_task(
                self._process_chain_snapshots(key),
            )
        elif replaced:
            log.debug(
                "subscriber.chain_snapshot_replaced",
                underlying=underlying,
                expiry=expiry,
            )

    async def _process_chain_snapshots(self, key: tuple[str, str]) -> None:
        try:
            while True:
                event = self._pending_chain_events.pop(key, None)
                if event is None:
                    return

                payload = event.payload if isinstance(event.payload, dict) else {}
                # debug, not info: fires once per snapshot, i.e. at the chain's
                # emit cadence (40/s at the active rate).
                log.debug(
                    "subscriber.chain_dispatch",
                    underlying=key[0],
                    expiry=key[1],
                    queue_age_ms=_payload_age_ms(payload, "timestamp"),
                    snapshot_age_ms=_payload_age_ms(payload, "sourceTimestamp"),
                )
                await self._dispatch(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception(
                "subscriber.chain_worker_error",
                underlying=key[0],
                expiry=key[1],
            )
        finally:
            self._chain_tasks.pop(key, None)

    @staticmethod
    def _requested_tiers(event: RedisEvent) -> frozenset[str] | None:
        """Analytics tiers the snapshot's consumers asked for.

        None (the field absent) means nobody stated a need, and every indicator
        runs — the same fail-toward-full rule as the snapshot cadence, so a
        missing signal can never silently starve a panel. An explicitly empty
        list is a real statement: the connected clients render quotes only (the
        mobile app), so no IV solve, SVI fit or model pricing is worth running.
        """
        payload = event.payload if isinstance(event.payload, dict) else {}
        tiers = payload.get("analytics")
        if not isinstance(tiers, list):
            return None
        return frozenset(tier for tier in tiers if isinstance(tier, str))

    async def _dispatch(self, event: RedisEvent) -> None:
        """Look up matching indicators and publish results as each finishes."""
        tiers = self._requested_tiers(event)
        indicators = get_indicators(event.event_type, tiers)

        if not indicators:
            log.debug(
                "subscriber.no_indicators",
                event_type=event.event_type,
                tiers=sorted(tiers) if tiers is not None else None,
            )
            return

        log.debug(
            "subscriber.dispatching",
            event_type=event.event_type,
            indicator_count=len(indicators),
        )

        async def _run_indicator(indicator):
            return type(indicator).__name__, await indicator.compute(event)

        tasks = [asyncio.create_task(_run_indicator(indicator)) for indicator in indicators]

        try:
            for task in asyncio.as_completed(tasks):
                try:
                    indicator_name, result = await task
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.error(
                        "subscriber.indicator_error",
                        event_type=event.event_type,
                        error=str(exc),
                        exc_info=exc,
                    )
                    continue

                for result_event in result:
                    try:
                        await self._publisher.publish(result_event)
                    except Exception:
                        log.exception(
                            "subscriber.publish_error",
                            indicator=indicator_name,
                            event_type=result_event.event_type,
                        )
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
