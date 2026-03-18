"""Kotak Neo API v2 TOTP-based authentication manager.

Two-step flow:
    1. totp_login(mobile, ucc, totp) → view token + sid
    2. totp_validate(mpin)           → edit token + sid + baseUrl for order APIs

Reference: https://github.com/Kotak-Neo/Kotak-neo-api-v2
"""

from __future__ import annotations

import asyncio

import httpx
import structlog
from pydantic import SecretStr

from shared.exceptions import AuthStateError, BrokerAuthError
from shared.schemas.auth import AuthState, BrokerCredentials

logger = structlog.get_logger()

_AUTH_BASE_URL = "https://mis.kotaksecurities.com"
_NEO_FIN_KEY = "neotradeapi"


class KotakAuthManager:
    """Two-step TOTP authentication for Kotak Neo API v2.

    Usage::

        mgr = KotakAuthManager(consumer_key="...")
        await mgr.totp_login(mobile, ucc, totp)
        await mgr.totp_validate(mpin)
        creds = mgr.credentials
    """

    def __init__(self, consumer_key: str, environment: str = "prod") -> None:
        self._consumer_key = consumer_key
        self._environment = environment
        self._client = httpx.AsyncClient(timeout=30.0)
        self._lock = asyncio.Lock()

        # Auth state
        self._state = AuthState.UNAUTHENTICATED
        self._view_token: str | None = None
        self._sid: str | None = None
        self._edit_token: str | None = None
        self._edit_sid: str | None = None
        self._hs_server_id: str | None = None
        self._data_center: str | None = None
        self._base_url: str | None = None  # dynamic base URL for order/data APIs

    @property
    def state(self) -> AuthState:
        return self._state

    @property
    def credentials(self) -> BrokerCredentials:
        if self._state != AuthState.AUTHENTICATED:
            raise AuthStateError("Cannot get credentials before authentication completes")
        return BrokerCredentials(
            broker_name="kotak",
            client_id="",
            access_token=SecretStr(self._edit_token),
            extra={
                "sid": self._edit_sid,
                "server_id": self._hs_server_id or "",
                "data_center": self._data_center or "",
                "base_url": self._base_url or "",
                "environment": self._environment,
            },
        )

    async def totp_login(self, mobile: str, ucc: str, totp: str) -> dict:
        """Step 1: TOTP login — sends mobile, UCC, and TOTP to obtain view token."""
        async with self._lock:
            resp = await self._client.post(
                f"{_AUTH_BASE_URL}/login/1.0/tradeApiLogin",
                headers={
                    "Authorization": self._consumer_key,
                    "Content-Type": "application/json",
                    "neo-fin-key": _NEO_FIN_KEY,
                },
                json={"mobileNumber": mobile, "ucc": ucc, "totp": totp},
            )
            if resp.status_code >= 400:
                self._reset()
                raise BrokerAuthError(f"TOTP login failed: {resp.status_code} {resp.text}")

            payload = resp.json()
            nested = payload.get("data", {})
            self._view_token = nested.get("token")
            self._sid = nested.get("sid")
            if not self._view_token or not self._sid:
                self._reset()
                raise BrokerAuthError(f"Missing token/sid in TOTP login response: {payload}")

            self._state = AuthState.TOTP_PENDING
            logger.info("kotak_auth.totp_login_ok")
            return {"status": "totp_pending"}

    async def totp_validate(self, mpin: str) -> dict:
        """Step 2: Validate MPIN to get edit tokens for API/WebSocket access."""
        async with self._lock:
            if self._state != AuthState.TOTP_PENDING:
                raise AuthStateError(f"Cannot validate TOTP in state {self._state.value}")

            resp = await self._client.post(
                f"{_AUTH_BASE_URL}/login/1.0/tradeApiValidate",
                headers={
                    "Authorization": self._consumer_key,
                    "sid": self._sid,
                    "Auth": self._view_token,
                    "neo-fin-key": _NEO_FIN_KEY,
                },
                json={"mpin": mpin},
            )
            if resp.status_code >= 400:
                raise BrokerAuthError(f"TOTP validation failed: {resp.status_code} {resp.text}")

            payload = resp.json()
            nested = payload.get("data", {})
            self._edit_token = nested.get("token")
            self._edit_sid = nested.get("sid")
            self._hs_server_id = nested.get("hsServerId")
            self._data_center = nested.get("dataCenter")
            self._base_url = nested.get("baseUrl")
            if not self._edit_token or not self._edit_sid:
                raise BrokerAuthError(f"Missing edit tokens in TOTP validate response: {payload}")

            self._state = AuthState.AUTHENTICATED
            logger.info("kotak_auth.authenticated", data_center=self._data_center)
            return {"status": "authenticated"}

    def _reset(self) -> None:
        self._state = AuthState.UNAUTHENTICATED
        self._view_token = None
        self._sid = None
        self._edit_token = None
        self._edit_sid = None
        self._hs_server_id = None
        self._data_center = None
        self._base_url = None

    async def close(self) -> None:
        await self._client.aclose()
