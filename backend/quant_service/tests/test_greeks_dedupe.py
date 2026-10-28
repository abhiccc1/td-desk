"""Greeks recompute guard — skip chains whose quotes haven't moved.

This is the backstop that holds even when the UI's demand signal is wrong or
never arrives, so it is tested independently of the snapshot cadence.
"""

from __future__ import annotations

import sys
import types

import pytest

# Importing greeks.py pulls in the indicators package, which imports the Rust
# extension and the historical module's heavy deps. None of that is reached by
# the guard under test. setdefault means the real modules win wherever they are
# installed (the service image), and only a bare-metal checkout gets the stub.
for _optional in ("td_core", "polars"):
    if _optional not in sys.modules:
        _stub = types.ModuleType(_optional)
        # Annotations such as `pl.DataFrame` are evaluated at class-definition
        # time, so the stub has to answer any attribute, not just the ones a
        # given version happens to use.
        _stub.__getattr__ = lambda name: object  # type: ignore[method-assign]
        sys.modules[_optional] = _stub

from quant_service.indicators.greeks import (  # noqa: E402
    _GREEKS_MAX_STALENESS_S,
    ChainGreeksCalculator,
)

KEY = ("NIFTY", "2026-12-31", False)


@pytest.fixture
def calc() -> ChainGreeksCalculator:
    return ChainGreeksCalculator()


def test_first_snapshot_always_computes(calc: ChainGreeksCalculator):
    assert calc._should_recompute(KEY, 1234) is True


def test_identical_fingerprint_is_skipped(calc: ChainGreeksCalculator):
    calc._should_recompute(KEY, 1234)
    assert calc._should_recompute(KEY, 1234) is False


def test_changed_fingerprint_recomputes(calc: ChainGreeksCalculator):
    calc._should_recompute(KEY, 1234)
    assert calc._should_recompute(KEY, 5678) is True


def test_stale_fingerprint_recomputes(
    calc: ChainGreeksCalculator, monkeypatch: pytest.MonkeyPatch
):
    """Theta and time-to-expiry keep drifting on a frozen chain, so an
    unchanged strip must still re-solve once the staleness bound passes."""
    clock = [1000.0]
    monkeypatch.setattr(
        "quant_service.indicators.greeks.time.monotonic", lambda: clock[0]
    )

    assert calc._should_recompute(KEY, 1234) is True
    clock[0] += _GREEKS_MAX_STALENESS_S - 0.1
    assert calc._should_recompute(KEY, 1234) is False
    clock[0] += 0.2
    assert calc._should_recompute(KEY, 1234) is True


def test_chains_are_tracked_independently(calc: ChainGreeksCalculator):
    calc._should_recompute(("NIFTY", "2026-12-31", False), 1234)
    assert calc._should_recompute(("BANKNIFTY", "2026-12-31", False), 1234) is True


def test_position_and_chain_snapshots_tracked_separately(
    calc: ChainGreeksCalculator,
):
    """The two pipelines publish to different topics, so a chain snapshot must
    not suppress the position snapshot that carries the same quotes."""
    calc._should_recompute(("NIFTY", "2026-12-31", False), 1234)
    assert calc._should_recompute(("NIFTY", "2026-12-31", True), 1234) is True
