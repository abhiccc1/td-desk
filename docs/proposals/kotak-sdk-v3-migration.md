# Kotak Neo SDK migration: `Kotak-neo-api-v2@v2.0.1` → `kotakneoapi` v3.0.x

Target: replace `neo_api_client @ git+.../Kotak-neo-api-v2.git@v2.0.1` with the
PyPI package `kotakneoapi` (same import name, `neo_api_client`), from
<https://github.com/Kotak-Neo/kotak-neo-python>.

Sources read: `docs/guides/{MIGRATION,README,websocket,sync-integration,logging}.md`,
`docs/installation/macos.md`, `docs/postman/README.md`, and the v3 source
(`neo_api_client/neo_api.py`, `utils/neo_utility.py`, `websocket/feed/client.py`,
`services/order.py`).

---

## 1. Scanner pass (`docs/scripts/migrate_from_v2.py`)

Run as instructed, before any hand analysis:

```bash
python docs/scripts/migrate_from_v2.py /Users/achauhan/td-desk
```

Result: **34 errors, 20 warnings across 5109 files**. After triage, **exactly two
findings are real**, and both are in first-party code.

### 1.1 True positives

| Finding | Location | Severity |
|---|---|---|
| `modify_order(...)` passes `exchange_segment`, `instrument_token`, `product`, `trading_symbol`, `transaction_type` — all removed in v3 | [orders.py:844](../../backend/api_gateway/api_gateway/routers/orders.py#L844) | **Breaks at runtime** (`TypeError`) |
| PyPI package name change `neo-api-client` → `kotakneoapi` | [pyproject.toml:20](../../backend/api_gateway/pyproject.toml#L20) | Packaging |

### 1.2 False positives — do not act on these

The scanner matches any call named `.subscribe(` and any assignment to
`self.on_error`/`on_message`/`on_open`/`on_close`, with no check that the
receiver is a Kotak object. Every remaining finding is one of:

- **Redis pub/sub** — [session_watcher.py:301,450,486](../../backend/market_data_service/market_data_service/session_watcher.py#L301),
  [position_subscriber.py:65](../../backend/market_data_service/market_data_service/position_subscriber.py#L65),
  [session_broker/main.py:45](../../backend/session_broker/session_broker/main.py#L45),
  [redis_client.py:61,85](../../backend/shared/shared/redis_client.py#L61),
  [session_client.py:170](../../backend/shared/shared/session_client.py#L170).
- **Our own WS fan-out manager** — [handlers.py:96](../../backend/api_gateway/api_gateway/websockets/handlers.py#L96) (`manager.subscribe(ws, topics)`).
- **Our own broker abstraction** — [executor.py:78](../../backend/order_service/order_service/executor.py#L78) (`broker.place_order(order)`, a `KotakBroker` protocol method, not the SDK's).
- **Third-party library internals** under `.venv/`, `backend/shared/.venv/` — `redis`, `starlette`, `websocket-client`.
- The vendored SDK's own `on_error` assignments (see §2.1).

Scope the scan to first-party packages to keep it usable as a CI gate:

```bash
python docs/scripts/migrate_from_v2.py \
  backend/api_gateway/api_gateway backend/market_data_service/market_data_service \
  backend/order_service/order_service backend/shared/shared backend/session_broker/session_broker
```

Even scoped, the Redis/manager hits remain. **Do not wire this into CI as a
blocking gate** — it is a one-shot triage aid here. [Certain]

---

## 2. What the scanner missed

The scanner's blind spots matter more than its findings on this codebase,
because our Kotak integration is mostly *hand-rolled* rather than SDK-based.

### 2.1 The vendored SDK copy — the largest item, entirely invisible to the scanner

[`backend/market_data_service/.../connectors/kotak_sdk/`](../../backend/market_data_service/market_data_service/connectors/kotak_sdk/)
is a **1,590-line vendored copy of the v2 `HSWebSocketLib`** binary-feed
decoder, imported as `from market_data_service.connectors.kotak_sdk import HSWebSocket`.
The scanner only knows about `neo_api_client`, so it treated this as ordinary
application code (it flagged two `self.on_error` lines inside it as if *we* had
written callback code against the new SDK).

This is the real migration surface. It affects:

- [kotak_neo.py](../../backend/market_data_service/market_data_service/connectors/kotak_neo.py) — market feed connector (`HSWebSocket`, callbacks, daemon thread, tick queue)
- [subscription_manager.py](../../backend/market_data_service/market_data_service/subscription_manager.py) — channel allocation + LRU eviction
- [kotak_realtime.py](../../backend/market_data_service/market_data_service/connectors/kotak_realtime.py) — hand-rolled `wss://<base_url>/realtime` order feed

### 2.2 `place_order()` passes two removed parameters — missed because of `asyncio.to_thread`

[orders.py:516-533](../../backend/api_gateway/api_gateway/routers/orders.py#L516) calls:

```python
await asyncio.wait_for(asyncio.to_thread(
    neo_client.place_order,
    ..., market_protection="0", pf="N", ...
), timeout=30.0)
```

Both `market_protection` and `pf` were **removed** from v3's `place_order`
signature (confirmed against v3 `neo_api.py:205-218`); passing them raises
`TypeError`. The scanner's AST matcher only inspects direct `place_order(...)`
call nodes, so passing the bound method to `asyncio.to_thread` hides every
keyword from it. **Any SDK call dispatched through `to_thread` /
`run_in_executor` in this codebase is unscanned** — that is how we call the SDK
almost everywhere. [Certain]

### 2.3 `configuration.serverId` becomes a silent no-op

[orders.py:191-208](../../backend/api_gateway/api_gateway/routers/orders.py#L191) injects
session state into SDK internals, including:

```python
client.configuration.serverId = str(extra.get("server_id") or session.server_id or sid)
```

In v2, `NeoUtility.serverId` backs the `sId` query parameter on limits,
holdings, order history and order APIs. In v3, `NeoUtility` has **no `serverId`
attribute** — the assignment silently creates an unused one. No exception, no
warning. Needs verification against v3's `services/order.py` to confirm how `sId`
is now derived (it is not read from `configuration.serverId`). [Likely — the
attribute is definitively gone; what replaces it needs a live check]

The good news: `configuration` still exists and still carries
`bearer_token`, `edit_token`, `edit_sid`, `edit_rid`, `sid`, `base_url`, `ucc`,
`data_center`. **The token-injection approach survives v3** — only `serverId`
drops out. [Certain]

### 2.4 `create_websocket()` / `create_order_feed()` need fields we never populate

Because auth is hand-rolled ([shared/auth/kotak.py](../../backend/shared/shared/auth/kotak.py)
posts directly to `mis.kotaksecurities.com` with `httpx`), we never call the
SDK's `totp_validate()`, so `configuration.data_center`,
`sfeed_websocket_url`, `feed_url`, `order_feed_url`, `rt_url` and `ucc` are all
`None`. `create_order_feed()` falls back to a `data_center`→URL map and will
fail with no `url=` and no `base_url`. Pass `url=` explicitly, or construct
`SFeedWebSocket`/`OrderFeedWebSocket` directly — both accept
`access_token`/`sid`/`url`/`ucc` as plain constructor args, which fits our
architecture better than going through `NeoAPI`. [Certain]

### 2.5 Feed endpoint and protocol change

We connect to `wss://mlhsm.kotaksecurities.com` (legacy HSM binary feed). v3's
`SFeedWebSocket` targets `wss://sfeed.kotaksecurities.com/wsfeed` — a
**different endpoint with a different wire protocol**. This is not a drop-in
swap of the decoder; it is a different feed. Our tick parsing, `_capture_static`
and `TickData` mapping all sit downstream of it.

One thing that *does* line up: our subscription tokens are already
`f"{segment}|{token}"` ([subscription_manager.py:55](../../backend/market_data_service/market_data_service/subscription_manager.py#L55)),
which maps 1:1 onto `WsToken(segment, token)`. [Certain]

### 2.6 Channel model has no v3 equivalent

[subscription_manager.py](../../backend/market_data_service/market_data_service/subscription_manager.py)
allocates Kotak channels 3–15 at 100 tokens each (~1,300 option tokens) with LRU
eviction, plus channel 1 for index OHLC (`ifs`) and channel 2 for index touchline
(`mws`). v3 has **no channel concept at all** — just
`subscribe_scrips` / `subscribe_scrips_lite` / `subscribe_depth` /
`subscribe_full_depth` / `subscribe_index` / `subscribe_exchange`, each with a
matching `unsubscribe_*`, against a flat `max_subscriptions` budget (default
**3000**, configurable).

This is a simplification, not a loss: the code's own comment already notes
"channel numbers are only pause/resume groups", and we never pause or resume.
Mapping: `mws` → `subscribe_scrips`, `mwu` → `unsubscribe_scrips`, `ifs` →
`subscribe_index`. The LRU eviction machinery can shrink to a flat
subscription-count budget — and the budget roughly **doubles** (1,300 → 3,000).
[Certain]

### 2.7 Order-type / segment / product literals are built at runtime

The migration guide §3 rejects aliases (`"NSE"`, `"Limit"`, `"CO"`, `"GTC"`, …),
but the scanner only checks literal strings in the call. Ours come from request
bodies and instrument config ([orders.py:261-267](../../backend/api_gateway/api_gateway/routers/orders.py#L261)),
so they are unscanned. Spot checks look compliant — `"nse_fo"` default,
`order_type` documented as `"L"/"MKT"/"SL"/"SL-M"` — but **client-supplied
values reach the SDK unvalidated**, and v3 now rejects them rather than
forwarding. Needs an explicit allow-list at the API boundary. [Likely]

### 2.8 `price="0"` on limit orders

v3 rejects `price=0`/blank for `L` and `SL`. We pass `price=str(rl["price"])`
unconditionally. Any path that reaches `order_type="L"` with a zero or unset
price fails client-side now instead of reaching the exchange. Worth auditing —
this is a guardrail catching a real bug class, not an obstacle. [Likely]

### 2.9 Not affected

Most of our Kotak surface **does not touch the SDK** and needs no migration:
`totp_login`/`totp_validate` ([auth/kotak.py](../../backend/shared/shared/auth/kotak.py)),
`fetch_trade_report`, `fetch_kotak_positions` ([shared/positions.py](../../backend/shared/shared/positions.py)),
and `scrip_master` ([market_data_service/scrip_master.py](../../backend/market_data_service/market_data_service/scrip_master.py))
are all direct `httpx` calls. Only `api_gateway/routers/orders.py` uses `NeoAPI`.

Error handling is unchanged (guide §4): keep `if result.get("Error")` on
`place_order`/`modify_order`/`cancel_order` — **do not** convert these to
`try/except`. Our existing checks at
[orders.py:820,858](../../backend/api_gateway/api_gateway/routers/orders.py#L820) are correct as-is.

---

## 3. Migration plan

Five phases, each independently shippable and revertible. Phases 1–2 are a day;
phase 4 is the bulk of the work.

### Phase 0 — Environment (no code change)

1. Python 3.12.8 local, `python:3.12-slim` in all Dockerfiles — inside v3's
   supported `3.10–3.14`. No version bump needed.
2. `pip uninstall neo-api-client` **before** installing `kotakneoapi`. Both
   write to `site-packages/neo_api_client/`; pip cannot detect the conflict and
   will silently produce a half-overwritten package (guide §1.1). In Docker this
   is free — images rebuild clean. Locally, rebuild `.venv` from scratch.
3. No transitive pins to drop (`urllib3`/`certifi` are not pinned in any of our
   `pyproject.toml`s).
4. Rollback path: `pip install "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1#egg=neo_api_client"`,
   in a clean environment.

### Phase 1 — Dependency swap

- [api_gateway/pyproject.toml:20](../../backend/api_gateway/pyproject.toml#L20):
  `"neo_api_client @ git+...@v2.0.1"` → `"kotakneoapi>=3.0,<4"`.
- Imports stay `from neo_api_client import NeoAPI` — unchanged.
- Verify `scripts/export_pyproject_deps.py` emits the new requirement correctly
  into the Docker build.

### Phase 2 — Fix the REST order path (`api_gateway/routers/orders.py`)

Small, mechanical, and unblocks order flow on v3.

1. **`place_order`** ([L516](../../backend/api_gateway/api_gateway/routers/orders.py#L516)) — drop `market_protection="0"` and `pf="N"`. v3 always sends `mp="0"`; `pf` is gone with bracket/cover orders.
2. **`modify_order`** ([L844](../../backend/api_gateway/api_gateway/routers/orders.py#L844)) — drop `instrument_token`, `exchange_segment`, `product`, `trading_symbol`, `transaction_type`. Keep `order_id`, `price`, `order_type`, `quantity`, `validity`, `trigger_price`, `disclosed_quantity`. `ModifyOrderRequest` keeps these fields for the quantity-from-lots lookup and `_segment_for_trading_symbol`, so only the SDK call changes.
3. **`_get_neo_client`** ([L191](../../backend/api_gateway/api_gateway/routers/orders.py#L191)) — remove the `configuration.serverId` line; confirm against a live `limits()`/`order_report()` call that `sId` is still sent correctly without it. Set `configuration.ucc` and `configuration.data_center` while we're here (phase 4 needs them). Keep the existing `asyncio.to_thread` + `wait_for` wrapper; v3's constructor still does I/O.
4. **Input validation** (§2.7) — add an allow-list at the Pydantic boundary: `exchange_segment ∈ {nse_cm, bse_cm, nse_fo, bse_fo, mcx_fo}`, `order_type ∈ {L, MKT, SL, SL-M}`, `product ∈ {CNC, NRML, MIS, MTF}`, `validity ∈ {DAY, IOC}`. Returns a clean 400 instead of an opaque `{"Error": ApiValueError(...)}`.
5. **Price guard** (§2.8) — reject `price <= 0` when `order_type in {"L","SL"}` at the boundary.
6. Update [test_place_orders.py](../../backend/api_gateway/tests/test_place_orders.py) mocks — they assert on kwargs that no longer exist.

Exit check: place / modify / cancel against `environment="uat"` before prod.

### Phase 3 — Order & position feed → `create_order_feed()`

[kotak_realtime.py](../../backend/market_data_service/market_data_service/connectors/kotak_realtime.py)
hand-rolls `websocket-client` against `wss://<base_url>/realtime` with the raw
`{type:cn,Authorization:...,Sid:...,src:WEB}` handshake — exactly what v3's
`OrderFeedWebSocket` does (confirmed in the Postman reference). Replace with:

```python
async with client.create_order_feed(url=f"wss://{base_url}/realtime") as feed:
    async for msg in feed:
        if isinstance(msg, OrderUpdate):   ...
        elif isinstance(msg, PositionUpdate): ...
```

The `url=` is required (§2.4). Because `market_data_service` is already
asyncio-native, this **deletes** the daemon thread, `threading.Event` handshake,
and `run_coroutine_threadsafe` bridging in `_run_ws`. The
[sync-integration guide](https://github.com/Kotak-Neo/kotak-neo-python/blob/main/docs/guides/sync-integration.md)
bridge pattern is **not** needed here — it exists for gunicorn-sync/Celery apps.

Keep `_dispatch_order_event` / `_fetch_and_publish_positions` intact; only the
transport and message-typing layer changes (dicts → `OrderUpdate.data.*`).

### Phase 4 — Market feed → `SFeedWebSocket` (the real work)

Biggest and riskiest phase; do it last and behind a flag.

1. **Construct the feed directly**, not via `NeoAPI` — our auth never populates
   the SDK's session:
   ```python
   SFeedWebSocket(access_token=jwt, sid=sid, ucc=ucc,
                  url="wss://sfeed.kotaksecurities.com/wsfeed",
                  max_subscriptions=3000)
   ```
2. **Rewrite [kotak_neo.py](../../backend/market_data_service/market_data_service/connectors/kotak_neo.py)**
   as an async consumer: `async for message in ws` replaces the callback +
   `queue` + daemon-thread bridge. `stream()` already returns an
   `AsyncGenerator[TickData]` — that contract is preserved; everything
   downstream (publisher, snapshot, fan-out) is untouched.
3. **Remap the subscription model** (§2.6) in
   [subscription_manager.py](../../backend/market_data_service/market_data_service/subscription_manager.py):
   - `subscribe_channel(tokens, ch)` → `ws.subscribe_scrips([WsToken(seg, tok), ...])`
   - `unsubscribe_channel(...)`      → `ws.unsubscribe_scrips(...)`
   - `subscribe_index_channel(...)`  → `ws.subscribe_index(...)`
   - Replace channel allocation / `_evict_one_channel` with an LRU over a flat
     `ws.subscription_count` budget against `max_subscriptions`. Batching into
     100s is no longer needed — v3 sends one batched frame.
4. **Rewrite tick mapping.** `SFeedScrip` / `SFeedScripLite` / `SFeedIndex`
   carry named, **pre-scaled** attributes (`last_traded_price`, …) plus
   `trading_symbol`, replacing the 2-letter dict keys from the vendored decoder.
   This touches `_enqueue_tick` and `_capture_static`.

   > **Correction to an earlier draft of this plan:** this was flagged as a
   > double-scaling risk. It isn't. The vendored decoder *also* divided by
   > `multiplier * precisionValue` before handing values up
   > (`kotak_sdk/__init__.py:436,767`), so `_enqueue_tick` already received
   > scaled prices and applied no divisor of its own. v3 and the vendored
   > decoder agree; the mapping is a pure field rename. [Certain]
5. **Delete `connectors/kotak_sdk/`** (1,590 lines) and drop `websocket-client`
   from [market_data_service/pyproject.toml](../../backend/market_data_service/pyproject.toml)
   if nothing else uses it.
6. Add `kotakneoapi` to `market_data_service`'s dependencies — it does not
   currently depend on the SDK at all.
7. **Verify the MIDCPNIFTY spot workaround still holds.** SFeed is a different
   feed; re-test whether token 26074 now disseminates, before deciding to keep
   the parity fallback in `snapshot.py`.

### Phase 5 — Cleanup and hardening

- Wire up `setup_logging(...)` ([logging guide](https://github.com/Kotak-Neo/kotak-neo-python/blob/main/docs/guides/logging.md)) — v3 logs structurally instead of printing to stdout, and enables a **rotating log file by default**. Point it somewhere sane or disable it in containers.
- Wrap WebSocket connect/subscribe in the typed hierarchy (`AuthenticationError`, `ConnectionError`, `SubscriptionError`); leave REST calls on `{"Error": ...}` dict checks.
- v3 retries the initial connect `max_connect_retries` times (default 3) before raising — reconcile with our own retry loops in `session_watcher` so they don't compound into minutes of backoff.
- Consider `whatsmyip()` for IP-whitelist diagnostics.
- Import the [Postman collection](https://github.com/Kotak-Neo/kotak-neo-python/tree/main/docs/postman) for out-of-band endpoint verification during phase 2 — it mirrors the exact `jData` wire format the SDK sends, which makes "is this the SDK or the backend?" answerable in seconds.

---

## 4. Risk summary

| Risk | Phase | Mitigation |
|---|---|---|
| ~~Double-scaled prices~~ — retracted, both decoders pre-scale | 4 | No action needed |
| SFeed is a different endpoint/protocol, not a decoder swap | 4 | Verified live: connect + subscribe + typed ticks all work |
| `serverId` removal silently breaks `sId`-dependent endpoints | 2 | Live-verify `limits()` / `order_report()` on UAT |
| `environment` now defaults to `"prod"` | 1 | We pass it explicitly — no exposure |
| Positional `NeoAPI(...)` silent breakage | 1 | We already use keywords — no exposure |
| Client-supplied order literals rejected by v3 | 2 | Boundary allow-list |

## 5. Explicitly out of scope

Auth, trade report, positions and scrip master are hand-rolled `httpx` and stay
that way. Consolidating them onto the SDK is a separate decision — it would cut
code but couple our auth lifecycle to the SDK's session object, which is
precisely what the current design avoids.

---

## 6. As implemented (2026-10-06)

All five phases are applied. Changes beyond the original plan are marked **[new]**.

### Dependencies
- `api_gateway/pyproject.toml`: `neo_api_client @ git+…@v2.0.1` → `kotakneoapi>=3.0,<4`.
- `market_data_service/pyproject.toml`: **[new]** gained `kotakneoapi>=3.0,<4`; dropped
  `websocket-client` (only the deleted vendored decoder and the old realtime
  connector used it).
- **[new]** `shared/pyproject.toml`: `sqlalchemy>=2.0` → `sqlalchemy[asyncio]>=2.0`.
  `shared/health.py` imports `sqlalchemy.ext.asyncio`, which needs `greenlet` at
  import time. That was arriving transitively through the old SDK's dependency
  tree; without it the gateway crashed on boot with
  *"The SQLAlchemy asyncio module requires that the Python 'greenlet' library is
  installed"*. A latent packaging bug the old SDK was masking — unrelated to the
  SDK's own API, and invisible to the scanner.
- **[new]** `api_gateway/Dockerfile`: dropped the `apt-get install git` layer,
  which existed only to pip-install the SDK from GitHub.
- Transitive bumps pulled in by `kotakneoapi`: `websockets` 8.1→17.2,
  `pyjwt` 2.6→2.15, plus new `pyotp`, `python-decouple`, `tenacity`. No code
  uses the `websockets` or `jwt` APIs directly (the gateway runs uvicorn with
  `--ws wsproto`), so no fallout.

### REST order path — `api_gateway/routers/orders.py`
- `place_order()`: dropped `market_protection="0"` and `pf="N"` (removed in v3).
- `modify_order()`: dropped `instrument_token`, `exchange_segment`, `product`,
  `trading_symbol`, `transaction_type`.
- `_get_neo_client()`: removed the `configuration.serverId` assignment —
  confirmed against the v3 source that **no service reads it and `sId` is no
  longer sent at all**, so the line was a silent no-op. Now also sets
  `configuration.ucc` / `data_center`.
- **[new]** Boundary validation: `_VALID_SEGMENTS` / `_VALID_ORDER_TYPES` /
  `_VALID_PRODUCTS` / `_VALID_VALIDITIES` as Pydantic validators on
  `PlaceOrderLeg` and `ModifyOrderRequest`, plus a `price > 0` guard for `L`/`SL`.
  Bad values now 422 at the edge instead of returning a successful-looking
  response with an opaque `{"Error": ApiValueError(...)}` leg.
- **[new]** The server-derived `exchange_segment` (from `instruments.json`) is
  checked against the same allow-list, failing that leg by name rather than the
  whole batch.
- `margin_required()`'s stricter alias rules do **not** apply: margin preview is a
  direct `httpx` POST to `/quick/user/check-margin`, not an SDK call.

### Order & position feed — `connectors/kotak_realtime.py`
- `websocket-client` + daemon thread + `threading.Timer` → `OrderFeedWebSocket`
  on the service's own loop; `run_coroutine_threadsafe` calls became
  `create_task`, which is what they had to become once the caller was already on
  the loop (the old form would have been wrong, not just redundant).
- **[new]** Fire-and-forget publishes/fetches are held in a `_bg_tasks` set.
  asyncio only keeps a weak reference to a running task, so the previous
  thread-based dispatch had no equivalent exposure; without this, position
  refreshes could be garbage-collected mid-flight.
- **[new]** `filled_quantity` fallback. The SDK maps it from `fldQty`; this code
  previously read `fQty`. Rather than assume either is right, both are read
  (`OrderData` is `extra="allow"`, so unmapped wire fields survive on
  `model_extra`). If only `fQty` is on the wire, the SDK's field is `None` and a
  partial fill would otherwise be reported as a complete one.
- `rejRsn` is not a named `OrderData` field; it is read from `model_extra`.

### Market feed — `connectors/kotak_neo.py`
- Rewritten on `SFeedWebSocket`; **`connectors/kotak_sdk/` (1,590 lines) deleted**.
- **[new] The connector's public surface is unchanged on purpose** —
  `subscribe_channel(tokens, channel)` / `unsubscribe_channel` /
  `subscribe_index_channel` / `stream()` / `generation` / `last_tick_mono` /
  `get_static_data()` all behave as before, so `subscription_manager.py` and
  `session_watcher.py` needed **zero changes**. The `channel` argument is
  accepted and ignored: v3 addresses subscriptions by token, and the LRU budget
  the channel count drives still governs how many scrips stay subscribed. This
  deliberately avoids rewriting the eviction logic in the same change as the
  transport.
- `mws` → `subscribe_scrips`, `mwu` → `unsubscribe_scrips`, `ifs` →
  `subscribe_index`. Tokens were already `"seg|token"`, which maps directly to
  `WsToken(seg, token)`.
- Feed URL is imported from the SDK (`SFEED_WEBSOCKET_URL`), not hardcoded:
  **[new]** the guide documents `wss://sfeed.kotaksecurities.com/wsfeed` but the
  shipped default is `/apifeed`. The SDK's own value is the one its protocol
  handling is written against.
- `max_subscriptions=3000`, comfortably above the ~1,300 the LRU holds.

### Live verification performed
- `kotakneoapi==3.0.8` installed; both Docker images build and all services
  report healthy; `GET /health` → `{"status":"ok"}`.
- Connected to the **real** `wss://sfeed.kotaksecurities.com/apifeed`, subscribed,
  and received live typed ticks (`SFeedScrip` TCS-EQ @ 2096.4) during market hours.
- **[new]** Unauthenticated sessions are accepted at connect *and* ACK the
  subscribe frame, then are dropped a few seconds later. Connectivity tests that
  skip auth will look like they pass — don't treat a clean connect as proof the
  feed works.
- Test suites: api_gateway 60 passed, market_data_service 35 passed,
  quant_service 2 passed. Remaining failures elsewhere are pre-existing and
  unrelated (an `order_service` Redis-URL assertion and a `shared` regime-tag
  assertion).
- **[new]** `test_place_orders.py`'s `_PatchCtx` now also mocks
  `_load_kotak_session`. Uncommitted WIP had added a post-placement call to it
  that the helper didn't stub, so four tests 401'd. Pre-existing, not caused by
  the migration.

### Open item for the live session
`SubscriptionManager.subscribe_indices()` subscribes index tokens through
**both** `subscribe_scrips` (for LTP) and `subscribe_index` (for OHLC), which is
what the old `mws` + `ifs` pair did. In v3 a single `SFeedIndex` message already
carries LTP *and* OHLC, so the scrips half is probably redundant and doubles the
subscription budget those tokens consume. Unauthenticated probing returned
`SFeedScripLite` with `ltp=0.0` for index tokens and no `SFeedIndex` at all,
which is not conclusive. Left as-is deliberately — dropping a subscription that
turns out to be the one carrying spot prices would break every chain. Confirm
against a live session, then simplify.
