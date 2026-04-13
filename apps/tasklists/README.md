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

- Node.js `22+`
- Go `1.25+`
- Docker (required for the default E2E workflow)

## Local Development

Run the full app locally (build frontend, run server in dev auth mode):

```bash
./scripts/run-local.sh
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
cd server
make ci-full
```

`make ci-full` runs formatting checks, imports checks, build, vet, staticcheck,
golangci-lint, modernize, and race tests.

### Client

```bash
cd client
npm run lint:deps
npm run lint:css
npm run test:unit
```

### E2E (Playwright + Docker)

```bash
cd client
PLAYWRIGHT_USE_DOCKER=1 npm run test:e2e
```

`npm test` in `client/` also runs E2E and should be executed with
`PLAYWRIGHT_USE_DOCKER=1`.

## Deployment

Deployment, runtime configuration, release packaging, and Linux service
examples live in `docs/deployment.md`.

## API And Data Specs

- Sync protocol: `specs/protocol-spec.md`
- Export/import snapshot schema: `specs/export-snapshot-spec.md`

## Component-Specific Docs

- Frontend details: `client/README.md`
- Backend details: `server/README.md`
- Deployment and runtime docs: `docs/deployment.md`
