"""Server-side Kotak broker account profiles.

Each profile bundles the credentials that identify one broker account: the
consumer key (a long-lived API secret), the registered mobile number, and the
UCC. Profiles live in the ``KOTAK_ACCOUNTS`` env var so the consumer key never
leaves the host — the UI only ever sees a profile id and label.

``KOTAK_ACCOUNTS`` is a JSON array::

    [
      {"id": "primary", "label": "Primary", "consumer_key": "...",
       "mobile": "+919999999999", "ucc": "ABCD1"},
      {"id": "hedge", "label": "Hedge book", "consumer_key": "...",
       "mobile": "+918888888888", "ucc": "WXYZ9"}
    ]

When it is unset, the legacy single-account env vars (``KOTAK_CONSUMER_KEY``
plus a client-supplied mobile/UCC) still work — ``load_accounts`` returns an
empty list and the auth router falls back to the request body.
"""

from __future__ import annotations

import json

import structlog
from pydantic import BaseModel, Field

log = structlog.get_logger()


class KotakAccount(BaseModel):
    """One broker account profile. ``consumer_key`` is never serialised to clients."""

    id: str
    label: str = ""
    consumer_key: str = ""
    mobile: str = ""
    ucc: str = ""

    def public(self) -> dict:
        """Client-safe view — identity only, no secret."""
        return {
            "id": self.id,
            "label": self.label or self.ucc or self.id,
            "ucc": self.ucc,
            "mobileMasked": _mask_mobile(self.mobile),
        }


def _mask_mobile(mobile: str) -> str:
    digits = "".join(c for c in mobile if c.isdigit())
    if len(digits) < 4:
        return ""
    return f"••••••{digits[-4:]}"


class AccountRegistry(BaseModel):
    """Resolved account profiles, keyed by id."""

    accounts: list[KotakAccount] = Field(default_factory=list)

    def get(self, account_id: str | None) -> KotakAccount | None:
        """Exact lookup by id. Never falls back to a default.

        Picking a default here would silently sign a caller that omitted the id
        into the first profile — which is the wrong account as soon as more than
        one is configured. Callers handle the empty case via ``sole``.
        """
        if not account_id:
            return None
        for acc in self.accounts:
            if acc.id == account_id:
                return acc
        return None

    @property
    def sole(self) -> KotakAccount | None:
        """The only configured account, or ``None`` when the choice is ambiguous."""
        if len(self.accounts) == 1:
            return self.accounts[0]
        return None

    def by_ucc(self, ucc: str) -> KotakAccount | None:
        for acc in self.accounts:
            if acc.ucc and acc.ucc.upper() == ucc.upper():
                return acc
        return None

    @property
    def sole_ucc(self) -> str:
        """The UCC when exactly one account is configured, else ``""``.

        Used to backfill pre-multi-account trade history, which predates the
        ``ucc`` column and can only have come from a single account.
        """
        sole = self.sole
        return sole.ucc if sole else ""


def load_accounts(raw: str, *, legacy_consumer_key: str = "") -> AccountRegistry:
    """Parse ``KOTAK_ACCOUNTS`` JSON into a registry.

    A malformed value is logged and treated as unset rather than crashing
    startup — the legacy single-key path then takes over.
    """
    raw = (raw or "").strip()
    if not raw:
        return AccountRegistry()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.error("kotak_accounts.parse_failed", error=str(exc))
        return AccountRegistry()

    if not isinstance(parsed, list):
        log.error("kotak_accounts.not_a_list", got=type(parsed).__name__)
        return AccountRegistry()

    accounts: list[KotakAccount] = []
    seen: set[str] = set()
    for idx, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            log.warning("kotak_accounts.skipped_entry", index=idx, reason="not an object")
            continue
        account_id = str(entry.get("id") or entry.get("ucc") or f"account{idx + 1}")
        if account_id in seen:
            log.warning("kotak_accounts.duplicate_id", id=account_id)
            continue
        consumer_key = str(entry.get("consumer_key") or legacy_consumer_key or "")
        if not consumer_key:
            log.warning("kotak_accounts.skipped_entry", index=idx, reason="no consumer_key")
            continue
        seen.add(account_id)
        accounts.append(
            KotakAccount(
                id=account_id,
                label=str(entry.get("label") or ""),
                consumer_key=consumer_key,
                mobile=str(entry.get("mobile") or ""),
                ucc=str(entry.get("ucc") or ""),
            )
        )

    log.info("kotak_accounts.loaded", count=len(accounts), ids=[a.id for a in accounts])
    return AccountRegistry(accounts=accounts)
