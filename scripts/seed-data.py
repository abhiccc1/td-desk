"""Seed TimescaleDB with sample options data for local development."""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import asyncpg


async def seed():
    db_url = os.getenv(
        "TIMESCALEDB_URL",
        "postgresql://trader:trader@localhost:5432/tradingdb",
    )
    conn = await asyncpg.connect(db_url)

    now = datetime.now(timezone.utc)
    underlying_price = 23500.0
    symbols = []

    # Generate sample NIFTY option chain
    for offset in range(-10, 11):
        strike = underlying_price + offset * 100
        for opt_type, suffix in [("C", "CE"), ("P", "PE")]:
            symbol = f"NIFTY25MAR26{strike:.0f}{suffix}"
            symbols.append((symbol, strike, opt_type))

    # Insert sample ticks
    tick_rows = []
    for symbol, strike, opt_type in symbols:
        for i in range(60):  # 1 minute of second-level ticks
            t = now - timedelta(seconds=60 - i)
            ltp = max(10.0, abs(underlying_price - strike) + (i % 10) * 0.5)
            tick_rows.append(
                (t, symbol, "NSE", ltp, ltp - 0.5, ltp + 0.5, 100, 100, 1000 + i, 50000, ltp * 1000)
            )

    await conn.executemany(
        """INSERT INTO ticks (time, symbol, exchange, ltp, bid, ask, bid_qty, ask_qty, volume, oi, turnover)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)""",
        tick_rows,
    )
    print(f"Inserted {len(tick_rows)} tick rows")

    # Insert sample greeks
    greeks_rows = []
    for symbol, strike, opt_type in symbols:
        greeks_rows.append((
            now, symbol, "NIFTY", datetime(2026, 3, 25).date(), strike, opt_type,
            0.18, 0.5 if opt_type == "C" else -0.5,
            0.002, -5.5, 12.0, underlying_price,
        ))

    await conn.executemany(
        """INSERT INTO greeks (time, symbol, underlying, expiry, strike, option_type, iv, delta, gamma, theta, vega, underlying_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)""",
        greeks_rows,
    )
    print(f"Inserted {len(greeks_rows)} greeks rows")

    await conn.close()
    print("Seed complete.")


if __name__ == "__main__":
    asyncio.run(seed())
