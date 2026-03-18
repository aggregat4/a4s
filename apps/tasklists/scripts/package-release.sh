#!/usr/bin/env bash
set -euo pipefail

# Package a svc-deploy-compatible release tarball and checksum.
# Usage: ./scripts/package-release.sh <version> <goos> <goarch> [output_dir]

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 <version> <goos> <goarch> [output_dir]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="$1"
GOOS_TARGET="$2"
GOARCH_TARGET="$3"
OUTPUT_DIR="${4:-${PROJECT_ROOT}/dist}"
SERVICE_NAME="a4-tasklists"
ARTIFACT_BASENAME="${SERVICE_NAME}-${VERSION}-${GOOS_TARGET}-${GOARCH_TARGET}"
ARTIFACT_PATH="${OUTPUT_DIR}/${ARTIFACT_BASENAME}.tar.gz"
CHECKSUM_PATH="${ARTIFACT_PATH}.sha256"
STATIC_DIR="${PROJECT_ROOT}/server/cmd/server/static"

TMPDIR="$(mktemp -d)"
STATIC_BACKUP="${TMPDIR}/static-backup"

cleanup() {
  rm -rf "${STATIC_DIR}"
  mkdir -p "${STATIC_DIR}"
  if [ -d "${STATIC_BACKUP}" ]; then
    cp -a "${STATIC_BACKUP}"/. "${STATIC_DIR}/" 2>/dev/null || true
  fi
  rm -rf "${TMPDIR}"
}

trap cleanup EXIT

mkdir -p "${OUTPUT_DIR}"
mkdir -p "${PROJECT_ROOT}/server/.cache/go-build" "${PROJECT_ROOT}/server/.cache/go-mod"
mkdir -p "${STATIC_BACKUP}"

if [ -d "${STATIC_DIR}" ]; then
  cp -a "${STATIC_DIR}"/. "${STATIC_BACKUP}/" 2>/dev/null || true
fi

echo "=== Packaging ${SERVICE_NAME} ${VERSION} for ${GOOS_TARGET}/${GOARCH_TARGET} ==="

if [ ! -d "${PROJECT_ROOT}/client/node_modules" ]; then
  echo "[1/5] Installing client dependencies..."
  (
    cd "${PROJECT_ROOT}/client"
    npm ci
  )
fi

echo "[2/5] Building frontend..."
(
  cd "${PROJECT_ROOT}/client"
  npm run build
)

echo "[3/5] Preparing embedded static assets..."
mkdir -p "${STATIC_DIR}"
find "${STATIC_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -r "${PROJECT_ROOT}/client/dist"/. "${STATIC_DIR}/"

echo "[4/5] Building release binary..."
mkdir -p "${TMPDIR}/bin"
(
  cd "${PROJECT_ROOT}/server"
  GOCACHE="${PROJECT_ROOT}/server/.cache/go-build" \
    GOMODCACHE="${PROJECT_ROOT}/server/.cache/go-mod" \
    GOOS="${GOOS_TARGET}" GOARCH="${GOARCH_TARGET}" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
    -o "${TMPDIR}/bin/${SERVICE_NAME}" ./cmd/server
)

echo "[5/5] Writing tarball and checksum..."
tar -C "${TMPDIR}" -czf "${ARTIFACT_PATH}" bin
(
  cd "${OUTPUT_DIR}"
  sha256sum "$(basename "${ARTIFACT_PATH}")" > "$(basename "${CHECKSUM_PATH}")"
)

echo "Created ${ARTIFACT_PATH}"
echo "Created ${CHECKSUM_PATH}"
