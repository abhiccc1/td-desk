"""Instrument master — single source of truth for underlying metadata.

Loads static instrument configuration from ``data/instruments.json`` so that
lot sizes, spot tokens, segment prefixes, and the tracked underlying list are
never hardcoded or re-parsed from broker CSVs.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel

IST = timezone(timedelta(hours=5, minutes=30))
_NEW_YORK = ZoneInfo("America/New_York")
_TRUTHY = {"1", "true", "yes", "on"}


# Names the Kotak SFeed index channel knows each index by. The index channel
# is addressed by NAME, not by the numeric spot token: subscribing an index
# with its token is accepted and ACKed, then silently delivers nothing.
#
# Casing and wording are the broker's and are inconsistent between indices
# ("Nifty Bank" but "NIFTY MID SELECT"), so these are not derivable from
# display_name — each was verified against the live feed on 2026-10-06.
# Override per-deployment via `index_name` in instruments.json.
DEFAULT_INDEX_NAMES: dict[str, str] = {
    "NIFTY": "Nifty 50",
    "BANKNIFTY": "Nifty Bank",
    "FINNIFTY": "Nifty Fin Service",
    "MIDCPNIFTY": "NIFTY MID SELECT",
    "SENSEX": "SENSEX",
    "BANKEX": "BANKEX",
}


class UnderlyingConfig(BaseModel):
    display_name: str
    exchange: str          # "NSE" | "BSE" | "MCX"
    segment: str           # "nse_fo" | "bse_fo" | "mcx_fo"
    spot_segment: str = ""  # "nse_cm" | "bse_cm"; empty for futures-underlying
    spot_token: str = ""
    # Name the SFeed index feed knows this index by, e.g. "Nifty 50",
    # "NIFTY MID SELECT". Kotak's index channel is addressed by NAME, not by
    # spot_token — subscribing an index with its numeric token is accepted and
    # then silently delivers nothing. Casing is the broker's, not ours, and is
    # inconsistent between indices; these strings are verified against the live
    # feed. Empty = no index feed for this underlying (falls back to parity).
    index_name: str = ""
    instrument_type: str   # option pInstType: "OPTIDX" | "IO" | "OPTFUT"
    lot_size: int          # expected order qty per lot (scrip master is authoritative)
    freeze_quantity: int = 0  # max qty (units) per order; 0 = no limit
    enabled: bool = True
    # --- commodity (options-on-futures) support ---
    asset_class: Literal["index", "commodity"] = "index"
    # "spot": underlying price from a cash index token; "future": from the
    # FUTCOM contract each option expiry devolves into (pAssetCode).
    underlying_source: Literal["spot", "future"] = "spot"
    future_instrument_type: str | None = None  # "FUTCOM" for MCX
    # ₹ P&L per lot per ₹1 price move (lLotSize × dGenNum/dGenDen). Differs
    # from lot_size when price is quoted per a different unit (GOLD: ₹/10g).
    pnl_multiplier: float | None = None
    # "HH:MM" IST, or "mcx_evening" (23:30 IST during US DST, else 23:55)
    session_close: str = "15:30"
    pricing_model: Literal["bsm_spot", "black76"] = "bsm_spot"
    # Env var that must be truthy for this underlying to be active
    feature_flag: str | None = None

    @property
    def effective_pnl_multiplier(self) -> float:
        return self.pnl_multiplier if self.pnl_multiplier is not None else float(self.lot_size)

    @property
    def unit_multiplier(self) -> float:
        """₹ value of 1 unit of order quantity per ₹1 of quoted price.

        ``price × qty × unit_multiplier`` is the rupee value. 1 for NSE/BSE and
        most MCX contracts; GOLD = 100 (qty in kg, price per 10 g),
        GOLDM = 0.1 (qty in g, price per 10 g). Equals Kotak's dGenNum/dGenDen.
        """
        return self.effective_pnl_multiplier / self.lot_size if self.lot_size else 1.0

    def flag_on(self) -> bool:
        if not self.feature_flag:
            return True
        return os.environ.get(self.feature_flag, "").strip().lower() in _TRUTHY

    @property
    def active(self) -> bool:
        """Enabled in config *and* its feature flag (if any) is on."""
        return self.enabled and self.flag_on()


def _session_close_time(session_close: str, on: date) -> time:
    if session_close == "mcx_evening":
        # MCX evening session tracks US daylight saving: 23:30 IST while the
        # US is on DST, 23:55 IST otherwise.
        noon_ny = datetime.combine(on, time(12, 0), tzinfo=_NEW_YORK)
        return time(23, 30) if noon_ny.dst() else time(23, 55)
    hh, mm = session_close.split(":")
    return time(int(hh), int(mm))


def exchange_from_segment(segment: str) -> str:
    """Map a Kotak exchange segment (``nse_fo``, ``mcx_fo``…) to an exchange label."""
    seg = (segment or "").lower()
    for prefix, label in (("nse", "NSE"), ("bse", "BSE"), ("mcx", "MCX")):
        if seg.startswith(prefix):
            return label
    return seg.upper()


class InstrumentMaster:
    """Read-only accessor for ``data/instruments.json``."""

    def __init__(self, path: str | Path | None = None) -> None:
        if path is None:
            path = os.environ.get("INSTRUMENTS_PATH", "")
        if not path:
            # Default: repo-root/data/instruments.json
            path = Path(__file__).resolve().parents[3] / "data" / "instruments.json"
        path = Path(path)
        with open(path) as f:
            raw = json.load(f)
        self._configs: dict[str, UnderlyingConfig] = {
            name: UnderlyingConfig(**cfg)
            for name, cfg in raw["underlyings"].items()
        }

    # --- public API ---

    def get(self, name: str) -> UnderlyingConfig | None:
        return self._configs.get(name.upper())

    def tracked_names(self) -> set[str]:
        """Active underlying names (replaces TRACKED_UNDERLYINGS)."""
        return {n for n, c in self._configs.items() if c.active}

    def spot_tokens(self) -> dict[str, str]:
        """Active spot-underlying → spot token (replaces INSTRUMENT_TOKENS)."""
        return {
            n: c.spot_token for n, c in self._configs.items()
            if c.active and c.underlying_source == "spot" and c.spot_token
        }

    def index_names(self) -> dict[str, str]:
        """Active spot-underlying → SFeed index name (for subscribe_index).

        Falls back to DEFAULT_INDEX_NAMES when the config doesn't override it,
        so the mapping ships with the code — ``data/`` is gitignored, so a
        value that lived only in instruments.json would not reach other
        environments.
        """
        out: dict[str, str] = {}
        for n, c in self._configs.items():
            if not (c.active and c.underlying_source == "spot"):
                continue
            name = c.index_name or DEFAULT_INDEX_NAMES.get(n, "")
            if name:
                out[n] = name
        return out

    def lot_sizes(self) -> dict[str, int]:
        """All underlying → lot size (replaces CSV extraction + Redis cache)."""
        return {n: c.lot_size for n, c in self._configs.items()}

    def enabled_underlyings(self) -> list[str]:
        """Active underlying names as a sorted list."""
        return sorted(n for n, c in self._configs.items() if c.active)

    def segments(self) -> set[str]:
        """Distinct segment prefixes across active underlyings (e.g. {"nse_fo"})."""
        return {c.segment for c in self._configs.values() if c.active}

    def freeze_quantities(self) -> dict[str, int]:
        """Underlying → freeze quantity (only those with a limit set)."""
        return {n: c.freeze_quantity for n, c in self._configs.items() if c.freeze_quantity > 0}

    def expiry_close_dt(self, underlying: str, expiry: str | date) -> datetime:
        """Timezone-aware expiry close for an option expiry (``YYYY-MM-DD``).

        NSE/BSE close at 15:30 IST; MCX options trade to the evening close.
        Unknown underlyings fall back to 15:30 IST.
        """
        d = expiry if isinstance(expiry, date) else date.fromisoformat(expiry)
        cfg = self.get(underlying)
        close = _session_close_time(cfg.session_close if cfg else "15:30", d)
        return datetime.combine(d, close, tzinfo=IST)

    def underlying_list(self) -> list[dict]:
        """Frontend-friendly list of underlyings.

        Entries whose feature flag is off are omitted entirely so the frontend
        never sees them (MCX is hidden until the frontend supports it).
        """
        return [
            {
                "name": name,
                "displayName": cfg.display_name,
                "exchange": cfg.exchange,
                "lotSize": cfg.lot_size,
                "enabled": cfg.enabled,
                "assetClass": cfg.asset_class,
                "pnlMultiplier": cfg.effective_pnl_multiplier,
                "sessionClose": cfg.session_close,
            }
            for name, cfg in self._configs.items()
            if cfg.flag_on()
        ]


# --- module-level singleton ---

_lock = threading.Lock()
_instance: InstrumentMaster | None = None


def get_instrument_master(path: str | Path | None = None) -> InstrumentMaster:
    """Return a singleton ``InstrumentMaster``, creating it on first call."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = InstrumentMaster(path)
    return _instance


