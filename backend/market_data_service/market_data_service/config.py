"""Market data service configuration."""

from shared.config import BaseServiceSettings


class MarketDataSettings(BaseServiceSettings):
    nse_ws_url: str = ""
    mcx_ws_url: str = ""
    broker_api_key: str = ""
    broker_api_secret: str = ""
    snapshot_throttle_ms: int = 25
    # Cadence for a chain nobody is actively looking at (tab hidden, user idle).
    # The chain stays subscribed and accurate, it just stops being recomputed
    # 40x/second for an audience of nobody.
    snapshot_background_throttle_ms: int = 2000
    # A chain whose rate was never asserted (gateway restart, demand message
    # lost) falls back to the active rate — stale-but-cheap is the wrong way to
    # fail for a chain someone may be staring at.
    snapshot_max_throttle_ms: int = 10000
    service_name: str = "market_data_service"
    kotak_consumer_key: str = ""
    kotak_ws_url: str = ""
    kotak_environment: str = "prod"
