"""Order-service configuration."""

from shared.config import BaseServiceSettings


class OrderSettings(BaseServiceSettings):
    """Settings specific to the order service."""

    broker_api_key: str = ""
    broker_api_secret: str = ""
    service_name: str = "order_service"


settings = OrderSettings()
