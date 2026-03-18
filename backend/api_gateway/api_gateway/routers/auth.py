"""Kotak Neo API v2 authentication endpoints.

Two-step flow:
  POST /totp-login   → step 1 (mobile + UCC + TOTP)
  POST /totp-validate → step 2 (MPIN → credentials stored + published)
  GET  /status        → current auth state
"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.exceptions import AuthStateError, BrokerAuthError
from shared.redis_client import cache_set, get_redis
from shared.schemas.auth import AuthStatusResponse

log = structlog.get_logger()

router = APIRouter(prefix="/api/v1/auth/kotak", tags=["auth"])


class TOTPLoginRequest(BaseModel):
    mobile: str
    ucc: str
    totp: str


class TOTPValidateRequest(BaseModel):
    mpin: str


def _get_auth_manager(request: Request):
    mgr = getattr(request.app.state, "kotak_auth", None)
    if mgr is None:
        raise HTTPException(status_code=503, detail="Kotak auth manager not initialised")
    return mgr


@router.post("/totp-login")
async def totp_login(body: TOTPLoginRequest, request: Request):
    mgr = _get_auth_manager(request)
    try:
        result = await mgr.totp_login(body.mobile, body.ucc, body.totp)
        return result
    except BrokerAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/totp-validate")
async def totp_validate(body: TOTPValidateRequest, request: Request):
    mgr = _get_auth_manager(request)
    settings = request.app.state.settings
    try:
        result = await mgr.totp_validate(body.mpin)
    except (BrokerAuthError, AuthStateError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Store credentials in Redis cache — reveal SecretStr so downstream
    # services receive the actual access token, not the masked "**********".
    creds = mgr.credentials
    import json as _json
    creds_dict = creds.model_dump()
    creds_dict["access_token"] = creds.access_token.get_secret_value()
    creds_json = _json.dumps(creds_dict)
    await cache_set(settings.redis_url, "cache:auth:kotak", creds_json, ttl=86400)

    # Publish raw credentials JSON so market_data_service watcher can pick it up
    async with get_redis(settings.redis_url) as client:
        await client.publish("auth:kotak:authenticated", creds_json)

    log.info("kotak_auth.credentials_stored_and_published")
    return result


@router.get("/status", response_model=AuthStatusResponse)
async def auth_status(request: Request):
    mgr = _get_auth_manager(request)
    return AuthStatusResponse(
        broker="kotak",
        state=mgr.state,
    )
