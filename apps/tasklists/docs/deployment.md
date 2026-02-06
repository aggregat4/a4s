# Deployment Guide

This guide covers how to build and deploy the A4 Tasklists application.

## Overview

A4 Tasklists consists of:
- **Frontend**: TypeScript/Lit SPA (Single Page Application)
- **Backend**: Go HTTP server with SQLite database

The recommended deployment method is a **single self-contained binary** that embeds the frontend.

## Quick Start (Pre-built Binaries)

1. Download the latest release from [GitHub Releases](../../releases)
2. Extract and run:
   ```bash
   chmod +x a4-tasklists-linux-amd64
   # Local development-style auth:
   SERVER_AUTH_MODE=dev ./a4-tasklists-linux-amd64
   ```
   For OIDC-backed deployments, run with OIDC config instead of `SERVER_AUTH_MODE=dev`.
3. Open http://localhost:8080

## Building from Source

### Prerequisites

- Node.js 22+
- Go 1.25+

### Build Script

```bash
./scripts/build-release.sh
```

This creates a `a4-tasklists` binary in the project root. The script acts as canonical documentation for build requirements.

## Configuration

All configuration is via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `SERVER_DB_PATH` | SQLite database file path | `data.db` |
| `SERVER_STATIC_DIR` | External static assets directory (if set, takes priority over embedded assets) | unset |
| `SERVER_AUTH_MODE` | `dev` bypasses OIDC and injects a fixed user id | unset |
| `SERVER_DEV_USER_ID` | User id used when `SERVER_AUTH_MODE=dev` | `dev-user` |
| `OIDC_ISSUER_URL` | OIDC issuer URL (required unless `SERVER_AUTH_MODE=dev`) | unset |
| `OIDC_CLIENT_ID` | OIDC client id (required unless `SERVER_AUTH_MODE=dev`) | unset |
| `OIDC_CLIENT_SECRET` | OIDC client secret | unset |
| `OIDC_REDIRECT_URL` | OIDC callback URL (required unless `SERVER_AUTH_MODE=dev`) | unset |
| `SERVER_SESSION_KEY` | Cookie session key (base64 or 32+ chars). Set this in production to keep sessions valid across restarts. | random per startup |
| `SERVER_COOKIE_SECURE` | Secure cookie flag | `true` |
| `SERVER_COOKIE_DOMAIN` | Cookie domain | unset |

Examples:
```bash
PORT=3000 SERVER_DB_PATH=/var/data/app.db ./a4-tasklists

# OIDC mode (default auth mode)
OIDC_ISSUER_URL=https://issuer.example.com \
OIDC_CLIENT_ID=a4-tasklists \
OIDC_REDIRECT_URL=https://lists.example.com/auth/callback \
SERVER_SESSION_KEY='replace-with-32+chars-or-base64' \
./a4-tasklists
```

## Architecture

### Static File Serving

The server looks for static files in this priority order:

1. **`SERVER_STATIC_DIR`** environment variable - external directory (useful for development)
2. **Embedded files** - frontend built into the binary (production)

### Embedding Frontend

The Go binary uses `//go:embed` to include the frontend:

```go
//go:embed all:static
var staticFS embed.FS
```

During build, `client/dist/` is copied to `server/cmd/server/static/`, then embedded into the binary.

## Release Process

Releases are automated via GitHub Actions (`.github/workflows/release.yml`):

1. Create and push a tag (example): `git tag v1.0.0 && git push origin v1.0.0`
2. Create a GitHub Release for that tag (web UI or `gh release create v1.0.0`).
3. The workflow (trigger: `release.created`) builds for Linux:
   - amd64 (x86_64)
   - arm64 (aarch64)
4. The workflow uploads binaries and checksums to that GitHub Release.


## Systemd Service (Linux)

```ini
# /etc/systemd/system/a4-tasklists.service
[Unit]
Description=A4 Tasklists
After=network.target

[Service]
Type=simple
User=prototype
Group=prototype
WorkingDirectory=/opt/a4-tasklists
ExecStart=/opt/a4-tasklists/a4-tasklists
Environment="PORT=8080"
Environment="SERVER_DB_PATH=/opt/a4-tasklists/data.db"
Environment="OIDC_ISSUER_URL=https://issuer.example.com"
Environment="OIDC_CLIENT_ID=a4-tasklists"
Environment="OIDC_REDIRECT_URL=https://lists.example.com/auth/callback"
Environment="SERVER_SESSION_KEY=replace-with-32+chars-or-base64"
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable: `sudo systemctl enable --now a4-tasklists`
