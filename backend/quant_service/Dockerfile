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
COPY quant_service/pyproject.toml /tmp/quant-service-pyproject.toml

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --output /tmp/runtime-requirements.txt \
        /tmp/shared-pyproject.toml \
        /tmp/quant-service-pyproject.toml \
    && pip install -r /tmp/runtime-requirements.txt

# ---------------------------------------------------------------------------
# Stage: rust-builder — compile td_core Rust/PyO3 wheel
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Stage: dev
# ---------------------------------------------------------------------------
FROM base AS dev

RUN --mount=type=cache,target=/root/.cache/pip \
    python /usr/local/bin/export_pyproject_deps.py \
        --group dev \
        --output /tmp/dev-requirements.txt \
        /tmp/quant-service-pyproject.toml \
    && pip install -r /tmp/dev-requirements.txt

# Install shared package in editable mode
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/shared

# Install td-core wheel from builder
COPY --from=rust-builder /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/td_core*.whl && rm /tmp/*.whl

# Install quant_service in editable mode
COPY quant_service/ /app/quant_service/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps -e /app/quant_service

CMD ["python", "-m", "quant_service.main"]

# ---------------------------------------------------------------------------
# Stage: prod
# ---------------------------------------------------------------------------
FROM base AS prod

# Install shared package
COPY shared/ /app/shared/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/shared

# Install td-core wheel from builder
COPY --from=rust-builder /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/td_core*.whl && rm /tmp/*.whl

# Install quant_service
COPY quant_service/ /app/quant_service/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps /app/quant_service

# Run as non-root user
RUN useradd --create-home appuser
USER appuser

CMD ["python", "-m", "quant_service.main"]
