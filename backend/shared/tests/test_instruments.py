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

    def test_index_names_are_broker_names_not_tokens(self, im: InstrumentMaster):
        """The SFeed index channel is addressed by the broker's index name.

        Subscribing with the numeric spot token is accepted and ACKed by the
        feed, then silently delivers nothing — so a regression here is invisible
        at the transport layer and only shows up as a frozen spot price.
        """
        names = im.index_names()
        assert names["NIFTY"] == "Nifty 50"
        assert names["BANKNIFTY"] == "Nifty Bank"
        # Not derivable from display_name ("Midcap Nifty") or from the
        # "Nifty Midcap 50"/"Nifty Midcap 100" indices, which are different.
        assert names["MIDCPNIFTY"] == "NIFTY MID SELECT"

        # No entry may be a spot token.
        spot_tokens = set(im.spot_tokens().values())
        assert not (set(names.values()) & spot_tokens)

    def test_every_active_spot_underlying_has_an_index_name(self, im: InstrumentMaster):
        """A spot underlying without an index name has no live spot feed and
        silently falls back to the put-call parity estimate."""
        missing = set(im.spot_tokens()) - set(im.index_names())
        assert not missing, f"no SFeed index name for: {sorted(missing)}"

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


MCX_NAMES = {"CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI", "GOLD", "GOLDM"}


class TestMcxFeatureFlag:
    def test_hidden_when_flag_off(self, monkeypatch):
        monkeypatch.delenv("MCX_ENABLED", raising=False)
        im = InstrumentMaster(INSTRUMENTS_PATH)
        assert not (im.tracked_names() & MCX_NAMES)
        assert "mcx_fo" not in im.segments()
        assert not ({u["name"] for u in im.underlying_list()} & MCX_NAMES)

    def test_active_when_flag_on(self, monkeypatch):
        monkeypatch.setenv("MCX_ENABLED", "true")
        im = InstrumentMaster(INSTRUMENTS_PATH)
        assert MCX_NAMES <= im.tracked_names()
        assert "mcx_fo" in im.segments()
        gold = next(u for u in im.underlying_list() if u["name"] == "GOLD")
        assert gold["exchange"] == "MCX"
        assert gold["lotSize"] == 1
        assert gold["pnlMultiplier"] == 100
        assert gold["assetClass"] == "commodity"

    def test_futures_underlyings_have_no_spot_token(self, monkeypatch):
        monkeypatch.setenv("MCX_ENABLED", "1")
        im = InstrumentMaster(INSTRUMENTS_PATH)
        assert not (set(im.spot_tokens()) & MCX_NAMES)
        assert "NIFTY" in im.spot_tokens()


class TestExpiryClose:
    def test_nse_close(self, im: InstrumentMaster):
        dt = im.expiry_close_dt("NIFTY", "2026-10-06")
        assert (dt.hour, dt.minute) == (15, 30)
        assert dt.utcoffset().total_seconds() == 5.5 * 3600

    def test_mcx_close_us_dst(self, im: InstrumentMaster):
        # US DST in force (Oct) → 23:30 IST
        dt = im.expiry_close_dt("CRUDEOIL", "2026-10-15")
        assert (dt.hour, dt.minute) == (23, 30)

    def test_mcx_close_us_standard_time(self, im: InstrumentMaster):
        # US DST ended 1-Nov-2026 → 23:55 IST
        dt = im.expiry_close_dt("CRUDEOIL", "2026-11-17")
        assert (dt.hour, dt.minute) == (23, 55)
        # US DST starts 8-Mar-2026
        assert im.expiry_close_dt("GOLD", "2026-03-06").hour == 23
        assert im.expiry_close_dt("GOLD", "2026-03-06").minute == 55
        assert im.expiry_close_dt("GOLD", "2026-03-10").minute == 30

    def test_unknown_underlying_defaults_to_1530(self, im: InstrumentMaster):
        assert im.expiry_close_dt("FOOBAR", "2026-10-06").hour == 15


