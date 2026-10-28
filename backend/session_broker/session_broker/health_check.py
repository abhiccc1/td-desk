"""Kotak session health check — lightweight REST probe."""

from __future__ import annotations

from enum import StrEnum

import httpx
import structlog

from shared.schemas.auth import BrokerCredentials
from shared.schemas.auth import SessionBundle

log = structlog.get_logger()


class SessionHealth(StrEnum):
    ACTIVE = "active"
    DEGRADED = "degraded"
    EXPIRED = "expired"


async def health_check_session(
    session: SessionBundle,
    credentials: BrokerCredentials,
) -> SessionHealth:
    """Classify session health via a lightweight authenticated API call."""
    base_url = str(credentials.extra.get("base_url") or session.base_url or "")
    access_token = credentials.access_token.get_secret_value()
    sid = str(credentials.extra.get("sid") or "")
    if not base_url or not access_token or not sid:
        return SessionHealth.EXPIRED
    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{base_url}/quick/user/limits",
                headers={
                    "Auth": access_token,
                    "Sid": sid,
                    "neo-fin-key": "neotradeapi",
                },
            )
            if resp.status_code == 200:
                status = SessionHealth.ACTIVE
            elif resp.status_code in (401, 403):
                status = SessionHealth.EXPIRED
            else:
                status = SessionHealth.DEGRADED
            log.debug(
                "health_check.result",
                status=resp.status_code,
                health=status,
                version=session.version,
            )
            return status
    except Exception as exc:
        log.warning("health_check.request_failed", error=str(exc))
        return SessionHealth.DEGRADED
