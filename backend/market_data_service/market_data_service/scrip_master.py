"""Kotak Neo scrip master downloader and parser.

Downloads the F&O scrip master CSV after authentication, extracts option
instrument tokens grouped by underlying/expiry, and caches expiry dates
in Redis for the frontend to query.
"""

from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from datetime import datetime, timezone

import httpx
import structlog

from shared.instruments import InstrumentMaster, get_instrument_master
from shared.redis_client import get_redis
from shared.schemas.auth import BrokerCredentials

logger = structlog.get_logger()


# Scrip master endpoints — try NAPI first, then standard production
_SCRIP_MASTER_PATHS = [
    "Files/1.0/masterscrip/v2/file-paths",
    "script-details/1.0/masterscrip/file-paths",
]


class ScripMasterResult:
    """Parsed result from scrip master download."""

    def __init__(self) -> None:
        # underlying -> sorted list of expiry date strings (YYYY-MM-DD)
        self.expiries: dict[str, list[str]] = defaultdict(list)
        # underlying -> {expiry -> list of "{segment}|token" subscription strings}
        self.tokens: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        # token -> symbol name mapping for tick parsing
        self.token_to_symbol: dict[str, str] = {}
        # underlying -> {expiry -> {"{strike}:{optionType}" -> pTrdSymbol}}
        self.trading_symbols: dict[str, dict[str, dict[str, str]]] = defaultdict(lambda: defaultdict(dict))
        # underlying -> {expiry -> {"{strike}:{optionType}" -> numeric pSymbol token}}
        self.scrip_tokens: dict[str, dict[str, dict[str, str]]] = defaultdict(lambda: defaultdict(dict))
        # pTrdSymbol -> numeric pSymbol token (flat reverse lookup)
        self.trdsym_to_token: dict[str, str] = {}


async def fetch_and_parse_scrip_master(
    credentials: BrokerCredentials,
    redis_url: str,
    consumer_key: str = "",
    instruments: InstrumentMaster | None = None,
) -> ScripMasterResult:
    """Download the F&O scrip master, parse it, and cache expiries in Redis."""
    result = ScripMasterResult()
    im = instruments or get_instrument_master()

    base_url = credentials.extra.get("base_url", "")
    if not base_url:
        logger.warning("scrip_master.no_base_url", msg="Cannot fetch scrip master without base_url")
        return result

    # Normalise base_url
    if not base_url.startswith("http"):
        base_url = f"https://{base_url}"
    base_url = base_url.rstrip("/")

    access_token = credentials.access_token.get_secret_value()
    sid = credentials.extra.get("sid", "")

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Step 1: Get file paths (try multiple endpoint paths)
        file_paths: list[str] = []
        for path in _SCRIP_MASTER_PATHS:
            file_paths = await _fetch_file_paths(
                client, base_url, access_token, sid, consumer_key, path
            )
            if file_paths:
                break
        if not file_paths:
            logger.warning("scrip_master.no_file_paths")
            return result

        # Step 2: Find and download CSVs for each enabled segment
        target_segments = im.segments()
        logger.info("scrip_master.segments_to_fetch",
                     segments=sorted(target_segments),
                     file_paths=[fp.rsplit("/", 1)[-1] for fp in file_paths])
        for seg in target_segments:
            seg_url = None
            for fp in file_paths:
                if seg in fp.lower():
                    seg_url = fp
                    break
            if not seg_url:
                logger.warning("scrip_master.no_segment_csv", segment=seg, paths=file_paths)
                continue
            logger.info("scrip_master.downloading_segment", segment=seg, url=seg_url)
            csv_text = await _download_csv(client, seg_url)
            if csv_text:
                _parse_csv(csv_text, result, im)

    # Step 3: Cache expiries and trading symbols in Redis
    await _cache_scrip_data(redis_url, result)

    logger.info(
        "scrip_master.parsed",
        underlyings=list(result.expiries.keys()),
        total_tokens=sum(
            len(tokens)
            for expiry_tokens in result.tokens.values()
            for tokens in expiry_tokens.values()
        ),
    )
    return result


