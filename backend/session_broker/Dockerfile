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
COPY session_broker/pyproject.toml /tmp/session-broker-pyproject.toml

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --output /tmp/runtime-requirements.txt \
        /tmp/shared-pyproject.toml \
        /tmp/session-broker-pyproject.toml \
    && pip install -r /tmp/runtime-requirements.txt

# ---------------------------------------------------------------------------
# Stage: dev
# ---------------------------------------------------------------------------
FROM base AS dev

# Install shared package in editable mode
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/shared

# Install session_broker in editable mode
COPY session_broker/ /app/session_broker/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/session_broker

CMD ["python", "-m", "session_broker.main"]

# ---------------------------------------------------------------------------
# Stage: prod
# ---------------------------------------------------------------------------
FROM base AS prod

# Install shared package
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/shared

# Install session_broker
COPY session_broker/ /app/session_broker/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/session_broker

# Run as non-root user
RUN useradd --create-home appuser
USER appuser

CMD ["python", "-m", "session_broker.main"]
