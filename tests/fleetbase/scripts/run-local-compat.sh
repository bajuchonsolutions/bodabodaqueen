#!/usr/bin/env bash
# Disposable tests only. Will delete containers and volumes for its unique compose project.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'BLOCKED: Docker is not installed. No containers started.' >&2; exit 2; }
docker compose version >/dev/null || { echo 'BLOCKED: Docker Compose unavailable.' >&2; exit 2; }
export LOCAL_MYSQL_ROOT_PASSWORD="$(openssl rand -hex 24)"
export LOCAL_MYSQL_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
export LOCAL_MYSQL_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
export LOCAL_REDIS_PASSWORD="$(openssl rand -hex 24)"
export COMPOSE_PROJECT_NAME="bbq-local-compat-$$"
cleanup() { docker compose -p "$COMPOSE_PROJECT_NAME" -f integration/compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Explicit project name in compose, isolated network, no published ports.
docker compose -p "$COMPOSE_PROJECT_NAME" -f integration/compose.yaml up --build --abort-on-container-exit --exit-code-from integration
