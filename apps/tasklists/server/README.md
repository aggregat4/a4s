# Server

Go backend for sync and static hosting. Endpoints match `docs/protocol-spec.md`.

Project-wide setup, testing, and deployment documentation lives in `README.md`.

## Run

```
./scripts/run-local.sh
```

## Configuration

Required in OIDC mode (default when `SERVER_AUTH_MODE` is not `dev`):

- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_REDIRECT_URL`

Optional:

- `SERVER_AUTH_MODE` (`dev` to bypass OIDC and force a fixed user id)
- `SERVER_DEV_USER_ID` (default `dev-user` when `SERVER_AUTH_MODE=dev`)
- `OIDC_CLIENT_SECRET`
- `SERVER_SESSION_KEY` (base64 or >=32 chars; defaults to random per startup)
- `SERVER_COOKIE_SECURE` (default `true`, set to `false` for http dev)
- `SERVER_COOKIE_DOMAIN`
- `SERVER_STATIC_DIR` (serve assets from an external directory)

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

To embed frontend in the binary:
```bash
cd client && npm run build
cp -r dist/* ../server/cmd/server/static/
cd ../server && go build ./cmd/server
```
