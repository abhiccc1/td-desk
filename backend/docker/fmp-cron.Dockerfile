# syntax=docker/dockerfile:1.7

# Lightweight cron container for daily FMP calendar sync.
# Reuses shared package deps only (no api_gateway / td_core needed).
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends cron \
    && rm -rf /var/lib/apt/lists/*

# Install shared package (provides config, redis_client, httpx)
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install /app/shared

COPY docker/fmp-cron-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

CMD ["/usr/local/bin/entrypoint.sh"]