def _master_or_none() -> InstrumentMaster | None:
    try:
        return get_instrument_master()
    except OSError:
        logging.getLogger(__name__).error(
            "instruments.master_unavailable — falling back to NSE 15:30 IST / BSM; "
            "MCX underlyings will be priced incorrectly until INSTRUMENTS_PATH is set"
        )
        return None


def expiry_close_utc(underlying: str | None, expiry: str | date) -> datetime:
    """Expiry close in UTC for ``underlying`` (15:30 IST if unknown)."""
    im = _master_or_none()
    if im is not None and underlying:
        return im.expiry_close_dt(underlying, expiry).astimezone(timezone.utc)
    d = expiry if isinstance(expiry, date) else date.fromisoformat(expiry)
    return datetime.combine(d, time(15, 30), tzinfo=IST).astimezone(timezone.utc)


def time_to_expiry_years(
    underlying: str | None, expiry: str | date, now: datetime | None = None
) -> float:
    """Continuous time to expiry in years (365.25-day basis), floored at 1e-6."""
    current = now or datetime.now(timezone.utc)
    secs = (expiry_close_utc(underlying, expiry) - current).total_seconds()
    return max(secs / (365.25 * 86400), 1e-6)


def unit_multiplier(underlying: str | None) -> float:
    """₹ per unit of qty per ₹1 of price for ``underlying`` (1.0 if unknown)."""
    im = _master_or_none()
    cfg = im.get(underlying) if im is not None and underlying else None
    return cfg.unit_multiplier if cfg else 1.0


