# syntax=docker/dockerfile:1.7

# ---------- base ----------
FROM python:3.12-slim AS base

WORKDIR /app

# git is no longer installed here: it existed solely to pip-install the Kotak
# SDK from GitHub (neo_api_client @ git+...). That dependency is now the PyPI
# package `kotakneoapi`, so the base image needs no VCS client.

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip

COPY docker/export_pyproject_deps.py /usr/local/bin/export_pyproject_deps.py
COPY shared/pyproject.toml /tmp/shared-pyproject.toml
COPY api_gateway/pyproject.toml /tmp/api-gateway-pyproject.toml

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --output /tmp/runtime-requirements.txt \
        /tmp/shared-pyproject.toml \
        /tmp/api-gateway-pyproject.toml \
    && pip install -r /tmp/runtime-requirements.txt

# ---------- rust-builder — compile td_core Rust/PyO3 wheel ----------
FROM python:3.12-slim AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config libssl-dev && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:$PATH"

RUN pip install --no-cache-dir maturin

# Cap parallel rustc jobs — the podman/docker VM has limited RAM and a
# full-parallel release build gets OOM-killed (SIGKILL).
ENV CARGO_BUILD_JOBS=2

WORKDIR /build
COPY quant_service/rust_core/ ./rust_core/
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/build/rust_core/target \
    cd rust_core && maturin build --release --strip -o /dist/

# ---------- dev ----------
FROM base AS dev

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --group dev \
        --output /tmp/dev-requirements.txt \
        /tmp/api-gateway-pyproject.toml \
    && pip install -r /tmp/dev-requirements.txt

# Copy shared library first so it can be installed as a dependency
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/shared

# Install td_core wheel (for strategy RND analytics)
COPY --from=rust-builder /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/td_core*.whl && rm /tmp/*.whl

# Copy API gateway
COPY api_gateway/ /app/api_gateway/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/api_gateway

CMD ["uvicorn", "api_gateway.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "wsproto", "--reload"]

# ---------- prod ----------
FROM base AS prod

# Copy shared library first so it can be installed as a dependency
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/shared

# Install td_core wheel (for strategy RND analytics)
COPY --from=rust-builder /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/td_core*.whl && rm /tmp/*.whl

# Copy API gateway
COPY api_gateway/ /app/api_gateway/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/api_gateway

CMD ["uvicorn", "api_gateway.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "wsproto"]
