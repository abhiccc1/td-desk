from __future__ import annotations

import httpx
from pydantic import SecretStr

from session_broker.health_check import SessionHealth, health_check_session
from shared.schemas.auth import BrokerCredentials, SessionBundle


class _FakeAsyncClient:
    def __init__(self, response: httpx.Response | None = None, error: Exception | None = None):
        self._response = response
        self._error = error

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def get(self, *_args, **_kwargs) -> httpx.Response:
        if self._error is not None:
            raise self._error
        assert self._response is not None
        return self._response


def _bundle() -> SessionBundle:
    return SessionBundle(
        version=7,
        state="active",
        base_url="https://example.com",
    )


def _creds() -> BrokerCredentials:
    return BrokerCredentials(
        broker_name="kotak",
        access_token=SecretStr("token"),
        extra={"sid": "sid", "base_url": "https://example.com"},
    )


async def test_health_check_marks_auth_rejection_as_expired(monkeypatch):
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeAsyncClient(response=httpx.Response(status_code=401)),
    )

    result = await health_check_session(_bundle(), _creds())

    assert result == SessionHealth.EXPIRED


async def test_health_check_marks_transport_failures_as_degraded(monkeypatch):
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeAsyncClient(
            error=httpx.ConnectError("boom", request=httpx.Request("GET", "https://example.com"))
        ),
    )

    result = await health_check_session(_bundle(), _creds())

    assert result == SessionHealth.DEGRADED
