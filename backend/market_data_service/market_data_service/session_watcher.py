"""SessionWatcher — manages connector lifecycle in response to session version changes.

Replaces the fragile _watch_kotak_auth with a lifecycle-aware watcher that:
  - Bootstraps from Redis hash on startup (no pub/sub event needed)
  - Tears down and rebuilds connectors on credential rotation
  - Saves and replays subscriptions across rebuilds
  - Publishes session status events for the frontend
"""

from __future__ import annotations

import asyncio

import structlog

from shared.instruments import exchange_from_segment, get_instrument_master
from shared.live_session import (
    clear_live_kotak_credentials,
    get_live_kotak_credentials,
    parse_live_kotak_credentials,
    set_live_kotak_credentials,
)
from shared.schemas.auth import BrokerCredentials, SessionBundle, SessionState
from shared.session_client import (
    get_session,
    publish_session_status,
    watch_session_version,
)

from market_data_service.config import MarketDataSettings
from market_data_service.connectors.kotak_neo import KotakNeoConnector
from market_data_service.connectors.kotak_realtime import KotakRealtimeConnector
from market_data_service.position_subscriber import PositionSubscriber
from market_data_service.publisher import TickPublisher
from market_data_service.scrip_master import fetch_and_parse_scrip_master
from market_data_service.snapshot import SnapshotAggregator
from market_data_service.subscription_manager import SubscriptionManager

logger = structlog.get_logger()


