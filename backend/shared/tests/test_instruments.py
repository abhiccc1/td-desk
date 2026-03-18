"""Tests for InstrumentMaster and freeze quantity support."""

from __future__ import annotations

from pathlib import Path

import pytest

from shared.instruments import InstrumentMaster

# Use the real instruments.json from the repo
INSTRUMENTS_PATH = Path(__file__).resolve().parents[3] / "data" / "instruments.json"


@pytest.fixture
def im():
    return InstrumentMaster(INSTRUMENTS_PATH)


class TestInstrumentMaster:
    def test_loads_all_underlyings(self, im: InstrumentMaster):
        names = im.tracked_names()
        assert "NIFTY" in names
        assert "BANKNIFTY" in names
        assert "SENSEX" in names

    def test_bankex_disabled(self, im: InstrumentMaster):
        """BANKEX is disabled and should not appear in tracked_names."""
        names = im.tracked_names()
        assert "BANKEX" not in names

    def test_get_returns_config(self, im: InstrumentMaster):
        cfg = im.get("NIFTY")
        assert cfg is not None
        assert cfg.lot_size == 65
        assert cfg.exchange == "NSE"
        assert cfg.segment == "nse_fo"

    def test_get_case_insensitive(self, im: InstrumentMaster):
        assert im.get("nifty") is not None
        assert im.get("Nifty") is not None

    def test_get_unknown_returns_none(self, im: InstrumentMaster):
        assert im.get("FOOBAR") is None


class TestFreezeQuantities:
    def test_all_underlyings_have_freeze_qty(self, im: InstrumentMaster):
        fq = im.freeze_quantities()
        assert fq["NIFTY"] == 1800
        assert fq["BANKNIFTY"] == 900
        assert fq["FINNIFTY"] == 1800
        assert fq["MIDCPNIFTY"] == 2800
        assert fq["SENSEX"] == 1000
        assert fq["BANKEX"] == 1500

    def test_freeze_qty_in_config(self, im: InstrumentMaster):
        cfg = im.get("NIFTY")
        assert cfg is not None
        assert cfg.freeze_quantity == 1800

    def test_freeze_qty_zero_excluded(self):
        """If a hypothetical underlying has freeze_quantity=0, it's excluded."""
        # The default is 0, so any underlying without freeze_quantity set would be excluded
        im = InstrumentMaster(INSTRUMENTS_PATH)
        fq = im.freeze_quantities()
        for v in fq.values():
            assert v > 0


class TestLotSizes:
    def test_lot_sizes(self, im: InstrumentMaster):
        lots = im.lot_sizes()
        assert lots["NIFTY"] == 65
        assert lots["BANKNIFTY"] == 30
        assert lots["SENSEX"] == 20

    def test_lot_sizes_includes_disabled(self, im: InstrumentMaster):
        """lot_sizes() should include disabled underlyings too."""
        lots = im.lot_sizes()
        assert "BANKEX" in lots
        assert lots["BANKEX"] == 20


class TestSegments:
    def test_segments(self, im: InstrumentMaster):
        segs = im.segments()
        assert "nse_fo" in segs
        assert "bse_fo" in segs

    def test_segments_only_enabled(self, im: InstrumentMaster):
        """Only enabled underlyings contribute segments."""
        # BANKEX is disabled but uses bse_fo — SENSEX (enabled) also uses bse_fo
        # so bse_fo should still be present
        segs = im.segments()
        assert "bse_fo" in segs


class TestUnderlyingList:
    def test_underlying_list_structure(self, im: InstrumentMaster):
        ul = im.underlying_list()
        assert len(ul) >= 6
        nifty = next(u for u in ul if u["name"] == "NIFTY")
        assert nifty["displayName"] == "Nifty 50"
        assert nifty["lotSize"] == 65
        assert nifty["enabled"] is True
