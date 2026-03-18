#!/bin/bash
set -euo pipefail

echo "==> Checking prerequisites..."
command -v docker >/dev/null 2>&1 || { echo "Docker is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required"; exit 1; }

echo "==> Creating .env from template..."
[ -f .env ] || cp .env.example .env

echo "==> Building Docker images..."
docker compose build

echo "==> Starting infrastructure..."
docker compose up -d redis timescaledb

echo "==> Waiting for database to be ready..."
until docker compose exec timescaledb pg_isready -U trader -d tradingdb 2>/dev/null; do
    sleep 1
done

echo "==> Installing frontend dependencies (for IDE support)..."
cd frontend && npm ci && cd ..

echo "==> Setup complete! Run 'make up' to start the full stack."
