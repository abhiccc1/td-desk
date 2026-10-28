"""Risk assessment schemas for live portfolio and strategy analytics."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from shared.schemas.regime import RegimeSnapshot, TradeQualityAssessment
from shared.schemas.strategy import StrategyResult

RiskSeverity = Literal["safe", "elevated", "high", "critical"]
SuggestionConfidence = Literal["low", "medium", "high"]


class GreekExposure(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    delta: float = 0.0
    gamma: float = 0.0
    theta: float = 0.0
    vega: float = 0.0
    vanna: float = 0.0
    charm: float = 0.0
    vomma: float = 0.0


class RiskFlag(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    code: str
    severity: RiskSeverity
    title: str
    message: str
    underlying: str | None = None
    expiry: str | None = None


class AdjustmentSuggestion(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    rule_id: str
    severity: RiskSeverity
    title: str
    rationale: str
    action: str
    estimated_impact: str | None = None
    confidence: SuggestionConfidence = "medium"
    quality_rank: float | None = None
    prerequisites: list[str] = Field(default_factory=list)
    underlying: str | None = None
    expiry: str | None = None


AdjustmentActionType = Literal["roll", "add_wing", "close_partial", "convert"]


class AdjustmentLeg(BaseModel):
    """A single leg in a concrete adjustment recommendation."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    symbol: str
    strike: float
    option_type: str  # "CE" | "PE"
    expiry: str
    side: str  # "BUY" | "SELL"
    quantity: int
    estimated_price: float  # mid of bid/ask
    bid: float
    ask: float


class AdjustmentRecommendation(BaseModel):
    """A concrete, executable adjustment recommendation with scoring."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    id: str
    title: str
    description: str
    action_type: AdjustmentActionType
    legs: list[AdjustmentLeg]

    # Before/after comparison
    current_greeks: GreekExposure
    projected_greeks: GreekExposure
    current_max_loss: float | None = None
    projected_max_loss: float | None = None
    current_pop: float | None = None
    projected_pop: float | None = None

    # Scoring
    net_credit: float  # positive = credit, negative = debit
    efficiency_score: float
    profit_impact_pct: float  # % change in max profit
    risk_impact_pct: float  # % change in max loss (negative = improvement)

    # Context
    trigger: str  # what risk issue prompted this
    confidence: SuggestionConfidence = "medium"
    warnings: list[str] = Field(default_factory=list)


class ScenarioPnl(BaseModel):
    """P&L from full BSM repricing at a given sigma bound."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    spot_down: float
    spot_up: float
    pnl_down: float
    pnl_up: float
    worst_pnl: float


class StrategyTailRisk(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    expected_move: float | None = None
    expected_move_pct: float | None = None
    daily_expected_move: float | None = None
    daily_expected_move_pct: float | None = None
    one_sigma_delta_pnl: float | None = None
    one_sigma_gamma_pnl: float | None = None
    one_sigma_total_pnl: float | None = None
    projected_delta_down: float | None = None
    projected_delta_up: float | None = None
    spot: float | None = None
    atm_iv: float | None = None
    iv_rank: float | None = None
    vrp: float | None = None
    scenario_1s: ScenarioPnl | None = None
    scenario_2s: ScenarioPnl | None = None
    scenario_3s: ScenarioPnl | None = None


class ExpiryRiskSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiry: str
    spot: float | None = None
    dte: int | None = None
    position_count: int = 0
    lot_notional: float | None = None
    exposures: GreekExposure
    tail_risk: StrategyTailRisk = Field(default_factory=StrategyTailRisk)
    risk_level: RiskSeverity
    flags: list[RiskFlag] = Field(default_factory=list)
    strategy: StrategyResult | None = None


class UnderlyingRiskSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    spot: float | None = None
    atm_iv: float | None = None
    iv_rank: float | None = None
    vrp: float | None = None
    position_count: int = 0
    expiry_count: int = 0
    exposures: GreekExposure
    tail_risk: StrategyTailRisk = Field(default_factory=StrategyTailRisk)
    risk_level: RiskSeverity
    flags: list[RiskFlag] = Field(default_factory=list)
    suggestions: list[AdjustmentSuggestion] = Field(default_factory=list)
    regime_snapshot: RegimeSnapshot | None = None
    trade_quality: TradeQualityAssessment | None = None
    expiries: list[ExpiryRiskSummary] = Field(default_factory=list)
    strategy: StrategyResult | None = None
    margin_estimate: float | None = None
    account_net_share: float | None = None
    margin_utilization: float | None = None


class PortfolioRiskResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    as_of: datetime
    account_net: float | None = None
    available_margin: float | None = None
    margin_used: float | None = None
    collateral: float | None = None
    position_count: int = 0
    underlying_count: int = 0
    expiry_count: int = 0
    exposures: GreekExposure
    risk_level: RiskSeverity
    flags: list[RiskFlag] = Field(default_factory=list)
    suggestions: list[AdjustmentSuggestion] = Field(default_factory=list)
    underlyings: list[UnderlyingRiskSummary] = Field(default_factory=list)