def pricing_model(underlying: str | None) -> str:
    """``"black76"`` for options on futures, ``"bsm_spot"`` otherwise."""
    im = _master_or_none()
    cfg = im.get(underlying) if im is not None and underlying else None
    return cfg.pricing_model if cfg else "bsm_spot"


async def order_quantity_from_lots(
    redis_url: str,
    underlying: str | None,
    expiry: str | None,
    quantity: int | None,
    lots: int | None,
) -> tuple[int | None, str | None]:
    """Resolve an order leg's quantity in units (what Kotak expects).

    Clients may send ``lots`` instead of ``quantity``; the backend converts
    with its own lot size so a stale client lot size can't mis-size an order:
    the scrip master's per-expiry lot (MCX, ``cache:contract_meta``) when the
    expiry is known, else the verified ``instruments.json`` lot size.

    Returns ``(quantity, None)`` or ``(None, error)``. When both are sent they
    must agree — a mismatch is rejected, never silently resolved.
    """
    if lots is None:
        if quantity is None or quantity < 1:
            return None, "Either quantity or lots is required"
        return quantity, None
    if lots < 1:
        return None, "lots must be at least 1"

    im = _master_or_none()
    cfg = im.get(underlying) if im is not None and underlying else None
    if cfg is None:
        return None, f"Cannot convert lots for unknown underlying {underlying!r}; send quantity"

    lot_size = cfg.lot_size
    if expiry and cfg.asset_class == "commodity":
        from shared.redis_client import get_redis

        try:
            async with get_redis(redis_url) as client:
                raw = await client.hget(f"{REDIS_KEY_CONTRACT_META}:{underlying.upper()}", expiry)
            if raw:
                lot_size = int(json.loads(raw).get("lotSize") or lot_size)
        except Exception:
            logging.getLogger(__name__).warning(
                "instruments.contract_meta_unavailable underlying=%s expiry=%s", underlying, expiry
            )

    units = lots * lot_size
    if quantity is not None and quantity != units:
        return None, (
            f"quantity {quantity} does not match {lots} lot(s) × {lot_size} = {units} for {underlying}"
        )
    return units, None


# --- Redis cache keys ---

REDIS_KEY_LOT_SIZES = "cache:lot_sizes"
REDIS_KEY_FREEZE_QUANTITIES = "cache:freeze_quantities"
REDIS_KEY_UNDERLYINGS = "cache:underlyings"
# Hashes written by the scrip master, suffixed ":{underlying}", field = option expiry
REDIS_KEY_UNDERLYING_FUTURE = "cache:scrip:underlying_future"
REDIS_KEY_CONTRACT_META = "cache:contract_meta"


async def cache_instruments_to_redis(redis_url: str) -> None:
    """Push lot sizes and underlyings list into Redis (called once at startup)."""
    from shared.redis_client import get_redis

    im = get_instrument_master()
    async with get_redis(redis_url) as client:
        pipe = client.pipeline()

        # Lot sizes as a hash — same shape the old scrip master used
        pipe.delete(REDIS_KEY_LOT_SIZES)
        pipe.hset(REDIS_KEY_LOT_SIZES, mapping={k: str(v) for k, v in im.lot_sizes().items()})

        # Freeze quantities as a hash
        fq = im.freeze_quantities()
        if fq:
            pipe.delete(REDIS_KEY_FREEZE_QUANTITIES)
            pipe.hset(REDIS_KEY_FREEZE_QUANTITIES, mapping={k: str(v) for k, v in fq.items()})

        # Underlyings list as a JSON string
        pipe.set(REDIS_KEY_UNDERLYINGS, json.dumps(im.underlying_list()))

        await pipe.execute()
