"""Import all indicator modules to trigger registration with the registry."""

from quant_service.indicators import greeks  # noqa: F401
from quant_service.indicators import strategy_analyzer  # noqa: F401
from quant_service.indicators import risk_exposure  # noqa: F401
from quant_service.indicators import historical  # noqa: F401
from quant_service.indicators import model_pricer  # noqa: F401
