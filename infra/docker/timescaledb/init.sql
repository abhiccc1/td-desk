-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Ticks hypertable
CREATE TABLE IF NOT EXISTS ticks (
    time        TIMESTAMPTZ      NOT NULL,
    symbol      TEXT             NOT NULL,
    exchange    TEXT             NOT NULL,
    ltp         DOUBLE PRECISION NOT NULL,
    bid         DOUBLE PRECISION,
    ask         DOUBLE PRECISION,
    bid_qty     INTEGER,
    ask_qty     INTEGER,
    volume      BIGINT,
    oi          BIGINT,
    turnover    DOUBLE PRECISION
);
SELECT create_hypertable('ticks', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON ticks (symbol, time DESC);

-- OHLCV continuous aggregate (1-minute)
CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    symbol,
    FIRST(ltp, time)              AS open,
    MAX(ltp)                      AS high,
    MIN(ltp)                      AS low,
    LAST(ltp, time)               AS close,
    SUM(volume)                   AS volume,
    LAST(oi, time)                AS oi
FROM ticks
GROUP BY bucket, symbol
WITH NO DATA;

-- IV history for IV Rank/Percentile computation
CREATE TABLE IF NOT EXISTS iv_history (
    time        TIMESTAMPTZ      NOT NULL,
    underlying  TEXT             NOT NULL,
    atm_iv      DOUBLE PRECISION NOT NULL,
    spot_price  DOUBLE PRECISION
);
SELECT create_hypertable('iv_history', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_iv_history_underlying_time ON iv_history (underlying, time DESC);

-- Trade logs — persistent record of every execution fill for FIFO P&L
CREATE TABLE IF NOT EXISTS trade_logs (
    time            TIMESTAMPTZ      NOT NULL,
    -- Broker account (UCC) the fill belongs to. Every read filters on it so
    -- switching accounts never merges one account's history into another's.
    ucc             TEXT             NOT NULL DEFAULT '',
    symbol          TEXT             NOT NULL,
    trading_symbol  TEXT             NOT NULL,
    underlying      TEXT,
    expiry          DATE,
    strike          DOUBLE PRECISION,
    option_type     CHAR(2),
    side            TEXT             NOT NULL,
    quantity        INTEGER          NOT NULL,
    price           DOUBLE PRECISION NOT NULL,
    value           DOUBLE PRECISION NOT NULL,
    order_id        TEXT             NOT NULL DEFAULT '',
    fill_id         TEXT             NOT NULL DEFAULT '',
    exchange        TEXT             NOT NULL,
    product_type    TEXT,
    multiplier      INTEGER          DEFAULT 1
);
SELECT create_hypertable('trade_logs', by_range('time'), if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_logs_fill ON trade_logs (time, ucc, fill_id, order_id);
CREATE INDEX IF NOT EXISTS idx_trade_logs_symbol_time ON trade_logs (ucc, symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_trade_logs_underlying_expiry ON trade_logs (ucc, underlying, expiry, time DESC);

-- Positions — current position state (source of truth, not time-series)
CREATE TABLE IF NOT EXISTS positions (
    trading_symbol  TEXT             PRIMARY KEY,
    symbol          TEXT             NOT NULL,
    exchange        TEXT,
    product_type    TEXT,
    option_type     TEXT,
    strike_price    TEXT,
    expiry          TEXT,
    lot_size        INTEGER          DEFAULT 1,
    total_buy_qty   INTEGER          DEFAULT 0,
    total_sell_qty  INTEGER          DEFAULT 0,
    net_qty         INTEGER          DEFAULT 0,
    cf_qty          INTEGER          DEFAULT 0,
    side            TEXT,
    is_open         BOOLEAN          DEFAULT true,
    total_buy_amt   DOUBLE PRECISION DEFAULT 0,
    total_sell_amt  DOUBLE PRECISION DEFAULT 0,
    buy_avg_price   DOUBLE PRECISION DEFAULT 0,
    sell_avg_price  DOUBLE PRECISION DEFAULT 0,
    avg_price       DOUBLE PRECISION DEFAULT 0,
    booked_pnl      DOUBLE PRECISION DEFAULT 0,
    multiplier      INTEGER          DEFAULT 1,
    precision       INTEGER          DEFAULT 2,
    updated_at      TIMESTAMPTZ      DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Paper trading — fully isolated from live trading.
-- Mirrors trade_logs / positions but written ONLY by the paper-trading router
-- (backend/api_gateway/api_gateway/routers/paper_trading.py), which never
-- touches the live broker.  Simulated fills happen at the live LTP from Redis.
-- ─────────────────────────────────────────────────────────────────────────

-- Paper trade logs — every simulated fill (append-only, mirror of trade_logs)
CREATE TABLE IF NOT EXISTS paper_trade_logs (
    time            TIMESTAMPTZ      NOT NULL,
    symbol          TEXT             NOT NULL,
    trading_symbol  TEXT             NOT NULL,
    underlying      TEXT,
    expiry          DATE,
    strike          DOUBLE PRECISION,
    option_type     CHAR(2),
    side            TEXT             NOT NULL,
    quantity        INTEGER          NOT NULL,
    price           DOUBLE PRECISION NOT NULL,
    value           DOUBLE PRECISION NOT NULL,
    order_id        TEXT             NOT NULL DEFAULT '',
    fill_id         TEXT             NOT NULL DEFAULT '',
    exchange        TEXT             NOT NULL,
    product_type    TEXT,
    multiplier      DOUBLE PRECISION DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_paper_trade_logs_symbol_time ON paper_trade_logs (symbol, time DESC);

-- Paper positions — current simulated position state (mirror of positions)
CREATE TABLE IF NOT EXISTS paper_positions (
    trading_symbol  TEXT             PRIMARY KEY,
    symbol          TEXT             NOT NULL,
    exchange        TEXT,
    product_type    TEXT,
    option_type     TEXT,
    strike_price    TEXT,
    expiry          TEXT,
    lot_size        INTEGER          DEFAULT 1,
    total_buy_qty   INTEGER          DEFAULT 0,
    total_sell_qty  INTEGER          DEFAULT 0,
    net_qty         INTEGER          DEFAULT 0,
    cf_qty          INTEGER          DEFAULT 0,
    side            TEXT,
    is_open         BOOLEAN          DEFAULT true,
    total_buy_amt   DOUBLE PRECISION DEFAULT 0,
    total_sell_amt  DOUBLE PRECISION DEFAULT 0,
    buy_avg_price   DOUBLE PRECISION DEFAULT 0,
    sell_avg_price  DOUBLE PRECISION DEFAULT 0,
    avg_price       DOUBLE PRECISION DEFAULT 0,
    booked_pnl      DOUBLE PRECISION DEFAULT 0,
    multiplier      DOUBLE PRECISION DEFAULT 1,
    precision       INTEGER          DEFAULT 2,
    updated_at      TIMESTAMPTZ      DEFAULT now()
);
