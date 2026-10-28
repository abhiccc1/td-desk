# syntax=docker/dockerfile:1.7

# ---------- base ----------
FROM python:3.12-slim AS base

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip

COPY docker/export_pyproject_deps.py /usr/local/bin/export_pyproject_deps.py
COPY shared/pyproject.toml /tmp/shared-pyproject.toml
COPY order_service/pyproject.toml /tmp/order-service-pyproject.toml

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --output /tmp/runtime-requirements.txt \
        /tmp/shared-pyproject.toml \
        /tmp/order-service-pyproject.toml \
    && pip install -r /tmp/runtime-requirements.txt

# ---------- dev ----------
FROM base AS dev

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --group dev \
        --output /tmp/dev-requirements.txt \
        /tmp/order-service-pyproject.toml \
    && pip install -r /tmp/dev-requirements.txt

# Copy shared library first so it can be installed as a dependency
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/shared

# Copy order service
COPY order_service/ /app/order_service/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/order_service

CMD ["uvicorn", "order_service.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# ---------- prod ----------
FROM base AS prod

# Copy shared library first so it can be installed as a dependency
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/shared

# Copy order service
COPY order_service/ /app/order_service/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/order_service

CMD ["uvicorn", "order_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
