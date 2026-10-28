"""Schemas for volatility regime state and trade-quality assessment."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

RegimeLabel = Literal[
    "compressed",
    "balanced",
    "elevated",
    "stressed",
    "event_rich",
    "unknown",
]
RegimeConfidence = Literal["low", "medium", "high"]
TradeStyle = Literal[
    "short_vol_carry",
    "long_convexity",
    "calendar_term_structure",
    "directional_bull",
    "directional_bear",
    "neutral",
    "unknown",
]
TradeQualityLabel = Literal["poor", "mixed", "favorable", "strong", "unknown"]


class RegimeSnapshot(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiry: str | None = None
    as_of: datetime | None = None
    spot: float | None = None
    atm_iv: float | None = None
    iv_rank: float | None = None
    vrp: float | None = None
    daily_expected_move_pct: float | None = None
    term_structure_slope: float | None = None
    event_premium: float | None = None
    skew_indicator: float | None = None
    convexity_indicator: float | None = None
    term_structure_slope_pctile: float | None = None
    skew_indicator_pctile: float | None = None
    convexity_indicator_pctile: float | None = None
    event_tags: list[str] = Field(default_factory=list)
    regime_label: RegimeLabel = "unknown"
    confidence: RegimeConfidence = "low"
    drivers: list[str] = Field(default_factory=list)


class TradeQualityAssessment(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    style: TradeStyle = "unknown"
    overall_label: TradeQualityLabel = "unknown"
    overall_score: float | None = None
    regime_fit_score: float | None = None
    edge_score: float | None = None
    confidence: RegimeConfidence = "low"
    quality_rank: float | None = None
    rationale: list[str] = Field(default_factory=list)
    headwinds: list[str] = Field(default_factory=list)

