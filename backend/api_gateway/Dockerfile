# ---------- base ----------
FROM python:3.12-slim AS base

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip

# Copy shared library first so it can be installed as a dependency
COPY shared/ /app/shared/
RUN pip install --no-cache-dir /app/shared/

# Copy API gateway
COPY api_gateway/ /app/api_gateway/
RUN pip install --no-cache-dir /app/api_gateway/

# ---------- dev ----------
FROM base AS dev

RUN pip install --no-cache-dir /app/api_gateway/[dev]

CMD ["uvicorn", "api_gateway.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "wsproto", "--reload"]

# ---------- prod ----------
FROM base AS prod

CMD ["uvicorn", "api_gateway.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "wsproto"]
