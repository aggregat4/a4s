#!/bin/bash

# Build from the monorepo root so Go can resolve the shared root module. The
# Debian Bookworm image provides a stable libc baseline for deployed binaries.
set -euo pipefail

APP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MONOREPO_ROOT=$(cd "${APP_ROOT}/../.." && pwd)

docker run --rm \
  -v "${MONOREPO_ROOT}":/work \
  -w /work/apps/comments \
  golang:1.26.6-bookworm \
  scripts/build.sh
