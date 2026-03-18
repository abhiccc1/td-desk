# ---------------------------------------------------------------------------
# Stage: base
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------------------------
# Stage: rust-builder — compile td_core from source via maturin
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends curl build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

RUN pip install --no-cache-dir maturin>=1.0

WORKDIR /build
COPY quant_service/rust_core/ /build/rust_core/

RUN cd /build/rust_core && maturin build --release --interpreter python3.12 \
    && ls /build/rust_core/target/wheels/

# ---------------------------------------------------------------------------
# Stage: dev
# ---------------------------------------------------------------------------
FROM base AS dev

# Install shared package in editable mode
COPY shared/ /app/shared/
RUN pip install --no-cache-dir -e /app/shared

# Install td-core wheel from builder
COPY --from=rust-builder /build/rust_core/target/wheels/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/td_core*.whl && rm /tmp/*.whl

# Install quant_service in editable mode
COPY quant_service/ /app/quant_service/
RUN pip install --no-cache-dir -e "/app/quant_service[dev]"

CMD ["python", "-m", "quant_service.main"]

# ---------------------------------------------------------------------------
# Stage: prod
# ---------------------------------------------------------------------------
FROM base AS prod

# Install shared package
COPY shared/ /app/shared/
RUN pip install --no-cache-dir /app/shared

# Install td-core wheel from builder
COPY --from=rust-builder /build/rust_core/target/wheels/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/td_core*.whl && rm /tmp/*.whl

# Install quant_service
COPY quant_service/ /app/quant_service/
RUN pip install --no-cache-dir /app/quant_service

# Run as non-root user
RUN useradd --create-home appuser
USER appuser

CMD ["python", "-m", "quant_service.main"]
