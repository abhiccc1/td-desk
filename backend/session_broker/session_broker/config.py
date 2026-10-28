"""Session broker configuration."""

from shared.config import BaseServiceSettings


class SessionBrokerSettings(BaseServiceSettings):
    service_name: str = "session_broker"
    kotak_consumer_key: str = ""
    health_check_interval: int = 300  # 5 minutes
    health_check_failures_threshold: int = 3
