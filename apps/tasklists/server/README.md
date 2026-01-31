# Server

Go backend for sync and static hosting. Endpoints match `docs/protocol-spec.md`.

## Quick Start

```bash
# Development (serves frontend from ../client/dist or SERVER_STATIC_DIR)
cd server
go run ./cmd/server

# Production (requires built frontend embedded)
./scripts/build-release.sh
./prototype-lists
```

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `SERVER_DB_PATH` | SQLite database file path | `data.db` |
| `SERVER_STATIC_DIR` | External static files directory (optional) | - |

## Build and Lint

```bash
cd server
make build       # Build binary
make lint        # Basic lint (fmt + vet)
make lint-full   # Full lint (fmt, imports, vet, staticcheck, golangci-lint)
make test        # Run tests
make test-race   # Run tests with race detector
make ci-full     # Full CI pipeline
```

## Static File Serving

Static files are served in priority order:

1. `SERVER_STATIC_DIR` env var (if set)
2. Embedded files in binary (production builds)
3. `../client/dist` (development fallback)

To embed frontend in the binary:
```bash
cd client && npm run build
cp -r dist/* ../server/cmd/server/static/
cd ../server && go build ./cmd/server
```

## Endpoints

- `GET /` - Static files (SPA)
- `GET /sync/bootstrap` - Get initial sync data
- `POST /sync/push` - Push operations
- `GET /sync/pull?since=` - Pull operations since seq
- `POST /sync/snapshot` - Import snapshot (with `X-Client-ID` header)
- `GET /healthz` - Health check
