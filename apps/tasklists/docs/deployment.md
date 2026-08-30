# Deployment

A4 Tasklists release is a single Go binary with embedded frontend assets.
Build deployment artifacts through the common monorepo packaging command.

## Build and package

```bash
task package APP=tasklists VERSION=v1.5.0
```

The command produces a `tasklists` tarball and adjacent checksum in
`dist/releases/`. The archive contains `tasklists` directly at its root. It
builds the frontend through the root pnpm workspace, embeds it in the server
binary, and restores the source static directory when finished.

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
./tasklists
```

## Static assets

The server prefers `SERVER_STATIC_DIR` when it is configured, then falls back
to assets embedded in the release binary. The packaging command prepares the
embedded assets; use it instead of manually copying `client/dist` files.

## Example Linux service

The canonical production unit is
[`../../../deploy/systemd/tasklists.service`](../../../deploy/systemd/tasklists.service),
with its environment template at
[`../../../deploy/env/tasklists.env.example`](../../../deploy/env/tasklists.env.example).
It uses the normalized `/opt/a4services/tasklists` directory and
`tasklists.service` unit name. The repository deployment guide also documents
the one-time migration from the old `a4tasklists` names.
