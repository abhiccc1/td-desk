"""Import all indicator modules to trigger registration with the registry."""

from quant_service.indicators import greeks  # noqa: F401
from quant_service.indicators import historical  # noqa: F401
from quant_service.indicators import model_pricer  # noqa: F401
from quant_service.indicators import calibrator  # noqa: F401
from quant_service.indicators import vrp  # noqa: F401
