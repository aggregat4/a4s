#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=8000
IMAGE=golang:1.25-bookworm
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
  SERVER_COMMAND="SERVER_DB_PATH=/work/server/test.db PORT=${PORT} SERVER_AUTH_MODE=dev exec go run ./cmd/server"
else
  SERVER_COMMAND="SERVER_STATIC_DIR=/work/client/dist SERVER_DB_PATH=/work/server/test.db PORT=${PORT} SERVER_AUTH_MODE=dev exec go run ./cmd/server"
fi

CID=$(docker run -d --rm \
  --name "${CONTAINER_NAME}" \
  -p "${PORT}:${PORT}" \
  -v "${ROOT_DIR}":/work \
  -w /work/client \
  "${IMAGE}" \
  bash -lc "set -euxo pipefail; pwd; ls -la /work; ls -la /work/server; export PATH=$PATH:/usr/local/go/bin; command -v go; go version; cd /work/server; rm -f /work/server/test.db; ${SERVER_COMMAND}")

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
