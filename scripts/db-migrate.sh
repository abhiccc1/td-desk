#!/bin/bash
set -euo pipefail
echo "==> Running Alembic migrations..."
cd backend && python -m alembic upgrade head
echo "==> Migrations complete."
