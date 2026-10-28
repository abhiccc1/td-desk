"""Quant service configuration."""

from shared.config import BaseServiceSettings


class QuantSettings(BaseServiceSettings):
    risk_free_rate: float = 0.065
    service_name: str = "quant_service"
