# Server

Skeleton for the Go backend. Endpoints match `docs/protocol-spec.md` but are
currently stubbed.

## Run

```
cd server
export SERVER_DB_PATH=./data.db
go run ./cmd/server
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
