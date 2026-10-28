"""Idempotent schema migrations for existing deployments.

``init.sql`` only runs when the TimescaleDB volume is created fresh, so schema
changes need a startup-time path for databases that already exist. These run on
gateway startup and are safe to execute repeatedly.
"""

from __future__ import annotations

import structlog
from sqlalchemy import text

from shared.db import get_engine

log = structlog.get_logger()

_TRADE_LOGS_FILL_INDEX = "idx_trade_logs_fill"


async def ensure_trade_log_account_column(db_url: str, *, backfill_ucc: str = "") -> None:
    """Add ``trade_logs.ucc`` and re-key the dedup index to include it.

    Pre-existing rows predate multi-account support and can only have come from
    one account, so ``backfill_ucc`` (the sole configured account's UCC) claims
    them. When several accounts are configured the owner is ambiguous, so the
    rows keep ``''`` and are logged — they stay queryable by adding an account
    with a matching UCC, but are invisible to any account's P&L until then.
    """
    engine = get_engine(db_url)

    try:
        async with engine.begin() as conn:
            exists = await conn.scalar(text(
                "SELECT 1 FROM information_schema.tables WHERE table_name = 'trade_logs'"
            ))
            if not exists:
                log.debug("migrations.trade_logs_absent")
                return

            await conn.execute(text(
                "ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS ucc TEXT NOT NULL DEFAULT ''"
            ))

            if backfill_ucc:
                result = await conn.execute(
                    text("UPDATE trade_logs SET ucc = :ucc WHERE ucc = ''"),
                    {"ucc": backfill_ucc},
                )
                if result.rowcount:
                    log.info("migrations.trade_logs_backfilled",
                             rows=result.rowcount, ucc=backfill_ucc)
            else:
                orphans = await conn.scalar(text(
                    "SELECT count(*) FROM trade_logs WHERE ucc = ''"
                ))
                if orphans:
                    log.warning(
                        "migrations.trade_logs_unassigned",
                        rows=orphans,
                        hint="Untagged fills predate multi-account support and are "
                             "excluded from every account's P&L. Assign them with: "
                             "UPDATE trade_logs SET ucc = '<UCC>' WHERE ucc = '';",
                    )

            # The dedup index must include ucc, or two accounts sharing a
            # fill_id would collide and silently drop one account's fill.
            indexdef = await conn.scalar(
                text("SELECT indexdef FROM pg_indexes WHERE indexname = :name"),
                {"name": _TRADE_LOGS_FILL_INDEX},
            )
            if indexdef is None or "ucc" not in indexdef:
                await conn.execute(text(f"DROP INDEX IF EXISTS {_TRADE_LOGS_FILL_INDEX}"))
                await conn.execute(text(
                    f"CREATE UNIQUE INDEX {_TRADE_LOGS_FILL_INDEX} "
                    "ON trade_logs (time, ucc, fill_id, order_id)"
                ))
                log.info("migrations.trade_logs_index_rekeyed")

            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_trade_logs_ucc_symbol_time "
                "ON trade_logs (ucc, symbol, time DESC)"
            ))
    except Exception as exc:
        log.warning("migrations.trade_logs_failed", error=str(exc)[:300])
