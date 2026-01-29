#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

cd "$ROOT_DIR/client"
npm run build

cd "$ROOT_DIR/server"
export SERVER_DB_PATH=${SERVER_DB_PATH:-"$ROOT_DIR/server/data.db"}
export SERVER_STATIC_DIR=${SERVER_STATIC_DIR:-"$ROOT_DIR/client/dist"}
export PORT=${PORT:-8080}
export SERVER_AUTH_MODE=${SERVER_AUTH_MODE:-dev}

go run ./cmd/server
