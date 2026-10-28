"""Kotak Neo API v2 authentication endpoints.

Two-step flow, scoped to a broker account profile:
  GET  /accounts      → selectable account profiles (no secrets)
  POST /totp-login    → step 1 (account + TOTP)
  POST /totp-validate → step 2 (MPIN → credentials stored + published)
  GET  /status        → current auth state
  GET  /session       → versioned session info from Redis

Account profiles live server-side in ``KOTAK_ACCOUNTS`` (see ``shared.accounts``)
so the consumer key never reaches the client; the UI only sends a profile id.
When no profiles are configured the legacy single-account path still works: the
consumer key comes from ``KOTAK_CONSUMER_KEY`` and the client supplies the
mobile number and UCC.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.accounts import AccountRegistry, KotakAccount
from shared.auth.kotak import KotakAuthManager
from shared.exceptions import AuthStateError, BrokerAuthError
from shared.live_session import clear_live_kotak_credentials, get_live_kotak_credentials, set_live_kotak_credentials
from shared.redis_client import get_redis
from shared.schemas.auth import AuthState, AuthStatusResponse, SessionBundle, SessionState
from shared.session_client import get_session, publish_session_status, store_session

log = structlog.get_logger()

router = APIRouter(prefix="/api/v1/auth/kotak", tags=["auth"])

_LEGACY_ACCOUNT_ID = "default"


class TOTPLoginRequest(BaseModel):
    totp: str
    account_id: str = ""
    # Only used when no server-side profiles are configured.
    mobile: str = ""
    ucc: str = ""


class TOTPValidateRequest(BaseModel):
    mpin: str
    account_id: str = ""


def _registry(request: Request) -> AccountRegistry:
    return getattr(request.app.state, "kotak_accounts", None) or AccountRegistry()


def _pending(request: Request) -> dict[str, KotakAuthManager]:
    store = getattr(request.app.state, "kotak_auth_pending", None)
    if store is None:
        store = {}
        request.app.state.kotak_auth_pending = store
    return store


def _resolve_account(request: Request, body: TOTPLoginRequest) -> KotakAccount:
    """Pick the account to authenticate as, or fall back to the legacy env key."""
    registry = _registry(request)
    if registry.accounts:
        if body.account_id:
            account = registry.get(body.account_id)
            if account is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Unknown account '{body.account_id}'. "
                           f"Configured: {', '.join(a.id for a in registry.accounts)}",
                )
        else:
            # Only safe to infer when there is one profile. With several,
            # defaulting would sign the caller into an account it never named.
            account = registry.sole
            if account is None:
                raise HTTPException(
                    status_code=400,
                    detail="account_id is required — "
                           f"{len(registry.accounts)} accounts configured: "
                           f"{', '.join(a.id for a in registry.accounts)}",
                )
        # A profile may omit mobile/UCC and let the client supply them.
        return account.model_copy(update={
            "mobile": account.mobile or body.mobile,
            "ucc": account.ucc or body.ucc,
        })

    settings = request.app.state.settings
    if not settings.kotak_consumer_key:
        raise HTTPException(
            status_code=503,
            detail="No Kotak accounts configured — set KOTAK_ACCOUNTS or KOTAK_CONSUMER_KEY",
        )
    if not body.mobile or not body.ucc:
        raise HTTPException(status_code=400, detail="Mobile number and UCC are required")
    return KotakAccount(
        id=_LEGACY_ACCOUNT_ID,
        label="Default",
        consumer_key=settings.kotak_consumer_key,
        mobile=body.mobile,
        ucc=body.ucc,
    )


def _build_bundle(creds_dict: dict) -> SessionBundle:
    extra = creds_dict.get("extra", {})
    return SessionBundle(
        state=SessionState.ACTIVE,
        access_token="",
        sid="",
        base_url=extra.get("base_url", ""),
        server_id=extra.get("server_id", ""),
        data_center=extra.get("data_center", ""),
        environment=extra.get("environment", "prod"),
        account_id=extra.get("account_id", ""),
        ucc=extra.get("ucc", ""),
        authenticated_at=datetime.now(timezone.utc).isoformat(),
    )


async def _publish(settings, creds_dict: dict, bundle: SessionBundle) -> None:
    async with get_redis(settings.redis_url) as client:
        await client.publish("auth:kotak:authenticated", json.dumps(creds_dict))
    await store_session(settings.redis_url, bundle)


@router.get("/accounts")
async def list_accounts(request: Request):
    """Selectable account profiles. Never includes the consumer key."""
    registry = _registry(request)
    settings = request.app.state.settings
    live = get_live_kotak_credentials()
    active_id = str(live.extra.get("account_id") or "") if live else ""

    if registry.accounts:
        return {
            "accounts": [a.public() for a in registry.accounts],
            "activeAccountId": active_id,
            "clientSuppliedIdentity": False,
        }

    # Legacy mode: the client still supplies mobile/UCC from its own settings.
    return {
        "accounts": [],
        "activeAccountId": active_id,
        "clientSuppliedIdentity": bool(settings.kotak_consumer_key),
    }


@router.post("/totp-login")
async def totp_login(body: TOTPLoginRequest, request: Request):
    account = _resolve_account(request, body)
    if not account.mobile or not account.ucc:
        raise HTTPException(
            status_code=400,
            detail=f"Account '{account.id}' is missing a mobile number or UCC",
        )

    pending = _pending(request)
    previous = pending.pop(account.id, None)
    if previous is not None:
        await previous.close()

    mgr = KotakAuthManager(
        consumer_key=account.consumer_key,
        environment=request.app.state.settings.kotak_environment,
        account_id=account.id,
        ucc=account.ucc,
    )
    try:
        result = await mgr.totp_login(account.mobile, account.ucc, body.totp)
    except BrokerAuthError as exc:
        await mgr.close()
        raise HTTPException(status_code=502, detail=str(exc))

    pending[account.id] = mgr
    return {**result, "accountId": account.id, "ucc": account.ucc}


@router.post("/totp-validate")
async def totp_validate(body: TOTPValidateRequest, request: Request):
    settings = request.app.state.settings
    pending = _pending(request)

    account_id = body.account_id
    if not account_id:
        if len(pending) == 1:
            account_id = next(iter(pending))
        elif not pending:
            raise HTTPException(status_code=409, detail="No pending login — start with TOTP first")
        else:
            raise HTTPException(status_code=400, detail="account_id is required")

    mgr = pending.get(account_id)
    if mgr is None:
        raise HTTPException(status_code=409, detail=f"No pending login for account '{account_id}'")

    try:
        result = await mgr.totp_validate(body.mpin)
    except (BrokerAuthError, AuthStateError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    creds = mgr.credentials
    previous = get_live_kotak_credentials()
    previous_ucc = str(previous.extra.get("ucc") or "") if previous else ""

    set_live_kotak_credentials(creds)
    pending.pop(account_id, None)
    await mgr.close()

    creds_dict = creds.model_dump()
    creds_dict["access_token"] = creds.access_token.get_secret_value()
    bundle = _build_bundle(creds_dict)

    # The positions table is a single-account snapshot mirror. Clear it on a
    # switch so the UI can't show the previous account's book under the new one
    # during the window before the first fetch lands.
    if previous_ucc and previous_ucc != bundle.ucc:
        from shared.positions import save_positions
        await save_positions(settings.timescaledb_url, [])
        log.info("kotak_auth.account_switched", previous_ucc=previous_ucc, ucc=bundle.ucc)

    await _publish(settings, creds_dict, bundle)

    log.info(
        "kotak_auth.credentials_stored_and_published",
        version=bundle.version,
        account_id=bundle.account_id,
        ucc=bundle.ucc,
    )
    return {**result, "accountId": bundle.account_id, "ucc": bundle.ucc}


@router.post("/republish")
async def republish_credentials(request: Request):
    """Re-broadcast the gateway's in-memory credentials.

    Credentials are process-local by design, so a restarted backend service
    (e.g. market_data_service) sits in awaiting_live_credentials until the
    next login. This re-emits the auth event and bumps the session version so
    such services re-activate without a fresh TOTP login.
    """
    settings = request.app.state.settings
    creds = get_live_kotak_credentials()
    if creds is None:
        raise HTTPException(status_code=409, detail="No live credentials in gateway memory — log in first")

    creds_dict = creds.model_dump()
    creds_dict["access_token"] = creds.access_token.get_secret_value()
    bundle = _build_bundle(creds_dict)

    await _publish(settings, creds_dict, bundle)

    log.info("kotak_auth.credentials_republished", version=bundle.version, ucc=bundle.ucc)
    return {"status": "republished", "version": bundle.version, "accountId": bundle.account_id}


def _pending_state(request: Request) -> bool:
    return any(
        mgr.state == AuthState.TOTP_PENDING for mgr in _pending(request).values()
    )


@router.get("/status", response_model=AuthStatusResponse)
async def auth_status(request: Request):
    settings = request.app.state.settings
    live_creds = get_live_kotak_credentials()
    session = await get_session(settings.redis_url)

    if live_creds is not None and session and session.state in (SessionState.ACTIVE, SessionState.DEGRADED):
        return AuthStatusResponse(
            broker="kotak",
            state=AuthState.AUTHENTICATED,
            client_id=live_creds.client_id,
            account_id=str(live_creds.extra.get("account_id") or ""),
            ucc=str(live_creds.extra.get("ucc") or ""),
        )

    if _pending_state(request) or (session and session.state == SessionState.TOTP_PENDING):
        return AuthStatusResponse(broker="kotak", state=AuthState.TOTP_PENDING)

    return AuthStatusResponse(broker="kotak", state=AuthState.UNAUTHENTICATED)


@router.get("/session")
async def session_info(request: Request):
    """Return versioned session state from Redis hash."""
    settings = request.app.state.settings
    session = await get_session(settings.redis_url)
    live_creds = get_live_kotak_credentials()
    if not session:
        return {
            "state": "unauthenticated",
            "version": 0,
            "lastHealthCheck": None,
            "healthCheckOk": False,
            "authenticatedAt": None,
            "accountId": "",
            "ucc": "",
        }
    session_state = session.state.value
    if session.state in (SessionState.ACTIVE, SessionState.DEGRADED) and live_creds is None:
        session_state = SessionState.UNAUTHENTICATED.value
    return {
        "state": session_state,
        "version": session.version,
        "lastHealthCheck": session.last_health_check or None,
        "healthCheckOk": session.health_check_ok,
        "authenticatedAt": session.authenticated_at or None,
        "accountId": session.account_id,
        "ucc": session.ucc,
    }


@router.post("/logout")
async def logout(request: Request):
    settings = request.app.state.settings

    pending = _pending(request)
    for mgr in list(pending.values()):
        await mgr.close()
    pending.clear()

    clear_live_kotak_credentials()

    # Drop the previous account's position mirror so the next login starts clean.
    from shared.positions import save_positions
    await save_positions(settings.timescaledb_url, [])

    bundle = SessionBundle(
        state=SessionState.UNAUTHENTICATED,
        access_token="",
        sid="",
        base_url="",
        server_id="",
        data_center="",
        environment=settings.kotak_environment or "prod",
        authenticated_at="",
        last_health_check="",
        health_check_ok=False,
    )
    await store_session(settings.redis_url, bundle)
    await publish_session_status(settings.redis_url, bundle.version, "expired")

    log.info("kotak_auth.logged_out", version=bundle.version)
    return {"status": "logged_out"}
