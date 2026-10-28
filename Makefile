# ─────────────────────────────────────────────────────────────────────
# td-desk Makefile — Backend Services
# ─────────────────────────────────────────────────────────────────────
#
# Usage:
#   make start                  # Fast start (no rebuild); keep session_broker if already running
#   make start full             # Rebuild images + start all backend services
#   make start infra            # Redis + TimescaleDB only
#   make stop                   # Stop all backend services
#   make restart                # Stop + start
#   make build                  # Build all (Rust + Docker images)
#   make build rust             # Build td_core Rust extension only
#   make build docker           # Build Docker images only
#   make bake                   # Build Docker images via buildx bake
#   make bake-print             # Print the compose-derived bake plan
#   make logs                   # Tail all docker logs
#   make logs <service>         # Tail logs for one service
#   make status                 # Show running services
#   make test                   # Run all tests
#   make lint                   # Run all linters
#   make clean                  # Remove build artifacts and volumes
#
# ─────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Directories
ROOT       := $(shell pwd)
BACKEND    := $(ROOT)/backend
RUST_CORE  := $(BACKEND)/quant_service/rust_core
COMPOSE_FILE ?= docker-compose.yml
COMPOSE_BAKE ?= true
DOCKER_COMPOSE := COMPOSE_BAKE=$(COMPOSE_BAKE) docker compose
DOCKER_BAKE := docker buildx bake -f $(COMPOSE_FILE)
CORE_SERVICES := redis timescaledb market_data_service quant_service order_service api_gateway
ALL_SERVICES := $(CORE_SERVICES) session_broker

# Log helper
define log
	@echo -e $(1)
endef

