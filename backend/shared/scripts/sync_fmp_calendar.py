"""Sync economic event calendar to Redis from free sources.

Sources:
  1. Nager.Date API — IN + US public holidays (free, no API key)
  2. RBI MPC policy dates (known annually, update in _RBI_MPC_DATES)
  3. FOMC decision dates (known annually, update in _FOMC_DATES)
  4. NSE monthly F&O expiry dates (computed: last Thursday of month)
"""

import asyncio
import calendar
import json
import logging
from datetime import UTC, date, datetime, timedelta

import httpx

from shared.config import BaseServiceSettings
from shared.redis_client import get_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

UNDERLYINGS = ["NIFTY", "BANKNIFTY"]
TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days

# ── Known policy dates (update once a year) ─────────────────────────
# RBI MPC decision dates — last day of each meeting window
# Source: https://rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx
_RBI_MPC_DATES: dict[int, list[str]] = {
    2025: [
        "2025-04-09", "2025-06-06", "2025-08-08",
        "2025-10-08", "2025-12-05",
    ],
    2026: [
        "2026-02-06", "2026-04-08", "2026-06-05",
        "2026-08-07", "2026-10-07", "2026-12-04",
    ],
}

# FOMC decision dates — announcement day (second day of meeting)
# Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
_FOMC_DATES: dict[int, list[str]] = {
    2025: [
        "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
        "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-17",
    ],
    2026: [
        "2026-01-28", "2026-03-18", "2026-05-06", "2026-06-17",
        "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-16",
    ],
}


# ── Nager.Date public holidays ──────────────────────────────────────

