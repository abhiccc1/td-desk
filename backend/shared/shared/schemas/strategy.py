"""Multi-leg strategy schemas: legs, margin, breakeven, PoP."""

from pydantic import BaseModel


class StrategyLeg(BaseModel):
    symbol: str
    strike: float
    option_type: str  # "C" or "P"
    side: str  # "BUY" or "SELL"
    quantity: int
    premium: float


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
