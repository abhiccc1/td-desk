# ---------- base ----------
FROM python:3.12-slim AS base

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip

# Copy shared library first so it can be installed as a dependency
COPY shared/ /app/shared/
RUN pip install --no-cache-dir /app/shared/

# Copy order service
COPY order_service/ /app/order_service/
RUN pip install --no-cache-dir /app/order_service/

# ---------- dev ----------
FROM base AS dev

RUN pip install --no-cache-dir /app/order_service/[dev]

CMD ["uvicorn", "order_service.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# ---------- prod ----------
FROM base AS prod

CMD ["uvicorn", "order_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
