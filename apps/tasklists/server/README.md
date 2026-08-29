# Server

Go backend for sync and static hosting. Endpoints match
`../specs/protocol-spec.md`.

Repository-wide setup lives in `../README.md`. Deployment, runtime
configuration, and release packaging live in `../docs/deployment.md`.

## Run

```
./scripts/run-local.sh
```

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
