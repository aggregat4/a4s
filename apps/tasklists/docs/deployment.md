# Deployment

A4 Tasklists release is a single Go binary with embedded frontend assets.
The monorepo release workflow has not been established yet; build and package
artifacts locally from the repository root until that work is complete.

## Build and package

```bash
pnpm install
apps/tasklists/scripts/build-release.sh
apps/tasklists/scripts/package-release.sh v1.0.0 linux amd64
```

The packaging script produces an `a4-tasklists` tarball and checksum in
`apps/tasklists/dist/`. It builds the frontend through the root pnpm workspace,
embeds it in the server binary, and restores the source static directory when
finished.

## Runtime configuration

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `8080` |
| `SERVER_DB_PATH` | SQLite database path | `data.db` |
| `SERVER_STATIC_DIR` | External static assets directory; takes precedence over embedded assets | unset |
| `SERVER_AUTH_MODE` | `dev` bypasses OIDC and injects a fixed user ID | unset |
| `SERVER_DEV_USER_ID` | User ID used when `SERVER_AUTH_MODE=dev` | `dev-user` |
| `OIDC_ISSUER_URL` | OIDC issuer URL; required unless development auth is enabled | unset |
| `OIDC_CLIENT_ID` | OIDC client ID | unset |
| `OIDC_CLIENT_SECRET` | OIDC client secret | unset |
| `OIDC_REDIRECT_URL` | OIDC callback URL | unset |
| `SERVER_SESSION_KEY` | Cookie session key; base64 or 32+ characters | random per startup |
| `SERVER_COOKIE_SECURE` | Secure cookie flag | `true` |
| `SERVER_COOKIE_DOMAIN` | Cookie domain | unset |

Generate a production session key with:

```bash
openssl rand -base64 32
```

Example production configuration:

```bash
OIDC_ISSUER_URL=https://issuer.example.com \
OIDC_CLIENT_ID=a4-tasklists \
OIDC_REDIRECT_URL=https://lists.example.com/auth/callback \
SERVER_SESSION_KEY='replace-with-openssl-output' \
./bin/a4-tasklists
```

## Static assets

The server prefers `SERVER_STATIC_DIR` when it is configured, then falls back
to assets embedded in the release binary. The release scripts prepare the
embedded assets; use them instead of manually copying `client/dist` files.

## Example Linux service

The canonical production unit is
[`../../../deploy/systemd/tasklists.service`](../../../deploy/systemd/tasklists.service),
with its environment template at
[`../../../deploy/env/tasklists.env.example`](../../../deploy/env/tasklists.env.example).
It uses the normalized `/opt/a4services/tasklists` directory and
`tasklists.service` unit name. The repository deployment guide also documents
the one-time migration from the old `a4tasklists` names.
