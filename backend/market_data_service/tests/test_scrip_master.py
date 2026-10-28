"""Tests for scrip master parsing and trading symbol extraction."""

from __future__ import annotations

import pytest

from market_data_service import scrip_master
from market_data_service.scrip_master import (
    ScripMasterResult,
    _parse_csv,
    _parse_expiry_from_ref,
)
from shared.instruments import InstrumentMaster

# Use the real instruments.json
from pathlib import Path

INSTRUMENTS_PATH = Path(__file__).resolve().parents[3] / "data" / "instruments.json"


class TestParseExpiryFromRef:
    def test_nifty_ref_key(self):
        assert _parse_expiry_from_ref("NIFTY28APR2623050.00CE", "NIFTY") == "2026-04-28"

    def test_banknifty_ref_key(self):
        assert _parse_expiry_from_ref("BANKNIFTY19MAR2643000.00PE", "BANKNIFTY") == "2026-03-19"

    def test_single_digit_day(self):
        assert _parse_expiry_from_ref("NIFTY3JAN2622000.00CE", "NIFTY") == "2026-01-03"

    def test_invalid_ref_key(self):
        assert _parse_expiry_from_ref("GARBAGE", "NIFTY") is None

    def test_empty_ref_key(self):
        assert _parse_expiry_from_ref("", "NIFTY") is None

    def test_case_insensitive_month(self):
        result = _parse_expiry_from_ref("NIFTY17mar2623100.00CE", "NIFTY")
        assert result == "2026-03-17"

    def test_sensex_ref_key(self):
        assert _parse_expiry_from_ref("SENSEX21FEB2680000.00CE", "SENSEX") == "2026-02-21"


