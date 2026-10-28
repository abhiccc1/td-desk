# syntax=docker/dockerfile:1.7
#
# Standalone builder image for the td_core Rust/PyO3 wheel.
# NOTE: api_gateway and quant_service embed their own identical rust-builder
# stage (deduplicated by buildx bake); this file is kept for ad-hoc wheel
# builds outside compose.
#
FROM python:3.12-slim AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends curl build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install "maturin>=1.0"

WORKDIR /build
COPY quant_service/rust_core/ /build/rust_core/

RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/build/rust_core/target \
    cd /build/rust_core && maturin build --release --interpreter python3.12 \
    && mkdir -p /dist \
    && cp /build/rust_core/target/wheels/*.whl /dist/