async def _fetch_file_paths(
    client: httpx.AsyncClient,
    base_url: str,
    access_token: str,
    sid: str,
    consumer_key: str,
    path: str = "",
) -> list[str]:
    """Fetch scrip master file paths from the Kotak API."""
    url = f"{base_url}/{path}"
    # Kotak SDK uses consumer_key as Authorization for scrip master
    headers = {
        "Authorization": consumer_key or f"Bearer {access_token}",
        "Sid": sid,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    try:
        resp = await client.get(url, headers=headers)
        logger.info("scrip_master.file_paths_attempt", url=url, status=resp.status_code)
        if resp.status_code != 200:
            logger.warning(
                "scrip_master.file_paths_failed",
                url=url,
                status=resp.status_code,
                body=resp.text[:500],
            )
            return []
        data = resp.json()
        paths = data.get("data", {}).get("filesPaths", [])
        if not paths:
            # Some responses nest differently
            paths = data.get("filesPaths", [])
        if isinstance(paths, list):
            logger.info("scrip_master.file_paths_ok", count=len(paths))
            return paths
        return []
    except Exception:
        logger.exception("scrip_master.file_paths_error", url=url)
        return []


async def _download_csv(client: httpx.AsyncClient, url: str) -> str | None:
    """Download a CSV file from the given URL."""
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            logger.warning("scrip_master.csv_download_failed", status=resp.status_code, url=url)
            return None
        return resp.text
    except Exception:
        logger.exception("scrip_master.csv_download_error", url=url)
        return None


def _parse_csv(csv_text: str, result: ScripMasterResult, im: InstrumentMaster) -> None:
    """Parse a segment's scrip master CSV and populate result."""
    reader = csv.DictReader(io.StringIO(csv_text))
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    tracked = im.tracked_names()

    for row in reader:
        underlying = row.get("pSymbolName", "").strip().upper()
        if underlying not in tracked:
            continue

        cfg = im.get(underlying)
        if cfg is None:
            continue

        inst_type = row.get("pInstType", "").strip()
        if inst_type != cfg.instrument_type:
            continue

        token = row.get("pSymbol", "").strip()
        if not token:
            continue

        option_type = row.get("pOptionType", "").strip()
        scrip_ref = row.get("pScripRefKey", "").strip()

        # Parse expiry from pScripRefKey (e.g. "NIFTY28APR2623050.00CE" → 28APR26)
        # Kotak epoch timestamps have a 10-year offset bug, so parse from ref key
        expiry_str = _parse_expiry_from_ref(scrip_ref, underlying)
        if not expiry_str:
            continue

        # Skip expired instruments
        if expiry_str < today_str:
            continue

        # Parse strike price (column has semicolon in name)
        strike_raw = row.get("dStrikePrice;", "").strip()

        # Store Kotak trading symbol and numeric token for order placement
        trd_sym = row.get("pTrdSymbol", "").strip()
        if option_type and strike_raw:
            try:
                strike_for_key = float(strike_raw) / 100 if strike_raw else 0
                strike_key = int(strike_for_key) if strike_for_key == int(strike_for_key) else strike_for_key
                cache_field = f"{strike_key}:{option_type}"
                if trd_sym:
                    result.trading_symbols[underlying][expiry_str][cache_field] = trd_sym
                    if token:
                        result.trdsym_to_token[trd_sym] = token
                if token:
                    result.scrip_tokens[underlying][expiry_str][cache_field] = token
            except (ValueError, TypeError):
                pass

        # Build subscription token using the underlying's segment prefix
        sub_token = f"{cfg.segment}|{token}"
        result.tokens[underlying][expiry_str].append(sub_token)

        # Build symbol name for tick parsing: "NIFTY 260319 22000 CE"
        expiry_compact = expiry_str.replace("-", "")[2:]  # "260319" from "2026-03-19"
        try:
            strike_val = float(strike_raw) / 100 if strike_raw else 0
            strike_int = int(strike_val) if strike_val == int(strike_val) else strike_val
        except (ValueError, TypeError):
            strike_int = 0
        symbol_name = f"{underlying} {expiry_compact} {strike_int} {option_type}"
        result.token_to_symbol[token] = symbol_name

    # Sort expiries per underlying and keep all for caching (dropdown needs them)
    for underlying in list(result.tokens.keys()):
        sorted_expiries = sorted(result.tokens[underlying].keys())
        result.expiries[underlying] = sorted_expiries


# Pattern to extract date from suffix after underlying is stripped
# e.g. "30MAR2614250.00CE" → day=30, mon=MAR, year=26
_REF_DATE_RE = re.compile(
    r"^(\d{1,2})([A-Z]{3})(\d{2})",
    re.IGNORECASE,
)

_MONTH_MAP = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


def _parse_expiry_from_ref(ref_key: str, underlying: str) -> str | None:
    """Extract expiry date from pScripRefKey like 'NIFTY28APR2623050.00CE' → '2026-04-28'."""
    # Strip the underlying prefix to find the date portion
    suffix = ref_key[len(underlying):] if ref_key.upper().startswith(underlying) else ref_key
    m = _REF_DATE_RE.match(suffix)
    if not m:
        return None
    day_str, mon_str, year_str = m.group(1), m.group(2).upper(), m.group(3)
    month = _MONTH_MAP.get(mon_str)
    if not month:
        return None
    try:
        year = 2000 + int(year_str)
        day = int(day_str)
        dt = datetime(year, month, day)
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None




async def _cache_scrip_data(redis_url: str, result: ScripMasterResult) -> None:
    """Store expiry dates and trading symbols per underlying in Redis."""
    async with get_redis(redis_url) as client:
        pipe = client.pipeline()
        for underlying, expiries in result.expiries.items():
            key = f"cache:expiries:{underlying}"
            pipe.delete(key)
            if expiries:
                pipe.sadd(key, *expiries)
                pipe.expire(key, 86400)  # 24h TTL

        # Cache trading symbols per underlying/expiry for order placement
        for underlying, expiry_map in result.trading_symbols.items():
            for expiry, sym_map in expiry_map.items():
                if sym_map:
                    key = f"cache:scrip:trdsym:{underlying}:{expiry}"
                    pipe.delete(key)
                    pipe.hset(key, mapping=sym_map)
                    pipe.expire(key, 86400)  # 24h TTL

        # Cache numeric scrip tokens per underlying/expiry for margin API
        for underlying, expiry_map in result.scrip_tokens.items():
            for expiry, tok_map in expiry_map.items():
                if tok_map:
                    key = f"cache:scrip:token:{underlying}:{expiry}"
                    pipe.delete(key)
                    pipe.hset(key, mapping=tok_map)
                    pipe.expire(key, 86400)  # 24h TTL

        # Flat reverse lookup: tradingSymbol → numeric token
        if result.trdsym_to_token:
            pipe.delete("cache:scrip:sym2tok")
            pipe.hset("cache:scrip:sym2tok", mapping=result.trdsym_to_token)
            pipe.expire("cache:scrip:sym2tok", 86400)

        await pipe.execute()
    logger.info(
        "scrip_master.scrip_data_cached",
        underlyings=list(result.expiries.keys()),
        trading_symbol_keys=sum(
            len(sym_map)
            for expiry_map in result.trading_symbols.values()
            for sym_map in expiry_map.values()
        ),
    )