class TestParseCsv:
    """Test _parse_csv with minimal synthetic CSV data."""

    HEADER = "pSymbolName,pInstType,pSymbol,pOptionType,pScripRefKey,dStrikePrice;,pTrdSymbol\n"

    def _make_csv(self, *rows: str) -> str:
        return self.HEADER + "\n".join(rows) + "\n"

    @pytest.fixture
    def im(self):
        return InstrumentMaster(INSTRUMENTS_PATH)

    @pytest.fixture(autouse=True)
    def _pin_today(self, monkeypatch):
        # Fixture expiries are in 2026; pin "today" so they stay unexpired.
        monkeypatch.setattr(scrip_master, "_today_ist", lambda: "2026-01-01")

    def test_basic_parsing(self, im):
        csv = self._make_csv(
            "NIFTY,OPTIDX,12345,CE,NIFTY19MAR2623100.00CE,2310000,NIFTY19MAR23100CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        assert "NIFTY" in result.expiries
        assert "2026-03-19" in result.expiries["NIFTY"]

    def test_trading_symbol_cached(self, im):
        csv = self._make_csv(
            "NIFTY,OPTIDX,12345,CE,NIFTY19MAR2623100.00CE,2310000,NIFTY19MAR23100CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        # Should have trading symbol for strike 23100 CE
        assert "NIFTY" in result.trading_symbols
        assert "2026-03-19" in result.trading_symbols["NIFTY"]
        assert result.trading_symbols["NIFTY"]["2026-03-19"]["23100:CE"] == "NIFTY19MAR23100CE"

    def test_put_option(self, im):
        csv = self._make_csv(
            "NIFTY,OPTIDX,12346,PE,NIFTY19MAR2623000.00PE,2300000,NIFTY19MAR23000PE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        assert result.trading_symbols["NIFTY"]["2026-03-19"]["23000:PE"] == "NIFTY19MAR23000PE"

    def test_multiple_strikes(self, im):
        csv = self._make_csv(
            "NIFTY,OPTIDX,12345,CE,NIFTY19MAR2623100.00CE,2310000,NIFTY19MAR23100CE",
            "NIFTY,OPTIDX,12346,CE,NIFTY19MAR2623200.00CE,2320000,NIFTY19MAR23200CE",
            "NIFTY,OPTIDX,12347,PE,NIFTY19MAR2623100.00PE,2310000,NIFTY19MAR23100PE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        sym_map = result.trading_symbols["NIFTY"]["2026-03-19"]
        assert sym_map["23100:CE"] == "NIFTY19MAR23100CE"
        assert sym_map["23200:CE"] == "NIFTY19MAR23200CE"
        assert sym_map["23100:PE"] == "NIFTY19MAR23100PE"

    def test_token_to_symbol_mapping(self, im):
        csv = self._make_csv(
            "NIFTY,OPTIDX,12345,CE,NIFTY19MAR2623100.00CE,2310000,NIFTY19MAR23100CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        assert "12345" in result.token_to_symbol
        # Format: "NIFTY 260319 23100 CE"
        assert result.token_to_symbol["12345"] == "NIFTY 260319 23100 CE"

    def test_untracked_underlying_ignored(self, im):
        csv = self._make_csv(
            "RANDOMSTOCK,OPTSTK,99999,CE,RANDOMSTOCK19MAR2623100.00CE,2310000,RANDOM19MAR23100CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        assert "RANDOMSTOCK" not in result.expiries
        assert "RANDOMSTOCK" not in result.trading_symbols

    def test_wrong_instrument_type_ignored(self, im):
        """NIFTY with instrument type FUTSTK should be ignored."""
        csv = self._make_csv(
            "NIFTY,FUTSTK,12345,CE,NIFTY19MAR2623100.00CE,2310000,NIFTY19MAR23100CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        assert "NIFTY" not in result.expiries

    def test_expired_instruments_skipped(self, im):
        """Instruments with past expiry dates should be skipped."""
        csv = self._make_csv(
            "NIFTY,OPTIDX,12345,CE,NIFTY01JAN2023100.00CE,2310000,NIFTY01JAN23100CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        # 2020-01-01 is in the past
        assert len(result.expiries.get("NIFTY", [])) == 0

    def test_banknifty_parsing(self, im):
        csv = self._make_csv(
            "BANKNIFTY,OPTIDX,22222,CE,BANKNIFTY19MAR2643000.00CE,4300000,BANKNIFTY19MAR43000CE",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        assert result.trading_symbols["BANKNIFTY"]["2026-03-19"]["43000:CE"] == "BANKNIFTY19MAR43000CE"

    def test_missing_trd_symbol_column(self, im):
        """If pTrdSymbol is empty, trading_symbols should still not crash."""
        csv = self._make_csv(
            "NIFTY,OPTIDX,12345,CE,NIFTY19MAR2623100.00CE,2310000,",
        )
        result = ScripMasterResult()
        _parse_csv(csv, result, im)

        # Tokens should still be parsed
        assert "NIFTY" in result.tokens
        # But trading symbol for this entry won't be cached (empty pTrdSymbol)
        sym_map = result.trading_symbols.get("NIFTY", {}).get("2026-03-19", {})
        assert "23100:CE" not in sym_map


# ---------------------------------------------------------------------------
# MCX options-on-futures. Fixture rows are copied verbatim from Kotak's
# mcx_fo.csv of 2026-09-25 (pScripRefKey empty, sci-notation strikes).
# ---------------------------------------------------------------------------

MCX_FIXTURE = Path(__file__).parent / "fixtures" / "mcx_fo_sample.csv"


class TestParseMcx:
    @pytest.fixture
    def im(self, monkeypatch):
        monkeypatch.setenv("MCX_ENABLED", "1")
        return InstrumentMaster(INSTRUMENTS_PATH)

    @pytest.fixture(autouse=True)
    def _pin_today(self, monkeypatch):
        monkeypatch.setattr(scrip_master, "_today_ist", lambda: "2026-09-25")

    @pytest.fixture
    def result(self, im):
        result = ScripMasterResult()
        _parse_csv(MCX_FIXTURE.read_text(), result, im)
        return result

    def test_flag_off_ignores_mcx(self, monkeypatch):
        monkeypatch.delenv("MCX_ENABLED", raising=False)
        result = ScripMasterResult()
        _parse_csv(MCX_FIXTURE.read_text(), result, InstrumentMaster(INSTRUMENTS_PATH))
        assert not result.expiries

    def test_only_requested_symbols(self, result):
        assert set(result.expiries) == {
            "CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI", "GOLD", "GOLDM",
        }

    def test_expiries_from_epoch(self, result):
        assert result.expiries["CRUDEOIL"] == ["2026-10-15", "2026-11-17", "2026-12-16"]
        assert result.expiries["NATURALGAS"] == ["2026-10-23", "2026-11-20"]
        # Expiring today is still listed
        assert result.expiries["GOLD"][0] == "2026-09-25"

    def test_sci_notation_strike_and_trading_symbol(self, result):
        assert result.trading_symbols["GOLD"]["2026-11-27"]["154000:CE"] == "GOLD27NOV26154000CE"
        assert result.trading_symbols["CRUDEOIL"]["2026-11-17"]["10000:CE"] == "CRUDEOIL17NOV2610000CE"
        assert result.scrip_tokens["GOLD"]["2026-11-27"]["154000:CE"] == "556648"
        assert result.token_to_symbol["556648"] == "GOLD 261127 154000 CE"
        assert result.token_segment["556648"] == "mcx_fo"

    def test_underlying_future_from_asset_code(self, result):
        uf = result.underlying_future
        assert uf["CRUDEOIL"]["2026-11-17"]["tradingSymbol"] == "CRUDEOIL19NOV26FUT"
        assert uf["CRUDEOIL"]["2026-11-17"]["token"] == "573422"
        # GOLD Oct and Nov options both devolve into the DEC future
        assert uf["GOLD"]["2026-10-30"]["tradingSymbol"] == "GOLD04DEC26FUT"
        assert uf["GOLD"]["2026-11-27"]["tradingSymbol"] == "GOLD04DEC26FUT"
        assert uf["NATURALGAS"]["2026-10-23"]["expiry"] == "2026-10-27"

    def test_future_token_subscribed_with_chain(self, result):
        assert "mcx_fo|573422" in result.tokens["CRUDEOIL"]["2026-11-17"]
        assert result.token_to_symbol["573422"] == "CRUDEOIL 261119 FUT"

    @pytest.mark.parametrize("underlying,expiry,lot,mult,max_qty", [
        ("CRUDEOIL", "2026-10-15", 100, 100, 10000),
        ("CRUDEOILM", "2026-10-15", 10, 10, 10000),
        ("NATURALGAS", "2026-10-23", 1250, 1250, 60000),
        ("NATGASMINI", "2026-10-23", 250, 250, 60000),
        ("GOLD", "2026-10-30", 1, 100, 100),
        ("GOLDM", "2026-10-29", 100, 10, 10000),
    ])
    def test_contract_meta(self, result, im, underlying, expiry, lot, mult, max_qty):
        meta = result.contract_meta[underlying][expiry]
        assert (meta["lotSize"], meta["pnlMultiplier"], meta["maxOrderQty"]) == (lot, mult, max_qty)
        cfg = im.get(underlying)
        # instruments.json must agree with the scrip master
        assert (cfg.lot_size, cfg.effective_pnl_multiplier, cfg.freeze_quantity) == (lot, mult, max_qty)

    def test_epoch_symbol_mismatch_drops_row(self, im):
        # Corrupt the epoch for one option: 27NOV26 → a day later
        lines = MCX_FIXTURE.read_text().splitlines()
        for i, line in enumerate(lines):
            if "GOLD27NOV26154000CE" in line:
                lines[i] = line.replace("1795823999", "1795910399")
        result = ScripMasterResult()
        _parse_csv("\n".join(lines) + "\n", result, im)
        assert "154000:CE" not in result.trading_symbols["GOLD"]["2026-11-27"]
        assert "158000:CE" in result.trading_symbols["GOLD"]["2026-11-27"]

    def test_missing_future_drops_expiry(self, im):
        lines = [
            ln for ln in MCX_FIXTURE.read_text().splitlines()
            if "CRUDEOIL19NOV26FUT" not in ln
        ]
        result = ScripMasterResult()
        _parse_csv("\n".join(lines) + "\n", result, im)
        assert "2026-11-17" not in result.expiries["CRUDEOIL"]
        assert "2026-10-15" in result.expiries["CRUDEOIL"]
        # The mini is untouched (it has its own future)
        assert "2026-11-17" in result.expiries["CRUDEOILM"]
