#!/usr/bin/env bash
set -euo pipefail

# Builds and starts the Tasklists server for the browser tests, with a fresh
# database. Playwright runs this as its web server and stops it afterwards.
#
#   run-test-server.sh [dev|embedded|oidc]
#
# dev       dev auth, static files served from client/dist (the default)
# embedded  dev auth, static files embedded in the binary
# oidc      OIDC auth against the in-repo mock OpenID Provider on port 8001

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MODE=${1:-dev}
APP_PORT=8000
IDP_PORT=8001
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/a4-tasklists-e2e.XXXXXX")
EMBEDDED_STATIC_DIR="${ROOT_DIR}/server/cmd/server/static"

cleanup() {
  for pid in ${SERVER_PID:-} ${IDP_PID:-}; do
    kill "${pid}" >/dev/null 2>&1 || true
  done
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

cd "${ROOT_DIR}/server"
case "${MODE}" in
  dev)
    go build -o "${WORK_DIR}/server" ./cmd/server
    export SERVER_STATIC_DIR="${ROOT_DIR}/client/dist"
    export SERVER_AUTH_MODE=dev
    ;;
  embedded)
    rm -rf "${EMBEDDED_STATIC_DIR:?}"/*
    cp -r "${ROOT_DIR}/client/dist"/. "${EMBEDDED_STATIC_DIR}/"
    build_status=0
    go build -o "${WORK_DIR}/server" ./cmd/server || build_status=$?
    rm -rf "${EMBEDDED_STATIC_DIR:?}"/*
    if [ "${build_status}" -ne 0 ]; then
      exit "${build_status}"
    fi
    export SERVER_AUTH_MODE=dev
    ;;
  oidc)
    issuer_url="http://127.0.0.1:${IDP_PORT}"
    redirect_url="http://127.0.0.1:${APP_PORT}/auth/callback"
    go build -o "${WORK_DIR}/server" ./cmd/server
    go build -o "${WORK_DIR}/mockidp" ./cmd/mockidp
    IDP_LISTEN_ADDR="127.0.0.1:${IDP_PORT}" IDP_ISSUER_URL="${issuer_url}" \
      IDP_CLIENT_ID=tasklists IDP_CLIENT_SECRET=tasklists-secret \
      IDP_REDIRECT_URI="${redirect_url}" \
      "${WORK_DIR}/mockidp" &
    IDP_PID=$!
    for _attempt in $(seq 1 60); do
      if (echo > "/dev/tcp/127.0.0.1/${IDP_PORT}") 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    export SERVER_STATIC_DIR="${ROOT_DIR}/client/dist"
    export OIDC_ISSUER_URL="${issuer_url}" OIDC_CLIENT_ID=tasklists
    export OIDC_CLIENT_SECRET=tasklists-secret OIDC_REDIRECT_URL="${redirect_url}"
    export SERVER_SESSION_KEY=oidc-e2e-session-key-0123456789abcdef
    export SERVER_COOKIE_SECURE=false
    ;;
  *)
    echo "unknown mode: ${MODE}" >&2
    exit 2
    ;;
esac

export SERVER_DB_PATH="${WORK_DIR}/test.db"
export PORT="${APP_PORT}"
# Not exec: the traps must still stop the mock IdP and remove the work directory.
"${WORK_DIR}/server" &
SERVER_PID=$!
wait "${SERVER_PID}"