class SessionWatcher:
    """Manages connector lifecycle in response to session version changes."""

    def __init__(
        self,
        settings: MarketDataSettings,
        publisher: TickPublisher,
        aggregator: SnapshotAggregator,
    ) -> None:
        self._settings = settings
        self._publisher = publisher
        self._aggregator = aggregator
        self._connector: KotakNeoConnector | None = None
        self._realtime: KotakRealtimeConnector | None = None
        self._sub_mgr: SubscriptionManager | None = None
        self._pos_sub: PositionSubscriber | None = None
        self._active_tasks: list[asyncio.Task] = []
        self._saved_subscriptions: dict[tuple[str, str], list[int]] = {}
        self._current_version: int = 0
        self._auth_task: asyncio.Task | None = None
        # (access_token, sid) the running connector was built with — used to
        # rebuild only on actual credential rotation, not on every session
        # version bump (health-status changes, credential republish, etc.)
        self._active_creds_key: tuple[str, str] | None = None

    async def run(self) -> None:
        """Main loop: bootstrap from Redis, then watch for version changes."""
        self._auth_task = asyncio.create_task(self._watch_auth_events())

        # Phase 1: Bootstrap — read session:kotak:current
        session = await get_session(self._settings.redis_url)
        if session and session.state in (SessionState.ACTIVE, SessionState.DEGRADED):
            creds = get_live_kotak_credentials()
            if creds is not None:
                logger.info(
                    "session_watcher.bootstrap",
                    version=session.version,
                    state=session.state,
                )
                await self._activate(session, creds)
            else:
                self._current_version = session.version
                logger.info(
                    "session_watcher.awaiting_live_credentials",
                    version=session.version,
                    state=session.state,
                )

        # Phase 2: Watch for version changes
        try:
            async for new_version in watch_session_version(self._settings.redis_url):
                if new_version <= self._current_version:
                    continue

                session = await get_session(self._settings.redis_url)
                if not session:
                    continue

                logger.info(
                    "session_watcher.version_change",
                    old_version=self._current_version,
                    new_version=new_version,
                    state=session.state,
                )

                if session.state in (SessionState.ACTIVE, SessionState.DEGRADED):
                    creds = get_live_kotak_credentials()
                    if creds is None:
                        self._current_version = session.version
                        logger.warning(
                            "session_watcher.no_live_credentials",
                            version=session.version,
                            state=session.state,
                        )
                        continue
                    if self._connector is None:
                        await self._activate(session, creds)
                    elif self._creds_key(creds) != self._active_creds_key:
                        # Credential rotation — full teardown + rebuild
                        await self._teardown()
                        await self._activate(session, creds)
                    else:
                        # Same credentials (e.g. session broker flipped the
                        # health status, or the gateway republished creds) —
                        # keep the healthy connector instead of rebuilding.
                        self._current_version = session.version
                        logger.info(
                            "session_watcher.version_change_same_credentials",
                            version=session.version,
                            state=session.state,
                        )
                elif session.state == SessionState.EXPIRED:
                    clear_live_kotak_credentials()
                    await self._teardown(status="expired")
        except asyncio.CancelledError:
            await self._teardown()
            if self._auth_task is not None:
                self._auth_task.cancel()
                await asyncio.gather(self._auth_task, return_exceptions=True)
                self._auth_task = None
            return

    @staticmethod
    def _creds_key(creds: BrokerCredentials) -> tuple[str, str]:
        return (creds.access_token.get_secret_value(), str(creds.extra.get("sid", "")))

    async def _activate(self, session: SessionBundle, creds: BrokerCredentials) -> None:
        """Create all connectors and start streaming."""
        self._current_version = session.version
        self._active_creds_key = self._creds_key(creds)

        # Download scrip master
        im = get_instrument_master()
        scrip = await fetch_and_parse_scrip_master(
            creds,
            self._settings.redis_url,
            # Key of the account that authenticated; env var is the legacy fallback.
            consumer_key=str(creds.extra.get("consumer_key") or "")
            or self._settings.kotak_consumer_key,
            instruments=im,
        )

        # Reset aggregator (flush stale partial snapshots)
        self._aggregator.reset()

        # Create connector
        self._connector = KotakNeoConnector(
            self._settings,
            creds,
            spot_tokens=im.spot_tokens(),
            index_names=im.index_names(),
        )
        self._connector.token_to_symbol = scrip.token_to_symbol
        token_exchange = {
            tok: exchange_from_segment(seg) for tok, seg in scrip.token_segment.items()
        }
        for name in im.spot_tokens():
            cfg = im.get(name)
            if cfg:
                token_exchange.setdefault(cfg.spot_token, cfg.exchange)
        self._connector.token_exchange = token_exchange
        self._aggregator.set_underlying_futures(scrip.underlying_future)
        logger.info("session_watcher.connector_initialised", version=session.version)

        # Start streaming
        stream_task = asyncio.create_task(
            self._run_connector(self._connector)
        )
        self._active_tasks.append(stream_task)

        # Set up subscription manager
        self._sub_mgr = SubscriptionManager(
            self._connector, scrip, instruments=im, aggregator=self._aggregator
        )

        # Subscribe indices after connection stabilises
        async def _init_indices():
            await asyncio.sleep(2)
            await self._sub_mgr.subscribe_indices()
        indices_task = asyncio.create_task(_init_indices())
        self._active_tasks.append(indices_task)

        # Watchdog: replay subscriptions after socket reconnects and stalls.
        # The SDK's auto-reconnect re-auths but loses every Kotak-side
        # subscription, so without this any drop silently kills the feed.
        freshness_task = asyncio.create_task(self._watch_feed_health())
        self._active_tasks.append(freshness_task)

        # Replay saved subscriptions from prior session
        if self._saved_subscriptions:
            logger.info(
                "session_watcher.replaying_subscriptions",
                count=len(self._saved_subscriptions),
            )
            for underlying, expiry in list(self._saved_subscriptions.keys()):
                await self._sub_mgr.ensure_subscribed(underlying, expiry)
            self._saved_subscriptions.clear()

        # Listen for on-demand subscription requests
        sub_req_task = asyncio.create_task(
            self._watch_subscribe_requests()
        )
        self._active_tasks.append(sub_req_task)
        unsub_req_task = asyncio.create_task(
            self._watch_unsubscribe_requests()
        )
        self._active_tasks.append(unsub_req_task)
        demand_req_task = asyncio.create_task(
            self._watch_demand_requests()
        )
        self._active_tasks.append(demand_req_task)

        # Start Kotak realtime WS for order/position streaming
        self._realtime = KotakRealtimeConnector(
            creds, self._settings.redis_url, db_url=self._settings.timescaledb_url
        )
        realtime_task = asyncio.create_task(self._realtime.start())
        self._active_tasks.append(realtime_task)

        # Start position token subscriber
        self._pos_sub = PositionSubscriber(
            self._connector,
            scrip,
            self._settings.redis_url,
            instruments=im,
            aggregator=self._aggregator,
            subscription_manager=self._sub_mgr,
        )
        pos_task = asyncio.create_task(self._pos_sub.start())
        self._active_tasks.append(pos_task)

        # Periodically flush static OHLC data
        static_task = asyncio.create_task(
            self._flush_static_data()
        )
        self._active_tasks.append(static_task)

        # Publish status for frontend
        await publish_session_status(
            self._settings.redis_url, session.version, "active"
        )

    async def _teardown(self, status: str = "reconnecting") -> None:
        """Save subscriptions, cancel tasks, disconnect connectors."""
        logger.info("session_watcher.teardown", version=self._current_version)

        # Save active subscriptions for replay
        if self._sub_mgr:
            self._saved_subscriptions = dict(self._sub_mgr._active)

        # Cancel all tasks
        for task in self._active_tasks:
            task.cancel()
        await asyncio.gather(*self._active_tasks, return_exceptions=True)
        self._active_tasks.clear()

        # Disconnect connectors
        if self._connector:
            await self._connector.disconnect()
            self._connector = None
        if self._realtime:
            self._realtime.stop()
            self._realtime = None

        self._sub_mgr = None
        self._pos_sub = None
        self._active_creds_key = None

        await publish_session_status(
            self._settings.redis_url, self._current_version, status
        )

    async def _watch_auth_events(self) -> None:
        """Cache live credentials from API Gateway auth events.

        Retries forever: a transient Redis failure (e.g. DNS not ready right
        after an engine restart) must not kill the watcher, or a later login
        event is silently missed and the service never activates.
        """
        import json
        from shared.redis_client import get_redis

        while True:
            try:
                async with get_redis(self._settings.redis_url) as client:
                    pubsub = client.pubsub()
                    await pubsub.subscribe("auth:kotak:authenticated")
                    logger.info("session_watcher.auth_watcher_started")
                    async for message in pubsub.listen():
                        if message["type"] != "message":
                            continue
                        try:
                            creds = parse_live_kotak_credentials(message["data"])
                            set_live_kotak_credentials(creds)
                            logger.info("session_watcher.live_credentials_updated")
                        except (ValueError, json.JSONDecodeError, TypeError):
                            logger.warning("session_watcher.auth_event_invalid")
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("session_watcher.auth_watcher_failed_retrying")
                await asyncio.sleep(5)

    async def _run_connector(self, connector: KotakNeoConnector) -> None:
        """Stream ticks from the connector, feeding publisher and aggregator."""
        logger.info("session_watcher.streaming")
        try:
            async for tick in connector.stream():
                await self._publisher.publish_tick(tick)
                await self._aggregator.process_tick(tick)
        except asyncio.CancelledError:
            return

    async def _watch_feed_health(self) -> None:
        """Detect socket reconnects/stalls and replay Kotak subscriptions.

        Three failure modes, all on the single multiplexed Kotak socket:

        1. **Reconnect** — websocket-client auto-reconnects and re-auths, but
           Kotak drops every subscription. Detected via the connector's
           ``generation`` counter (bumped in on_open); replay everything.
        2. **Full stall** — subscriptions exist but no tick of any kind while
           "connected" (missed close, or subscribe frames lost in transit).
           Replay everything, on a cooldown.
        3. **Index-only stall** — option ticks flow but the index feed went
           quiet (Kotak occasionally drops just the ifs stream). Re-issue the
           index subscription only.
        """
        import time

        CHECK_INTERVAL_S = 5.0
        INDEX_STALE_S = 20.0      # no index tick for this long ⇒ index stalled
        LINK_ALIVE_S = 10.0       # any tick within this window ⇒ socket is alive
        FULL_STALL_S = 30.0       # no tick at all for this long ⇒ replay all
        RESUB_COOLDOWN_S = 60.0   # cap full-replay frequency (off-hours are quiet too)
        INDEX_RESUB_COOLDOWN_S = 30.0

        # Grace period for the initial subscribe_indices (~2s) and first ticks.
        await asyncio.sleep(INDEX_STALE_S)
        last_full_resub_mono = 0.0
        last_index_resub_mono = 0.0
        # Baseline after the grace period — the initial connect already bumped
        # the generation, and its subscriptions were sent normally.
        last_generation = self._connector.generation if self._connector else 0
        try:
            while True:
                await asyncio.sleep(CHECK_INTERVAL_S)
                conn = self._connector
                if conn is None or self._sub_mgr is None:
                    continue

                now = time.monotonic()

                # 1. Socket reopened since we last looked → replay everything
                if conn.connected and conn.generation != last_generation:
                    logger.warning(
                        "session_watcher.socket_reconnected_replaying",
                        old_generation=last_generation,
                        new_generation=conn.generation,
                    )
                    last_generation = conn.generation
                    try:
                        await self._resubscribe_everything()
                        last_full_resub_mono = now
                    except Exception:
                        logger.exception("session_watcher.replay_failed")
                    continue

                if not conn.connected:
                    continue

                # Retry any subscribe frames dropped while the socket was down
                if self._sub_mgr.has_pending_sends:
                    try:
                        await self._sub_mgr.retry_pending()
                    except Exception:
                        logger.exception("session_watcher.retry_pending_failed")

                link_alive = conn.last_tick_mono > 0 and (now - conn.last_tick_mono) < LINK_ALIVE_S
                full_stall = (
                    conn.last_tick_mono > 0
                    and (now - conn.last_tick_mono) > FULL_STALL_S
                )

                # 2. Connected but totally silent → replay everything
                if full_stall and (now - last_full_resub_mono) > RESUB_COOLDOWN_S:
                    logger.warning(
                        "session_watcher.feed_stalled_replaying",
                        tick_age_s=round(now - conn.last_tick_mono, 1),
                    )
                    try:
                        await self._resubscribe_everything()
                        last_full_resub_mono = now
                    except Exception:
                        logger.exception("session_watcher.replay_failed")
                    continue

                # 3. Options flowing but index quiet → re-subscribe indices only
                index_stale = (
                    conn.last_index_tick_mono == 0.0
                    or (now - conn.last_index_tick_mono) > INDEX_STALE_S
                )
                if link_alive and index_stale and (now - last_index_resub_mono) > INDEX_RESUB_COOLDOWN_S:
                    logger.warning(
                        "session_watcher.index_feed_stalled_resubscribing",
                        index_age_s=(
                            round(now - conn.last_index_tick_mono, 1)
                            if conn.last_index_tick_mono
                            else None
                        ),
                    )
                    try:
                        await self._sub_mgr.subscribe_indices()
                        last_index_resub_mono = now
                    except Exception:
                        logger.exception("session_watcher.index_resubscribe_failed")
        except asyncio.CancelledError:
            return

    async def _resubscribe_everything(self) -> None:
        """Replay indices, all active chains, and position tokens."""
        if self._sub_mgr is not None:
            await self._sub_mgr.resubscribe_all()
        if self._pos_sub is not None:
            await self._pos_sub.resubscribe()

    async def _watch_subscribe_requests(self) -> None:
        """Listen for on-demand subscription requests from the API gateway."""
        import json
        from shared.redis_client import get_redis

        while True:
            try:
                async with get_redis(self._settings.redis_url) as client:
                    pubsub = client.pubsub()
                    await pubsub.subscribe("subscribe:request")
                    logger.info("session_watcher.subscribe_watcher_started")
                    async for message in pubsub.listen():
                        if message["type"] != "message":
                            continue
                        try:
                            data = json.loads(message["data"])
                            underlying = data["underlying"]
                            expiry = data["expiry"]
                            throttle_ms = data.get("throttleMs")
                            if self._sub_mgr:
                                newly = await self._sub_mgr.ensure_subscribed(
                                    underlying,
                                    expiry,
                                    throttle_ms=throttle_ms,
                                )
                                if newly:
                                    logger.info(
                                        "session_watcher.subscribe_fulfilled",
                                        underlying=underlying,
                                        expiry=expiry,
                                    )
                        except (json.JSONDecodeError, KeyError):
                            logger.warning("session_watcher.subscribe_invalid")
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("session_watcher.subscribe_watcher_failed_retrying")
                await asyncio.sleep(5)

    async def _watch_demand_requests(self) -> None:
        """Listen for UI demand-level changes and retune chain snapshot cadence.

        Separate from subscribe:request so a tab-hidden/idle transition retunes
        an existing chain instead of re-sending its broker subscribe frames.
        The UI re-asserts demand periodically, so a level lost to a restart on
        either side self-heals within one re-assert interval.
        """
        import json
        from shared.redis_client import get_redis

        while True:
            try:
                async with get_redis(self._settings.redis_url) as client:
                    pubsub = client.pubsub()
                    await pubsub.subscribe("demand:request")
                    logger.info("session_watcher.demand_watcher_started")
                    async for message in pubsub.listen():
                        if message["type"] != "message":
                            continue
                        try:
                            data = json.loads(message["data"])
                            underlying = data["underlying"]
                            expiry = data["expiry"]
                            throttle_ms = int(data["throttleMs"])
                            analytics = data.get("analytics")
                            if analytics is not None and not isinstance(analytics, list):
                                raise TypeError("analytics must be a list")
                        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                            logger.warning("session_watcher.demand_invalid")
                            continue

                        if self._sub_mgr:
                            self._sub_mgr.apply_demand(
                                underlying, expiry, throttle_ms, analytics
                            )
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("session_watcher.demand_watcher_failed_retrying")
                await asyncio.sleep(5)

    async def _watch_unsubscribe_requests(self) -> None:
        """Listen for UI unsubscription requests and stop chain snapshot emission."""
        import json
        from shared.redis_client import get_redis

        while True:
            try:
                async with get_redis(self._settings.redis_url) as client:
                    pubsub = client.pubsub()
                    await pubsub.subscribe("unsubscribe:request")
                    logger.info("session_watcher.unsubscribe_watcher_started")
                    async for message in pubsub.listen():
                        if message["type"] != "message":
                            continue
                        try:
                            data = json.loads(message["data"])
                            underlying = data["underlying"]
                            expiry = data["expiry"]
                            if self._sub_mgr:
                                self._sub_mgr.release_view(underlying, expiry)
                                logger.info(
                                    "session_watcher.unsubscribe_fulfilled",
                                    underlying=underlying,
                                    expiry=expiry,
                                )
                        except (json.JSONDecodeError, KeyError):
                            logger.warning("session_watcher.unsubscribe_invalid")
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("session_watcher.unsubscribe_watcher_failed_retrying")
                await asyncio.sleep(5)

    async def _flush_static_data(self) -> None:
        """Periodically cache static OHLC data to Redis."""
        import json
        from datetime import datetime, timezone
        from shared.redis_client import cache_set

        today_str = ""
        while True:
            await asyncio.sleep(5)
            try:
                if not self._connector:
                    continue
                now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                static = self._connector.get_static_data()
                if not static:
                    continue
                for symbol, info in static.items():
                    info["date"] = now_str
                    key = f"cache:static:{symbol}"
                    await cache_set(
                        self._settings.redis_url,
                        key,
                        json.dumps(info),
                        ttl=86400,
                    )
                if now_str != today_str:
                    today_str = now_str
                    logger.info(
                        "static_data.flushed",
                        symbols=len(static),
                        date=now_str,
                    )
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("static_data.flush_error")
