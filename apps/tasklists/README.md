# A4 Tasklists

A4 Tasklists is a full-stack task manager built around CRDT-based list and item
ordering. The repository includes:

- A TypeScript/Lit single-page app (`client/`)
- A Go HTTP backend with SQLite storage (`server/`)
- Docker-backed Playwright E2E test workflow for consistent local/CI behavior

## Repository Layout

- `client/`: frontend app, unit tests, and Playwright tests
- `server/`: sync API, auth middleware, SQLite storage, and static file hosting
- `docs/`: protocol and data format specs
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

The recommended deployment target is `svc-deploy` managing a single
self-contained Go binary with embedded frontend assets.

### Quick Start (Pre-built Release Tarballs)

1. Download a release tarball from [GitHub Releases](https://github.com/aggregat4/a4-tasklists/releases).
2. Extract it and run the binary:

```bash
tar -xzf a4-tasklists-v1.0.0-linux-amd64.tar.gz
SERVER_AUTH_MODE=dev ./bin/a4-tasklists
```

For production, use OIDC config instead of `SERVER_AUTH_MODE=dev`.

### Build From Source

Canonical build path:

```bash
./scripts/build-release.sh
```

Default output binary name: `a4-tasklists`.

To build a `svc-deploy` artifact locally:

```bash
./scripts/package-release.sh v1.0.0 linux amd64
```

This writes:

- `dist/a4-tasklists-v1.0.0-linux-amd64.tar.gz`
- `dist/a4-tasklists-v1.0.0-linux-amd64.tar.gz.sha256`

### Runtime Configuration

All runtime config is provided via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `SERVER_DB_PATH` | SQLite database path | `data.db` |
| `SERVER_STATIC_DIR` | External static assets directory (takes precedence over embedded assets) | unset |
| `SERVER_AUTH_MODE` | `dev` bypasses OIDC and injects a fixed user id | unset |
| `SERVER_DEV_USER_ID` | User id used when `SERVER_AUTH_MODE=dev` | `dev-user` |
| `OIDC_ISSUER_URL` | OIDC issuer URL (required unless `SERVER_AUTH_MODE=dev`) | unset |
| `OIDC_CLIENT_ID` | OIDC client id (required unless `SERVER_AUTH_MODE=dev`) | unset |
| `OIDC_CLIENT_SECRET` | OIDC client secret | unset |
| `OIDC_REDIRECT_URL` | OIDC callback URL (required unless `SERVER_AUTH_MODE=dev`) | unset |
| `SERVER_SESSION_KEY` | Cookie session key (base64 or 32+ chars). Set in production to keep sessions valid across restarts. | random per startup |
| `SERVER_COOKIE_SECURE` | Secure cookie flag | `true` |
| `SERVER_COOKIE_DOMAIN` | Cookie domain | unset |

Example (OIDC mode):

```bash
OIDC_ISSUER_URL=https://issuer.example.com \
OIDC_CLIENT_ID=a4-tasklists \
OIDC_REDIRECT_URL=https://lists.example.com/auth/callback \
SERVER_SESSION_KEY='replace-with-32+chars-or-base64' \
./a4-tasklists
```

### Static File Serving Order

1. `SERVER_STATIC_DIR` (if set)
2. Embedded assets in the binary

### svc-deploy

Release assets are published in the format `svc-deploy` expects:

- artifact: `a4-tasklists-<version>-linux-amd64.tar.gz`
- checksum: `a4-tasklists-<version>-linux-amd64.tar.gz.sha256`
- binary inside archive: `bin/a4-tasklists`

Example `deploy-map.toml` entry:

```toml
[service.a4-tasklists]
release_url_template = "https://github.com/aggregat4/a4-tasklists/releases/download/{{.Version}}/{{.Artifact}}"
artifact_filename_template = "a4-tasklists-{{.Version}}-linux-amd64.tar.gz"
binary_path = "bin/a4-tasklists"
healthcheck_url = "http://127.0.0.1:8080/healthz"
systemd_unit = "a4-tasklists.service"
db_filename = "a4-tasklists.db"
startup_timeout = 30
rollback_timeout = 30
keep_releases = 5
```

Example `/opt/config-repo/a4-services/services/a4-tasklists/runtime.env`:

```bash
PORT=8080
SERVER_DB_PATH=data/a4-tasklists.db
OIDC_ISSUER_URL=https://issuer.example.com
OIDC_CLIENT_ID=a4-tasklists
OIDC_REDIRECT_URL=https://lists.example.com/auth/callback
SERVER_COOKIE_DOMAIN=lists.example.com
```

Secrets belong in `/etc/a4-services/a4-tasklists.env`, for example:

```bash
OIDC_CLIENT_SECRET=replace-me
SERVER_SESSION_KEY=replace-with-32+chars-or-base64
```

### Linux systemd Example For svc-deploy

```ini
[Unit]
Description=A4 Tasklists
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/a4-services/a4-tasklists/current
ExecStart=/opt/a4-services/a4-tasklists/current/bin/a4-tasklists
EnvironmentFile=/etc/a4-services/a4-tasklists.env
EnvironmentFile=-/opt/a4-services/a4-tasklists/shared/config/runtime.env
Restart=on-failure
RestartSec=2
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl enable --now a4-tasklists
```

### Release Process

Release automation is defined in `.github/workflows/release.yml` and triggers
on GitHub `release.created`:

1. Create and push a tag (example: `v1.0.0`)
2. Create a GitHub Release for that tag
3. Workflow builds linux `amd64` and `arm64` `tar.gz` artifacts
4. Workflow uploads each artifact plus its matching `.sha256` file to the release

## API And Data Specs

- Sync protocol: `docs/protocol-spec.md`
- Export/import snapshot schema: `docs/export-snapshot-spec.md`

## Component-Specific Docs

- Frontend details: `client/README.md`
- Backend details: `server/README.md`
