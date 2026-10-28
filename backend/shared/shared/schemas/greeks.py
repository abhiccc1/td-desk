"""Greeks and IV surface schemas."""

from datetime import datetime
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class GreeksResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    symbol: str
    underlying: str
    expiry: str
    strike: float
    option_type: str  # "C" or "P"
    iv: float
    delta: float
    gamma: float
    theta: float
    vega: float
    vanna: float = 0.0
    charm: float = 0.0
    vomma: float = 0.0
    underlying_price: float
    timestamp: datetime


class SviParams(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiry: str
    a: float
    b: float
    rho: float
    m: float
    sigma: float
    rmse: float = 0.0
    arbitrage_free: bool = True
    timestamp: datetime


class HestonParams(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiry: str
    kappa: float      # mean-reversion speed
    theta: float      # long-run variance
    sigma_v: float    # vol-of-vol
    rho: float        # spot-vol correlation
    v0: float         # initial variance
    timestamp: datetime


class ModelStrikeResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    strike: float
    heston_iv: float | None = None
    vg_iv: float | None = None
    heston_call_price: float | None = None
    heston_put_price: float | None = None
    vg_call_price: float | None = None
    vg_put_price: float | None = None
    heston_pop: float | None = None  # P(profit) for buying call at this strike
    vg_pop: float | None = None


class ModelPricesResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiry: str
    spot: float
    heston_params: dict[str, float]
    vg_params: dict[str, float]
    heston_calibrated: bool = False
    vg_calibrated: bool = False
    heston_rmse: float | None = None
    vg_rmse: float | None = None
    strikes: list[ModelStrikeResult]
    heston_density: list[list[float]] | None = None  # [[strike, density], ...] for frontend chart
    vg_density: list[list[float]] | None = None
    timestamp: datetime


class VarianceGammaParams(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiry: str
    sigma: float      # volatility of Brownian component
    theta: float      # drift of Brownian component (skew)
    nu: float         # variance rate of Gamma subordinator (kurtosis)
    timestamp: datetime


class VrpResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    atm_iv: float
    realized_vol: float
    vrp: float
    iv_rank: float | None  # 0-100 percentile
    window_days: int  # e.g. 10
    timestamp: datetime


class IVSurface(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    underlying: str
    expiries: list[str]
    strikes: list[float]
    iv_matrix: list[list[float]]  # [expiry_idx][strike_idx]
    timestamp: datetime
