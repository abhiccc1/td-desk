"""Market tick data and option chain snapshot schemas."""

from datetime import datetime
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class TickData(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    symbol: str
    exchange: str
    ltp: float
    bid: float | None = None
    ask: float | None = None
    bid_qty: int | None = None
    ask_qty: int | None = None
    volume: int | None = None
    oi: int | None = None
    turnover: float | None = None
    timestamp: datetime


class OptionStrike(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    strike: float
    call: TickData | None = None
    put: TickData | None = None


class OptionChainSnapshot(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    underlying_price: float
    expiry: str
    exchange: str
    strikes: list[OptionStrike]
    timestamp: datetime
    source_timestamp: datetime | None = None
    # Options-on-futures only: the future this expiry devolves into
    # ({"symbol", "tradingSymbol", "token", "expiry"}); underlying_price is its LTP.
    underlying_future: dict[str, str] | None = None
    # Analytics tiers the connected clients actually asked for, as the union of
    # their demand claims. quant_service runs only the indicators a listed tier
    # covers, so a client that renders nothing but quotes (the mobile app) costs
    # no IV solve, SVI fit, Heston/VG calibration or FFT pricing at all. None
    # means no client has stated a need, and every tier runs — failing toward
    # the full pipeline rather than silently starving a panel of its data.
    analytics: list[str] | None = None
