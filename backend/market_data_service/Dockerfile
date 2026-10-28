# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Stage: base
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS base

WORKDIR /app

# procps provides pgrep, used by the compose healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip

COPY docker/export_pyproject_deps.py /usr/local/bin/export_pyproject_deps.py
COPY shared/pyproject.toml /tmp/shared-pyproject.toml
COPY market_data_service/pyproject.toml /tmp/market-data-service-pyproject.toml

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --output /tmp/runtime-requirements.txt \
        /tmp/shared-pyproject.toml \
        /tmp/market-data-service-pyproject.toml \
    && pip install -r /tmp/runtime-requirements.txt

# ---------------------------------------------------------------------------
# Stage: dev
# ---------------------------------------------------------------------------
FROM base AS dev

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --group dev \
        --output /tmp/dev-requirements.txt \
        /tmp/market-data-service-pyproject.toml \
    && pip install -r /tmp/dev-requirements.txt

# Install shared package in editable mode
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/shared

# Install market_data_service in editable mode
COPY market_data_service/ /app/market_data_service/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/market_data_service

CMD ["python", "-m", "market_data_service.main"]

# ---------------------------------------------------------------------------
# Stage: prod
# ---------------------------------------------------------------------------
FROM base AS prod

# Install shared package
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/shared

# Install market_data_service
COPY market_data_service/ /app/market_data_service/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/market_data_service

# Run as non-root user
RUN useradd --create-home appuser
USER appuser

CMD ["python", "-m", "market_data_service.main"]
