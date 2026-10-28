"""Broker authentication schemas."""

from enum import StrEnum

from pydantic import BaseModel, SecretStr


class AuthState(StrEnum):
    UNAUTHENTICATED = "unauthenticated"
    TOTP_PENDING = "totp_pending"
    AUTHENTICATED = "authenticated"


class SessionState(StrEnum):
    UNAUTHENTICATED = "unauthenticated"
    TOTP_PENDING = "totp_pending"
    ACTIVE = "active"
    DEGRADED = "degraded"
    EXPIRED = "expired"


class SessionBundle(BaseModel):
    version: int = 0
    state: SessionState = SessionState.UNAUTHENTICATED
    broker_name: str = "kotak"
    access_token: str = ""
    sid: str = ""
    server_id: str = ""
    data_center: str = ""
    base_url: str = ""
    environment: str = "prod"
    account_id: str = ""
    ucc: str = ""
    authenticated_at: str = ""
    last_health_check: str = ""
    health_check_ok: bool = True


class BrokerCredentials(BaseModel):
    broker_name: str = ""
    client_id: str = ""
    access_token: SecretStr
    extra: dict = {}


class AuthStatusResponse(BaseModel):
    broker: str
    state: AuthState
    client_id: str = ""
    account_id: str = ""
    ucc: str = ""
