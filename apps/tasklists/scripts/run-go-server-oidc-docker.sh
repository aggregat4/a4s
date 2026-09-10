#!/usr/bin/env bash
set -euo pipefail

# Starts the Tasklists server in OIDC mode together with the in-repo mock
# OpenID Provider. Both processes listen inside the same container so that the
# browser and the application agree on the issuer URL (http://127.0.0.1:8001).

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MONOREPO_ROOT=$(cd "${ROOT_DIR}/../.." && pwd)
APP_PORT=8000
IDP_PORT=8001
IMAGE=golang:1.26.6-bookworm
CONTAINER_NAME=a4-tasklists-oidc-server
ISSUER_URL="http://127.0.0.1:${IDP_PORT}"
REDIRECT_URL="http://127.0.0.1:${APP_PORT}/auth/callback"

CID=$(docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -p "${APP_PORT}:${APP_PORT}" \
  -p "${IDP_PORT}:${IDP_PORT}" \
  -v "${MONOREPO_ROOT}":/work \
  -w /work/apps/tasklists/client \
  "${IMAGE}" \
  bash -lc "set -euo pipefail; export PATH=\$PATH:/usr/local/go/bin; cd /work/apps/tasklists/server; \
    rm -f /work/apps/tasklists/server/oidc-test.db*; \
    IDP_LISTEN_ADDR=0.0.0.0:${IDP_PORT} IDP_ISSUER_URL=${ISSUER_URL} \
    IDP_CLIENT_ID=tasklists IDP_CLIENT_SECRET=tasklists-secret \
    IDP_REDIRECT_URI=${REDIRECT_URL} \
    go run ./cmd/mockidp & \
    for i in \$(seq 1 60); do (echo > /dev/tcp/127.0.0.1/${IDP_PORT}) 2>/dev/null && break; sleep 0.5; done; \
    SERVER_STATIC_DIR=/work/apps/tasklists/client/dist \
    SERVER_DB_PATH=/work/apps/tasklists/server/oidc-test.db \
    PORT=${APP_PORT} \
    OIDC_ISSUER_URL=${ISSUER_URL} OIDC_CLIENT_ID=tasklists OIDC_CLIENT_SECRET=tasklists-secret \
    OIDC_REDIRECT_URL=${REDIRECT_URL} \
    SERVER_SESSION_KEY=oidc-e2e-session-key-0123456789abcdef \
    SERVER_COOKIE_SECURE=false \
    exec go run ./cmd/server")

if [ -z "${CID}" ]; then
  echo "Failed to start Go server container." >&2
  exit 1
fi

docker logs -f "${CID}" &
LOG_PID=$!

cleanup() {
  if [ -n "${LOG_PID:-}" ]; then
    kill "${LOG_PID}" >/dev/null 2>&1 || true
  fi
  docker rm -f "${CID}" >/dev/null 2>&1 || true
}

terminate() {
  cleanup
  exit 0
}

trap terminate INT TERM
trap cleanup EXIT

while true; do
  sleep 1
done
