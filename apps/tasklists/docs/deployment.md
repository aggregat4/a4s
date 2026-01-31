# Deployment Guide

This guide covers how to build and deploy the Prototype Lists application.

## Overview

Prototype Lists consists of:
- **Frontend**: TypeScript/Lit SPA (Single Page Application)
- **Backend**: Go HTTP server with SQLite database

The recommended deployment method is a **single self-contained binary** that embeds the frontend.

## Quick Start (Pre-built Binaries)

1. Download the latest release from [GitHub Releases](../../releases)
2. Extract and run:
   ```bash
   chmod +x prototype-lists-linux-amd64
   ./prototype-lists-linux-amd64
   ```
3. Open http://localhost:8080

## Building from Source

### Prerequisites

- Node.js 22+
- Go 1.23+

### Build Script

```bash
./scripts/build-release.sh
```

This creates a `prototype-lists` binary in the project root.

### Manual Build

```bash
# 1. Build frontend
cd client
npm ci
npm run build

# 2. Copy to server's static directory
mkdir -p ../server/cmd/server/static
cp -r dist/* ../server/cmd/server/static/

# 3. Build Go binary
cd ../server
go build -ldflags="-s -w" -o ../prototype-lists ./cmd/server
```

## Configuration

All configuration is via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `SERVER_DB_PATH` | SQLite database file path | `data.db` |

Example:
```bash
PORT=3000 SERVER_DB_PATH=/var/data/app.db ./prototype-lists
```

## Architecture

### Static File Serving

The server looks for static files in this priority order:

1. **`SERVER_STATIC_DIR`** environment variable - external directory (useful for development)
2. **Embedded files** - frontend built into the binary (production)
3. **Fallback** - `../client/dist` relative to binary (development)

### Embedding Frontend

The Go binary uses `//go:embed` to include the frontend:

```go
//go:embed all:static
var staticFS embed.FS
```

During build, `client/dist/` is copied to `server/cmd/server/static/`, then embedded into the binary.

## Release Process

Releases are automated via GitHub Actions (`.github/workflows/release.yml`):

1. Push a tag: `git tag v1.0.0 && git push origin v1.0.0`
2. GitHub Actions builds for Linux:
   - amd64 (x86_64)
   - arm64 (aarch64)
3. Creates a GitHub Release with binaries and checksums

## Docker Deployment (Optional)

While the binary approach is preferred, you can also use Docker:

```dockerfile
FROM node:22-alpine AS frontend
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM golang:1.23-alpine AS backend
WORKDIR /app
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=frontend /app/dist ./cmd/server/static
RUN go build -ldflags="-s -w" -o prototype-lists ./cmd/server

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=backend /app/prototype-lists .
EXPOSE 8080
CMD ["./prototype-lists"]
```

## Systemd Service (Linux)

```ini
# /etc/systemd/system/prototype-lists.service
[Unit]
Description=Prototype Lists
After=network.target

[Service]
Type=simple
User=prototype
Group=prototype
WorkingDirectory=/opt/prototype-lists
ExecStart=/opt/prototype-lists/prototype-lists
Environment="PORT=8080"
Environment="SERVER_DB_PATH=/opt/prototype-lists/data.db"
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable: `sudo systemctl enable --now prototype-lists`