class TestExchangeFromSegment:
    @pytest.mark.parametrize("seg,label", [
        ("nse_fo", "NSE"), ("bse_fo", "BSE"), ("mcx_fo", "MCX"),
        ("NSE_CM", "NSE"), ("cde_fo", "CDE_FO"), ("", ""),
    ])
    def test_mapping(self, seg, label):
        from shared.instruments import exchange_from_segment
        assert exchange_from_segment(seg) == label


class TestUnitMultiplier:
    @pytest.mark.parametrize("name,mult", [
        ("NIFTY", 1.0), ("SENSEX", 1.0), ("CRUDEOIL", 1.0), ("CRUDEOILM", 1.0),
        ("NATURALGAS", 1.0), ("NATGASMINI", 1.0), ("GOLD", 100.0), ("GOLDM", 0.1),
    ])
    def test_unit_multiplier(self, im: InstrumentMaster, name, mult):
        # ₹ value = price × qty × unit_multiplier (Kotak dGenNum/dGenDen)
        assert im.get(name).unit_multiplier == pytest.approx(mult)

    def test_gold_one_lot_rupee_value(self, im: InstrumentMaster):
        gold = im.get("GOLD")
        # ₹1 move on GOLD (₹/10g) × 1 lot (1 kg) = ₹100
        assert 1.0 * gold.lot_size * gold.unit_multiplier == pytest.approx(100.0)


class TestOrderQuantityFromLots:
    """Lots → units conversion used by live, margin-preview, paper and modify."""

    @pytest.fixture(autouse=True)
    def _master(self, monkeypatch):
        import shared.instruments as instruments
        monkeypatch.setattr(instruments, "_instance", InstrumentMaster(INSTRUMENTS_PATH))

    @staticmethod
    def _run(*args):
        import asyncio
        from shared.instruments import order_quantity_from_lots
        return asyncio.run(order_quantity_from_lots("redis://unused", *args))

    def test_quantity_passthrough(self):
        assert self._run("NIFTY", None, 130, None) == (130, None)

    def test_missing_both(self):
        qty, err = self._run("NIFTY", None, None, None)
        assert qty is None and "required" in err

    @pytest.mark.parametrize("name,lots,units", [
        ("CRUDEOIL", 2, 200), ("CRUDEOILM", 3, 30), ("NATURALGAS", 1, 1250),
        ("NATGASMINI", 4, 1000), ("GOLD", 5, 5), ("GOLDM", 2, 200), ("NIFTY", 2, 130),
    ])
    def test_lots_to_units(self, name, lots, units):
        # expiry None → verified instruments.json lot size (no Redis needed)
        assert self._run(name, None, None, lots) == (units, None)

    def test_both_agree(self):
        assert self._run("CRUDEOILM", None, 30, 3) == (30, None)

    def test_both_disagree_rejected(self):
        # Client thought 1 lot = 1 unit: must not be silently "fixed"
        qty, err = self._run("CRUDEOILM", None, 3, 3)
        assert qty is None and "does not match" in err

    def test_unknown_underlying_with_lots_rejected(self):
        qty, err = self._run("RELIANCE", None, None, 2)
        assert qty is None and "unknown underlying" in err

    def test_per_expiry_lot_from_contract_meta(self, monkeypatch):
        """MCX uses the scrip master's per-expiry lot when the expiry is known."""
        import contextlib
        import json

        import shared.redis_client as rc

        class FakeRedis:
            async def hget(self, key, field):
                assert key == "cache:contract_meta:CRUDEOIL" and field == "2026-10-15"
                return json.dumps({"lotSize": 50})  # hypothetical revised lot

        @contextlib.asynccontextmanager
        async def fake_get_redis(url):
            yield FakeRedis()

        monkeypatch.setattr(rc, "get_redis", fake_get_redis)
        assert self._run("CRUDEOIL", "2026-10-15", None, 2) == (100, None)
