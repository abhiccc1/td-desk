"""Broker authentication schemas."""

from enum import StrEnum

from pydantic import BaseModel, SecretStr


class AuthState(StrEnum):
    UNAUTHENTICATED = "unauthenticated"
    TOTP_PENDING = "totp_pending"
    AUTHENTICATED = "authenticated"


class BrokerCredentials(BaseModel):
    broker_name: str = ""
    client_id: str = ""
    access_token: SecretStr
    extra: dict = {}


class AuthStatusResponse(BaseModel):
    broker: str
    state: AuthState
    client_id: str = ""
