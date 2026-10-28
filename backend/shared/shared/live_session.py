"""Process-local live Kotak credentials.

Each service process keeps its own in-memory copy of the current authenticated
credentials. Redis only stores session state metadata, not broker tokens.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import SecretStr

from shared.schemas.auth import BrokerCredentials

_live_kotak_credentials: BrokerCredentials | None = None


def get_live_kotak_credentials() -> BrokerCredentials | None:
    return _live_kotak_credentials


def set_live_kotak_credentials(credentials: BrokerCredentials | None) -> None:
    global _live_kotak_credentials
    _live_kotak_credentials = credentials


def clear_live_kotak_credentials() -> None:
    set_live_kotak_credentials(None)


def get_active_ucc() -> str:
    """UCC of the currently authenticated account, or ``""`` when logged out.

    Account-scoped persistence (trade history) keys off this, so a switch to a
    different broker account never reads or writes the previous account's rows.
    """
    creds = _live_kotak_credentials
    if creds is None:
        return ""
    return str(creds.extra.get("ucc") or "")


def get_active_consumer_key() -> str:
    """Consumer key of the authenticated account, or ``""`` when logged out.

    Published with the credentials so downstream services use the key belonging
    to the account that actually logged in, not the process-wide env fallback.
    """
    creds = _live_kotak_credentials
    if creds is None:
        return ""
    return str(creds.extra.get("consumer_key") or "")


def parse_live_kotak_credentials(payload: str | bytes | dict[str, Any]) -> BrokerCredentials:
    if isinstance(payload, bytes):
        data = json.loads(payload.decode())
    elif isinstance(payload, str):
        data = json.loads(payload)
    else:
        data = payload

    access_token = str(data.get("access_token") or "")
    if not access_token:
        raise ValueError("Missing access token in auth payload")

    return BrokerCredentials(
        broker_name=str(data.get("broker_name") or "kotak"),
        client_id=str(data.get("client_id") or ""),
        access_token=SecretStr(access_token),
        extra=dict(data.get("extra") or {}),
    )
