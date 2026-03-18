# ---------------------------------------------------------------------------
# Stage: base
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------------------
# Stage: dev
# ---------------------------------------------------------------------------
FROM base AS dev

# Install shared package in editable mode
COPY shared/ /app/shared/
RUN pip install --no-cache-dir -e /app/shared

# Install market_data_service in editable mode
COPY market_data_service/ /app/market_data_service/
RUN pip install --no-cache-dir -e "/app/market_data_service[dev]"

CMD ["python", "-m", "market_data_service.main"]

# ---------------------------------------------------------------------------
# Stage: prod
# ---------------------------------------------------------------------------
FROM base AS prod

# Install shared package
COPY shared/ /app/shared/
RUN pip install --no-cache-dir /app/shared

# Install market_data_service
COPY market_data_service/ /app/market_data_service/
RUN pip install --no-cache-dir /app/market_data_service

# Run as non-root user
RUN useradd --create-home appuser
USER appuser

CMD ["python", "-m", "market_data_service.main"]
