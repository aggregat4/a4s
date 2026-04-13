# Deployment

A4 Tasklists is typically deployed as a single Go binary with embedded frontend
assets.

## Quick Start

1. Download a release tarball from
   [GitHub Releases](https://github.com/aggregat4/a4-tasklists/releases).
2. Extract it and run the binary:

```bash
tar -xzf a4-tasklists-v1.0.0-linux-amd64.tar.gz
SERVER_AUTH_MODE=dev ./bin/a4-tasklists
```

For production, configure OIDC instead of `SERVER_AUTH_MODE=dev`.

## Build And Package

Build the release binary from source with:

```bash
./scripts/build-release.sh
```

The default output binary name is `a4-tasklists`.

Package a release tarball with:

```bash
./scripts/package-release.sh v1.0.0 linux amd64
```

This writes:

- `dist/a4-tasklists-v1.0.0-linux-amd64.tar.gz`
- `dist/a4-tasklists-v1.0.0-linux-amd64.tar.gz.sha256`

The tarball contains:

- `bin/a4-tasklists`

## Runtime Configuration

All runtime config is provided via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `SERVER_DB_PATH` | SQLite database path | `data.db` |
| `SERVER_STATIC_DIR` | External static assets directory; takes precedence over embedded assets | unset |
| `SERVER_AUTH_MODE` | `dev` bypasses OIDC and injects a fixed user id | unset |
| `SERVER_DEV_USER_ID` | User id used when `SERVER_AUTH_MODE=dev` | `dev-user` |
| `OIDC_ISSUER_URL` | OIDC issuer URL; required unless `SERVER_AUTH_MODE=dev` | unset |
| `OIDC_CLIENT_ID` | OIDC client id; required unless `SERVER_AUTH_MODE=dev` | unset |
| `OIDC_CLIENT_SECRET` | OIDC client secret | unset |
| `OIDC_REDIRECT_URL` | OIDC callback URL; required unless `SERVER_AUTH_MODE=dev` | unset |
| `SERVER_SESSION_KEY` | Cookie session key; base64 or 32+ chars. Set in production to keep sessions valid across restarts. | random per startup |
| `SERVER_COOKIE_SECURE` | Secure cookie flag | `true` |
| `SERVER_COOKIE_DOMAIN` | Cookie domain | unset |

Generate a session key for production with:

```bash
openssl rand -base64 32
```

Example OIDC configuration:

```bash
OIDC_ISSUER_URL=https://issuer.example.com \
OIDC_CLIENT_ID=a4-tasklists \
OIDC_REDIRECT_URL=https://lists.example.com/auth/callback \
SERVER_SESSION_KEY='replace-with-openssl-output' \
./a4-tasklists
```

## Static Assets

Static files are served in this order:

1. `SERVER_STATIC_DIR`, if set
2. Embedded files in the binary

To embed the frontend in the server binary:

```bash
cd client && npm run build
cp -r dist/* ../server/cmd/server/static/
cd ../server && go build ./cmd/server
```

## Example Linux Service Setup

Example runtime config file:

```bash
PORT=8080
SERVER_DB_PATH=data/a4-tasklists.db
OIDC_ISSUER_URL=https://issuer.example.com
OIDC_CLIENT_ID=a4-tasklists
OIDC_REDIRECT_URL=https://lists.example.com/auth/callback
SERVER_COOKIE_DOMAIN=lists.example.com
```

Example secrets file:

```bash
OIDC_CLIENT_SECRET=replace-me
SERVER_SESSION_KEY=replace-with-openssl-output
```

Example `systemd` unit:

```ini
[Unit]
Description=A4 Tasklists
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/a4-tasklists/current
ExecStart=/opt/a4-tasklists/current/bin/a4-tasklists
EnvironmentFile=/etc/a4-tasklists/secrets.env
EnvironmentFile=-/etc/a4-tasklists/runtime.env
Restart=on-failure
RestartSec=2
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
```

Enable the service with:

```bash
sudo systemctl enable --now a4-tasklists
```

## Release Process

Release automation is defined in `.github/workflows/release.yml` and triggers on
GitHub `release.created`:

1. Create and push a tag such as `v1.0.0`.
2. Create a GitHub Release for that tag.
3. The workflow builds Linux `amd64` and `arm64` tarball artifacts.
4. The workflow uploads each artifact plus its matching `.sha256` file to the
   release.
