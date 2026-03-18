"""Shared base configuration using pydantic-settings."""

from pydantic_settings import BaseSettings


class BaseServiceSettings(BaseSettings):
    redis_url: str = "redis://localhost:6379/0"
    timescaledb_url: str = "postgresql+asyncpg://trader:trader@localhost:5432/tradingdb"
    log_level: str = "info"
    environment: str = "development"
    service_name: str = "unknown"

    model_config = {"env_file": ".env", "extra": "ignore"}
