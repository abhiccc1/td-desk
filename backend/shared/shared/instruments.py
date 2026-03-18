"""Instrument master — single source of truth for underlying metadata.

Loads static instrument configuration from ``data/instruments.json`` so that
lot sizes, spot tokens, segment prefixes, and the tracked underlying list are
never hardcoded or re-parsed from broker CSVs.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from pydantic import BaseModel


class UnderlyingConfig(BaseModel):
    display_name: str
    exchange: str          # "NSE" | "BSE"
    segment: str           # "nse_fo" | "bse_fo"
    spot_segment: str      # "nse_cm" | "bse_cm"
    spot_token: str
    instrument_type: str   # "OPTIDX"
    lot_size: int
    freeze_quantity: int = 0  # NSE/BSE per-order freeze limit; 0 = no limit
    enabled: bool = True


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
        """Enabled underlying names (replaces TRACKED_UNDERLYINGS)."""
        return {n for n, c in self._configs.items() if c.enabled}

    def spot_tokens(self) -> dict[str, str]:
        """Enabled underlying → spot token (replaces INSTRUMENT_TOKENS)."""
        return {n: c.spot_token for n, c in self._configs.items() if c.enabled}

    def lot_sizes(self) -> dict[str, int]:
        """All underlying → lot size (replaces CSV extraction + Redis cache)."""
        return {n: c.lot_size for n, c in self._configs.items()}

    def enabled_underlyings(self) -> list[str]:
        """Enabled underlying names as a sorted list."""
        return sorted(n for n, c in self._configs.items() if c.enabled)

    def segments(self) -> set[str]:
        """Distinct segment prefixes across enabled underlyings (e.g. {"nse_fo"})."""
        return {c.segment for c in self._configs.values() if c.enabled}

    def freeze_quantities(self) -> dict[str, int]:
        """Underlying → freeze quantity (only those with a limit set)."""
        return {n: c.freeze_quantity for n, c in self._configs.items() if c.freeze_quantity > 0}

    def underlying_list(self) -> list[dict]:
        """Frontend-friendly list of underlyings."""
        return [
            {
                "name": name,
                "displayName": cfg.display_name,
                "exchange": cfg.exchange,
                "lotSize": cfg.lot_size,
                "enabled": cfg.enabled,
            }
            for name, cfg in self._configs.items()
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


# --- Redis cache keys ---

REDIS_KEY_LOT_SIZES = "cache:lot_sizes"
REDIS_KEY_FREEZE_QUANTITIES = "cache:freeze_quantities"
REDIS_KEY_UNDERLYINGS = "cache:underlyings"


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
