#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/.."
cd "${REPO_ROOT}"

if [[ -z "${GOCACHE:-}" ]]; then
	export GOCACHE="${REPO_ROOT}/.gocache"
fi
mkdir -p "${GOCACHE}"

echo "Running tests including E2E coverage"
go test -v -tags e2e -coverpkg=./... -coverprofile=coverage.e2e.out ./...

echo "Coverage summary"
go tool cover -func=coverage.e2e.out | tail -n 1

echo "Tests including E2E passed"
