#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MONOREPO_ROOT=$(cd "${ROOT_DIR}/../.." && pwd)
PORT=8000
IMAGE=golang:1.26.6-bookworm
CONTAINER_NAME=a4-tasklists-go-server
STATIC_MODE=${SERVER_STATIC_MODE:-external}
EMBEDDED_STATIC_DIR="${ROOT_DIR}/server/cmd/server/static"

cleanup_embedded_static() {
  rm -rf "${EMBEDDED_STATIC_DIR}"/*
}

if [ "${STATIC_MODE}" = "embedded" ]; then
  cleanup_embedded_static
  cp -r "${ROOT_DIR}/client/dist"/. "${EMBEDDED_STATIC_DIR}/"
fi

if [ "${STATIC_MODE}" = "embedded" ]; then
  SERVER_COMMAND="SERVER_DB_PATH=/work/apps/tasklists/server/test.db PORT=${PORT} SERVER_AUTH_MODE=dev exec go run ./cmd/server"
else
  SERVER_COMMAND="SERVER_STATIC_DIR=/work/apps/tasklists/client/dist SERVER_DB_PATH=/work/apps/tasklists/server/test.db PORT=${PORT} SERVER_AUTH_MODE=dev exec go run ./cmd/server"
fi

CID=$(docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:${PORT}" \
  -v "${MONOREPO_ROOT}":/work \
  -w /work/apps/tasklists/client \
  "${IMAGE}" \
  bash -lc "set -euxo pipefail; pwd; ls -la /work; ls -la /work/apps/tasklists/server; export PATH=$PATH:/usr/local/go/bin; command -v go; go version; cd /work/apps/tasklists/server; rm -f /work/apps/tasklists/server/test.db; ${SERVER_COMMAND}")

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
  if [ "${STATIC_MODE}" = "embedded" ]; then
    cleanup_embedded_static
  fi
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
