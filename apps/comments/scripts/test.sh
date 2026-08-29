#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
cd "${REPO_ROOT}"

if [[ -z "${GOCACHE:-}" ]]; then
	export GOCACHE="${REPO_ROOT}/.gocache"
fi
mkdir -p "${GOCACHE}"

echo "Running tests with full-package coverage"
go test -v -coverpkg=./... -coverprofile=coverage.out ./...

echo "Coverage summary"
go tool cover -func=coverage.out | tail -n 1

echo "Tests passed"
