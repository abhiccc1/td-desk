"""Market data service configuration."""

from shared.config import BaseServiceSettings


class MarketDataSettings(BaseServiceSettings):
    nse_ws_url: str = ""
    mcx_ws_url: str = ""
    broker_api_key: str = ""
    broker_api_secret: str = ""
    snapshot_throttle_ms: int = 75
    service_name: str = "market_data_service"
    kotak_consumer_key: str = ""
    kotak_ws_url: str = ""
    kotak_environment: str = "prod"
