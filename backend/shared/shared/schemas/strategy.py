"""Multi-leg strategy schemas: legs, margin, breakeven, PoP."""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from shared.schemas.regime import RegimeSnapshot, TradeQualityAssessment


class StrategyLeg(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    symbol: str
    strike: float
    option_type: str  # "C" or "P"
    side: str  # "BUY" or "SELL"
    quantity: int
    premium: float
    underlying: str | None = None  # e.g. "NIFTY" — used for RND PoP
    expiry: str | None = None      # e.g. "2026-03-19" — used for RND PoP
    spot: float | None = None      # current underlying price — used for RND PoP


class MarginInfo(BaseModel):
    initial_margin: float
    maintenance_margin: float
    collateral_utilization: float  # 0.0–1.0


class StrategyResult(BaseModel):
    legs: list[StrategyLeg]
    net_credit: float
    max_profit: float | None = None
    max_loss: float | None = None
    breakeven_points: list[float]
    probability_of_profit: float  # 0.0–1.0
    margin: MarginInfo
    payoff_x: list[float]  # underlying price range
    payoff_y: list[float]  # P&L at each price
    risk_neutral_pop: float | None = None   # RND-based PoP (0.0–1.0)
    vg_pop: float | None = None              # VG model PoP (0.0–1.0)
    density_x: list[float] | None = None    # same as payoff_x
    density_y: list[float] | None = None    # risk-neutral density values
    var_5: float | None = None               # 5th percentile VaR
    es_5: float | None = None                # Expected Shortfall at 5%
    market_pop: float | None = None          # BSM market-implied PoP
    pop_edge: float | None = None            # model PoP - market PoP
    regime_snapshot: RegimeSnapshot | None = None
    trade_quality: TradeQualityAssessment | None = None
