# A4 Tasklists

A4 Tasklists is a full-stack task manager built around CRDT-based list and item
ordering. The repository includes:

- A TypeScript/Lit single-page app (`client/`)
- A Go HTTP backend with SQLite storage (`server/`)
- Docker-backed Playwright E2E test workflow for consistent local/CI behavior

## Repository Layout

- `client/`: frontend app, unit tests, and Playwright tests
- `server/`: sync API, auth middleware, SQLite storage, and static file hosting
- `docs/`: deployment and operational documentation
- `specs/`: protocol and data format specs
- `features/`: feature notes and design artifacts
- `scripts/`: local/dev/build helper scripts

## Prerequisites

- Node.js `22+` and pnpm `11.3.0`
- Go `1.26.6`
- Docker (required for the default E2E workflow)

Install the workspace dependencies once from the monorepo root:

```bash
pnpm install
```

## Local Development

Run the full app locally (build frontend, run server in dev auth mode):

```bash
./apps/tasklists/scripts/run-local.sh
```

Defaults used by `run-local.sh`:

- `SERVER_AUTH_MODE=dev`
- `PORT=8080`
- `SERVER_DB_PATH=./server/data.db`
- `SERVER_STATIC_DIR=./client/dist`

Open `http://localhost:8080`.

## Testing And Linting

### Server

```bash
go test ./apps/tasklists/server/...
```

The root `Taskfile.yml` provides the full monorepo checks. The command above
runs the Tasklists server test suite directly.

### Client

```bash
pnpm --dir apps/tasklists/client run lint:deps
pnpm --dir apps/tasklists/client run lint:css
pnpm --dir apps/tasklists/client run test:unit
```

### E2E (Playwright + Docker)

```bash
PLAYWRIGHT_USE_DOCKER=1 pnpm --dir apps/tasklists/client run test:e2e
```

`pnpm --dir apps/tasklists/client test` also runs E2E and should be executed with
`PLAYWRIGHT_USE_DOCKER=1`.

To smoke-test the deployed embedded-static path as well:

```bash
PLAYWRIGHT_USE_DOCKER=1 pnpm --dir apps/tasklists/client run test:e2e:embedded
```

## Deployment

Deployment, runtime configuration, release packaging, and Linux service
examples live in `docs/deployment.md`.

### NGINX And SSE

The app uses a Server-Sent Events stream at `/sync/events`. The backend already
sends `X-Accel-Buffering: no`, but you should also raise the proxy read timeout
so NGINX does not close the long-lived connection prematurely:

```nginx
location / {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE support: disable buffering and keep the connection open
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
}
```

If you prefer to keep `proxy_buffering on` globally, the `X-Accel-Buffering`
header the app sends will disable buffering for the SSE endpoint only. In that
case you still need the increased `proxy_read_timeout`.

## API And Data Specs

- Sync protocol: `specs/protocol-spec.md`
- Export/import snapshot schema: `specs/export-snapshot-spec.md`

## Component-Specific Docs

- Backend details: `server/README.md`
- Deployment and runtime docs: `docs/deployment.md`
