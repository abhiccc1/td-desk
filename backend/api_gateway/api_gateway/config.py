"""API-gateway configuration."""

from shared.config import BaseServiceSettings


class GatewaySettings(BaseServiceSettings):
    """Settings specific to the API gateway."""

    order_service_url: str = "http://order_service:8000"
    jwt_secret: str = "local-dev-secret"
    cors_origins: str = "http://localhost:3000,http://tauri.localhost,https://tauri.localhost,tauri://localhost"
    service_name: str = "api_gateway"
    kotak_consumer_key: str = ""
    kotak_environment: str = "prod"
    # JSON array of broker account profiles — see shared.accounts. Holds the
    # consumer key server-side so it never reaches the client.
    kotak_accounts: str = ""


settings = GatewaySettings()
