# Server

Go backend for sync and static hosting. Endpoints match `docs/protocol-spec.md`.

## Run

```
./scripts/run-local.sh
```

## Build and Lint

```
cd server
make build
make lint
```

## Endpoints

- `GET /sync/bootstrap`
- `POST /sync/push`
- `GET /sync/pull`
- `GET /healthz`
