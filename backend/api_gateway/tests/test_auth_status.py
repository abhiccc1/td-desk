from __future__ import annotations

import json
import sys
from types import SimpleNamespace

from pydantic import SecretStr

sys.modules.setdefault(
    "orjson",
    SimpleNamespace(
        dumps=lambda value: json.dumps(value).encode(),
        loads=lambda value: json.loads(value),
    ),
)

from api_gateway.routers import auth as auth_router
from shared.live_session import clear_live_kotak_credentials, set_live_kotak_credentials
from shared.schemas.auth import AuthState, BrokerCredentials, SessionBundle, SessionState


def _request_with(state: AuthState):
    """Request whose gateway has one in-flight login attempt in ``state``.

    Auth managers are now created per login attempt and held in
    ``kotak_auth_pending`` keyed by account id, rather than as one singleton.
    """
    app = SimpleNamespace(
        state=SimpleNamespace(
            settings=SimpleNamespace(redis_url="redis://test"),
            kotak_auth_pending={"primary": SimpleNamespace(state=state)},
        )
    )
    return SimpleNamespace(app=app)


def _live_creds() -> BrokerCredentials:
    return BrokerCredentials(
        broker_name="kotak",
        client_id="ABCD1",
        access_token=SecretStr("live-token"),
        extra={
            "sid": "live-sid",
            "base_url": "https://example.com",
            "account_id": "primary",
            "ucc": "ABCD1",
        },
    )


async def test_auth_status_does_not_trust_stale_manager_when_session_expired(monkeypatch):
    clear_live_kotak_credentials()

    async def fake_get_session(_redis_url: str):
        return SessionBundle(
            version=4,
            state=SessionState.EXPIRED,
            access_token="expired-token",
            sid="expired-sid",
            base_url="https://example.com",
        )

    monkeypatch.setattr(auth_router, "get_session", fake_get_session)

    result = await auth_router.auth_status(_request_with(AuthState.AUTHENTICATED))

    assert result.state == AuthState.UNAUTHENTICATED


async def test_auth_status_preserves_totp_pending_from_manager_when_session_is_stale(monkeypatch):
    clear_live_kotak_credentials()

    async def fake_get_session(_redis_url: str):
        return SessionBundle(
            version=4,
            state=SessionState.EXPIRED,
            access_token="",
            sid="",
            base_url="",
        )

    monkeypatch.setattr(auth_router, "get_session", fake_get_session)

    result = await auth_router.auth_status(_request_with(AuthState.TOTP_PENDING))

    assert result.state == AuthState.TOTP_PENDING


async def test_auth_status_reports_authenticated_only_with_live_credentials(monkeypatch):
    async def fake_get_session(_redis_url: str):
        return SessionBundle(
            version=5,
            state=SessionState.ACTIVE,
            access_token="",
            sid="",
            base_url="https://example.com",
        )

    monkeypatch.setattr(auth_router, "get_session", fake_get_session)

    clear_live_kotak_credentials()
    unauthenticated = await auth_router.auth_status(_request_with(AuthState.AUTHENTICATED))
    assert unauthenticated.state == AuthState.UNAUTHENTICATED

    set_live_kotak_credentials(_live_creds())
    authenticated = await auth_router.auth_status(_request_with(AuthState.AUTHENTICATED))
    assert authenticated.state == AuthState.AUTHENTICATED
    # The signed-in account is reported so the UI can show which book is live.
    assert authenticated.account_id == "primary"
    assert authenticated.ucc == "ABCD1"

    clear_live_kotak_credentials()