async def _fetch_holidays(
    client: httpx.AsyncClient, year: int, country: str
) -> list[dict[str, str]]:
    """Fetch public holidays from Nager.Date (free, no key)."""
    url = f"https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"
    try:
        resp = await client.get(url, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.warning("Failed to fetch %s/%d holidays: %s", country, year, e)
        return []

    events: list[dict[str, str]] = []
    for item in data:
        events.append({
            "date": item["date"],
            "label": item.get("localName") or item.get("name", "Holiday"),
            "type": "holiday",
        })
    return events


async def _fetch_all_holidays(
    client: httpx.AsyncClient, years: list[int]
) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    for year in years:
        for country in ("IN", "US"):
            holidays = await _fetch_holidays(client, year, country)
            events.extend(holidays)
            logger.info("Fetched %d %s holidays for %d", len(holidays), country, year)
        # Nager.Date may not have India — add NSE holidays as fallback
        in_count = sum(1 for e in events if any(
            e["date"].startswith(str(year)) for _ in [1]
        ))
        if in_count == 0 or not any(
            e["label"] in ("Republic Day", "गणतंत्र दिवस") and e["date"].startswith(str(year))
            for e in events
        ):
            events.extend(_nse_holiday_fallback(year))
    return events


# NSE observed holidays — update annually from NSE circular
# Source: https://www.nseindia.com/regulations/clearing-settlement/holidays
_NSE_HOLIDAYS: dict[int, list[tuple[str, str]]] = {
    2025: [
        ("02-26", "Maha_Shivaratri"),
        ("03-14", "Holi"),
        ("03-31", "Eid-ul-Fitr"),
        ("04-10", "Shri_Mahavir_Jayanti"),
        ("04-14", "Dr_Ambedkar_Jayanti"),
        ("04-18", "Good_Friday"),
        ("05-01", "Maharashtra_Day"),
        ("06-07", "Eid-ul-Adha"),
        ("08-15", "Independence_Day"),
        ("08-16", "Janmashtami"),
        ("10-02", "Mahatma_Gandhi_Jayanti"),
        ("10-20", "Diwali_Laxmi_Puja"),
        ("10-21", "Diwali_Balipratipada"),
        ("11-05", "Guru_Nanak_Jayanti"),
        ("12-25", "Christmas"),
    ],
    2026: [
        ("01-26", "Republic_Day"),
        ("02-17", "Maha_Shivaratri"),
        ("03-04", "Holi"),
        ("03-20", "Eid-ul-Fitr"),
        ("03-30", "Ugadi"),
        ("04-02", "Ram_Navami"),
        ("04-03", "Good_Friday"),
        ("04-14", "Dr_Ambedkar_Jayanti"),
        ("05-01", "Maharashtra_Day"),
        ("05-25", "Buddha_Purnima"),
        ("05-28", "Eid-ul-Adha"),
        ("08-15", "Independence_Day"),
        ("08-25", "Muharram"),
        ("10-02", "Mahatma_Gandhi_Jayanti"),
        ("10-08", "Dussehra"),
        ("10-24", "Prophet_Birthday"),
        ("11-09", "Diwali_Laxmi_Puja"),
        ("11-10", "Diwali_Balipratipada"),
        ("11-24", "Guru_Nanak_Jayanti"),
        ("12-25", "Christmas"),
    ],
}


def _nse_holiday_fallback(year: int) -> list[dict[str, str]]:
    holidays = _NSE_HOLIDAYS.get(year, [])
    if not holidays:
        logger.info("No NSE holiday fallback for %d", year)
        return []
    logger.info("Using %d NSE holiday fallback entries for %d", len(holidays), year)
    return [
        {"date": f"{year}-{md}", "label": label, "type": "holiday"}
        for md, label in holidays
    ]


# ── Computed NSE monthly expiry dates ───────────────────────────────

def _last_thursday(year: int, month: int) -> date:
    """Last Thursday of a given month."""
    cal = calendar.monthcalendar(year, month)
    # Walk weeks backwards to find last Thursday (index 3)
    for week in reversed(cal):
        if week[3] != 0:
            return date(year, month, week[3])
    return date(year, month, 1)  # fallback


def _compute_monthly_expiries(start: date, end: date) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    current = date(start.year, start.month, 1)
    while current <= end:
        expiry = _last_thursday(current.year, current.month)
        if start <= expiry <= end:
            events.append({
                "date": expiry.isoformat(),
                "label": "Monthly_F&O_Expiry",
                "type": "expiry",
            })
        # Advance to next month
        if current.month == 12:
            current = date(current.year + 1, 1, 1)
        else:
            current = date(current.year, current.month + 1, 1)
    return events


# ── Known policy dates ──────────────────────────────────────────────

def _collect_policy_dates(start: date, end: date) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    start_iso = start.isoformat()
    end_iso = end.isoformat()

    for year_dates in _RBI_MPC_DATES.values():
        for d in year_dates:
            if start_iso <= d <= end_iso:
                events.append({"date": d, "label": "RBI_MPC_Decision", "type": "policy"})

    for year_dates in _FOMC_DATES.values():
        for d in year_dates:
            if start_iso <= d <= end_iso:
                events.append({"date": d, "label": "FOMC_Decision", "type": "policy"})

    return events


# ── Main sync ───────────────────────────────────────────────────────

async def sync_event_calendar():
    """Aggregate events from all free sources and push to Redis."""
    settings = BaseServiceSettings()
    today = datetime.now(UTC).date()
    horizon = today + timedelta(days=60)
    years = sorted({today.year, horizon.year})

    all_events: list[dict[str, str]] = []

    async with httpx.AsyncClient() as client:
        all_events.extend(await _fetch_all_holidays(client, years))

    all_events.extend(_compute_monthly_expiries(today, horizon))
    all_events.extend(_collect_policy_dates(today, horizon))

    # Deduplicate: one entry per (date, type) for holidays, (date, label) for others
    seen: set[tuple[str, str]] = set()
    filtered: list[dict[str, str]] = []
    today_iso = today.isoformat()
    horizon_iso = horizon.isoformat()
    for ev in all_events:
        d = ev["date"]
        if d < today_iso or d > horizon_iso:
            continue
        key = (d, ev["type"]) if ev["type"] == "holiday" else (d, ev["label"])
        if key not in seen:
            seen.add(key)
            filtered.append(ev)

    filtered.sort(key=lambda x: x["date"])

    logger.info(
        "Collected %d events (%d holidays, rest policy/expiry) for next 60 days",
        len(filtered),
        sum(1 for e in filtered if e["type"] == "holiday"),
    )

    payload = json.dumps(filtered)

    async with get_redis(settings.redis_url) as redis:
        for underlying in UNDERLYINGS:
            key = f"cache:event_calendar:{underlying}"
            await redis.set(key, payload)
            await redis.expire(key, TTL_SECONDS)
            logger.info("Updated %s (%d events)", key, len(filtered))

    logger.info("Event calendar sync complete.")


if __name__ == "__main__":
    asyncio.run(sync_event_calendar())
