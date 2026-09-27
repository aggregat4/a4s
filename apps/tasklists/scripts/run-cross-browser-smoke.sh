#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
MONOREPO_ROOT=$(cd "${ROOT_DIR}/../.." && pwd)

"${SCRIPT_DIR}/run-go-server-docker.sh" &
SERVER_PID=$!

cleanup() {
  kill "${SERVER_PID}" >/dev/null 2>&1 || true
  wait "${SERVER_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=0
for _attempt in {1..90}; do
  if curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready}" -ne 1 ]; then
  echo "Tasklists server did not become ready for browser smoke tests." >&2
  exit 1
fi

docker run --rm --network host --ipc host \
  --user "$(id -u):$(id -g)" \
  -e PLAYWRIGHT_EXTERNAL_SERVER=1 \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "${MONOREPO_ROOT}:/work" \
  -w /work/apps/tasklists/client \
  mcr.microsoft.com/playwright:v1.59.1-noble \
  ./node_modules/.bin/playwright test -c playwright.smoke.config.ts