# Colors
R := \033[0m
C := \033[36m
G := \033[32m
Y := \033[33m

# ─── Help ─────────────────────────────────────────────────────────────

.PHONY: help
help:
	$(call log,"")
	$(call log,"  $(C)td-desk$(R) — Backend Services")
	$(call log,"")
	$(call log,"  $(G)make start$(R)                 Fast start (no rebuild); keep session_broker if already running")
	$(call log,"  $(G)make start full$(R)            Rebuild images + start all backend services")
	$(call log,"  $(G)make start infra$(R)           Redis + TimescaleDB only")
	$(call log,"  $(G)make stop$(R)                  Stop all backend services")
	$(call log,"  $(G)make restart$(R)               Stop + start")
	$(call log,"")
	$(call log,"  $(G)make build$(R)                 Build all (Rust + Docker images)")
	$(call log,"  $(G)make build rust$(R)            Build td_core Rust/PyO3 extension")
	$(call log,"  $(G)make build docker$(R)          Build Docker images (Compose Bake enabled)")
	$(call log,"  $(G)make bake$(R)                  Build Docker images via buildx bake")
	$(call log,"  $(G)make bake-print$(R)            Print the compose-derived bake plan")
	$(call log,"")
	$(call log,"  $(G)make logs$(R)                  Tail all Docker logs")
	$(call log,"  $(G)make logs <service>$(R)        Tail logs for one service")
	$(call log,"  $(G)make status$(R)                Show running services")
	$(call log,"  $(G)make test$(R)                  Run all tests")
	$(call log,"  $(G)make lint$(R)                  Run all linters")
	$(call log,"  $(G)make clean$(R)                 Remove build artifacts and volumes")
	$(call log,"  $(G)make setup$(R)                 First-time project setup")
	$(call log,"")
	$(call log,"  $(G)make migrate$(R)               Run database migrations")
	$(call log,"  $(G)make seed$(R)                  Seed sample data")
	$(call log,"  $(G)make shell-<svc>$(R)           Shell into a Docker service")
	$(call log,"")

# ─── Start ────────────────────────────────────────────────────────────

.PHONY: start
ifeq ($(word 2,$(MAKECMDGOALS)),)
start:
	$(call log,"$(C)Starting backend services...$(R)")
	@if $(DOCKER_COMPOSE) ps --services --filter status=running session_broker 2>/dev/null | grep -qx "session_broker"; then \
		echo -e "$(Y)session_broker already running — leaving it untouched$(R)"; \
		$(DOCKER_COMPOSE) up -d $(CORE_SERVICES); \
	else \
		$(DOCKER_COMPOSE) up -d $(ALL_SERVICES); \
	fi
	$(call log,"$(G)✓ Backend running — API at http://localhost:8000$(R)")
else
start: start-$(word 2,$(MAKECMDGOALS))
	@:
endif

.PHONY: start-full
start-full:
	$(call log,"$(C)Starting all backend services (full, rebuild)...$(R)")
	@$(DOCKER_COMPOSE) up -d --build $(ALL_SERVICES)
	$(call log,"$(G)✓ Full backend start complete — API at http://localhost:8000$(R)")

.PHONY: start-infra
start-infra:
	$(call log,"$(C)Starting infrastructure (Redis + TimescaleDB)...$(R)")
	@$(DOCKER_COMPOSE) up -d redis timescaledb
	$(call log,"$(G)✓ Infrastructure ready$(R)")

# ─── Stop ─────────────────────────────────────────────────────────────

.PHONY: stop
stop:
	$(call log,"$(C)Stopping backend services...$(R)")
	@$(DOCKER_COMPOSE) down
	$(call log,"$(G)✓ Backend stopped$(R)")

# ─── Restart ──────────────────────────────────────────────────────────

.PHONY: restart
restart: stop start

# ─── Build ────────────────────────────────────────────────────────────

.PHONY: build
ifeq ($(word 2,$(MAKECMDGOALS)),)
build: build-rust build-docker
	$(call log,"$(G)✓ All builds complete$(R)")
else
build: build-$(word 2,$(MAKECMDGOALS))
	@:
endif

.PHONY: build-rust
build-rust:
	$(call log,"$(C)Building td_core (Rust/PyO3) via Docker...$(R)")
	@$(DOCKER_COMPOSE) build quant_service
	$(call log,"$(G)✓ td_core built inside quant_service image$(R)")

.PHONY: build-docker
build-docker:
	$(call log,"$(C)Building Docker images with Compose Bake...$(R)")
	@$(DOCKER_COMPOSE) build
	$(call log,"$(G)✓ Docker images built$(R)")

.PHONY: bake bake-print
bake:
	$(call log,"$(C)Building Docker images via buildx bake...$(R)")
	@$(DOCKER_BAKE) --load
	$(call log,"$(G)✓ Bake build complete$(R)")

bake-print:
	@$(DOCKER_BAKE) --print

# ─── Logs ─────────────────────────────────────────────────────────────

.PHONY: logs
ifeq ($(word 2,$(MAKECMDGOALS)),)
logs:
	@$(DOCKER_COMPOSE) logs -f
else
logs: _logs-target
	@:
endif

.PHONY: _logs-target
_logs-target:
	@$(DOCKER_COMPOSE) logs -f $(word 2,$(MAKECMDGOALS))

# ─── Status ───────────────────────────────────────────────────────────

.PHONY: status
status:
	@$(DOCKER_COMPOSE) ps 2>/dev/null || echo "  (none running)"

# ─── Testing ──────────────────────────────────────────────────────────

.PHONY: test test-backend test-rust
test: test-rust test-backend

test-rust:
	$(call log,"$(C)Running Rust tests via Docker...$(R)")
	@docker build -f $(BACKEND)/quant_service/Dockerfile --target rust-builder -t td-desk-rust-test $(BACKEND) --quiet
	@docker run --rm td-desk-rust-test bash -c "cd /build/rust_core && cargo test"
	$(call log,"$(G)✓ Rust tests passed$(R)")

test-backend:
	$(call log,"$(C)Running backend tests...$(R)")
	@cd $(BACKEND) && python -m pytest shared/tests/ market_data_service/tests/ quant_service/tests/ order_service/tests/ api_gateway/tests/ -v
	$(call log,"$(G)✓ Backend tests passed$(R)")

# ─── Linting ──────────────────────────────────────────────────────────

.PHONY: lint
lint:
	@cd $(BACKEND) && ruff check . && mypy .

# ─── Database ─────────────────────────────────────────────────────────

.PHONY: migrate seed
migrate:
	@bash scripts/db-migrate.sh

seed:
	@python scripts/seed-data.py

# ─── Setup ────────────────────────────────────────────────────────────

.PHONY: setup
setup:
	@bash scripts/setup.sh

# ─── Clean ────────────────────────────────────────────────────────────

.PHONY: clean
clean: stop
	$(call log,"$(C)Cleaning build artifacts...$(R)")
	@rm -rf $(RUST_CORE)/target
	$(call log,"$(G)✓ Clean$(R)")

.PHONY: clean-all
clean-all: clean
	$(call log,"$(Y)Removing Docker volumes (data will be lost)...$(R)")
	@$(DOCKER_COMPOSE) down -v 2>/dev/null || true
	$(call log,"$(G)✓ All data removed$(R)")

# ─── Shell ────────────────────────────────────────────────────────────

shell-%:
	@$(DOCKER_COMPOSE) exec $* bash

# ─── Catch-all for sub-targets ────────────────────────────────────────

.PHONY: infra rust docker full
infra rust docker full:
	@:
