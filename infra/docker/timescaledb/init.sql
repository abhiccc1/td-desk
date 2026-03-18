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

-- Greeks hypertable
CREATE TABLE IF NOT EXISTS greeks (
    time             TIMESTAMPTZ      NOT NULL,
    symbol           TEXT             NOT NULL,
    underlying       TEXT             NOT NULL,
    expiry           DATE             NOT NULL,
    strike           DOUBLE PRECISION NOT NULL,
    option_type      CHAR(1)          NOT NULL,
    iv               DOUBLE PRECISION,
    delta            DOUBLE PRECISION,
    gamma            DOUBLE PRECISION,
    theta            DOUBLE PRECISION,
    vega             DOUBLE PRECISION,
    underlying_price DOUBLE PRECISION
);
SELECT create_hypertable('greeks', by_range('time'), if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS greeks_time_symbol_unique ON greeks (time, symbol);
CREATE INDEX IF NOT EXISTS idx_greeks_symbol_time ON greeks (symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_greeks_underlying_expiry ON greeks (underlying, expiry, time DESC);

-- IV history for IV Rank/Percentile computation
CREATE TABLE IF NOT EXISTS iv_history (
    time        TIMESTAMPTZ      NOT NULL,
    underlying  TEXT             NOT NULL,
    atm_iv      DOUBLE PRECISION NOT NULL,
    spot_price  DOUBLE PRECISION
);
SELECT create_hypertable('iv_history', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_iv_history_underlying_time ON iv_history (underlying, time DESC);

-- Order events audit log
CREATE TABLE IF NOT EXISTS order_events (
    time            TIMESTAMPTZ NOT NULL,
    order_id        UUID        NOT NULL,
    basket_id       UUID,
    user_id         TEXT        NOT NULL,
    symbol          TEXT        NOT NULL,
    side            TEXT        NOT NULL,
    order_type      TEXT        NOT NULL,
    quantity         INTEGER     NOT NULL,
    price           DOUBLE PRECISION,
    filled_qty      INTEGER     DEFAULT 0,
    avg_fill_price  DOUBLE PRECISION,
    status          TEXT        NOT NULL,
    exchange        TEXT        NOT NULL,
    broker_order_id TEXT
);
SELECT create_hypertable('order_events', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_orders_user_time ON order_events (user_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_orders_basket ON order_events (basket_id, time DESC);

-- Portfolio snapshots
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    time           TIMESTAMPTZ    NOT NULL,
    user_id        TEXT           NOT NULL,
    net_delta      DOUBLE PRECISION,
    net_gamma      DOUBLE PRECISION,
    net_theta      DOUBLE PRECISION,
    net_vega       DOUBLE PRECISION,
    total_margin   DOUBLE PRECISION,
    unrealized_pnl DOUBLE PRECISION,
    var_95         DOUBLE PRECISION,
    positions_json JSONB
);
SELECT create_hypertable('portfolio_snapshots', by_range('time'), if_not_exists => TRUE);
