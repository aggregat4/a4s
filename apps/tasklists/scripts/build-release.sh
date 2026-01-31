#!/bin/bash
set -euo pipefail

# Build script for creating a standalone binary with embedded frontend
# Usage: ./scripts/build-release.sh [output_name]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_NAME="${1:-prototype-lists}"

echo "=== Building Prototype Lists Release ==="
echo "Output: ${OUTPUT_NAME}"

# Step 1: Build frontend
echo ""
echo "[1/4] Building frontend..."
cd "${PROJECT_ROOT}/client"
npm ci
npm run build

# Step 2: Copy frontend to server's static directory
echo ""
echo "[2/4] Copying frontend to server/static..."
rm -rf "${PROJECT_ROOT}/server/cmd/server/static"/*
cp -r "${PROJECT_ROOT}/client/dist"/* "${PROJECT_ROOT}/server/cmd/server/static/"

# Step 3: Build Go binary with embedded frontend
echo ""
echo "[3/4] Building Go binary..."
cd "${PROJECT_ROOT}/server"
go build -ldflags="-s -w" -o "${PROJECT_ROOT}/${OUTPUT_NAME}" ./cmd/server

# Step 4: Verify
echo ""
echo "[4/4] Verifying build..."
if [ -f "${PROJECT_ROOT}/${OUTPUT_NAME}" ]; then
    echo "✓ Binary created: ${PROJECT_ROOT}/${OUTPUT_NAME}"
    ls -lh "${PROJECT_ROOT}/${OUTPUT_NAME}"
    echo ""
    echo "To run:"
    echo "  ./${OUTPUT_NAME}"
    echo ""
    echo "Environment variables:"
    echo "  PORT            - Server port (default: 8080)"
    echo "  SERVER_DB_PATH  - Database file path (default: data.db)"
else
    echo "✗ Build failed"
    exit 1
fi
