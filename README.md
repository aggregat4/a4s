# A4S

A4S is the Aggregat4 monorepo. It contains independently deployable
applications under `apps/` and shared Go packages under `pkg/`.

## Layout

- `apps/rssgrid`: RSS reader and feed service
- `apps/bookmarks`: bookmark management service
- `apps/comments`: Comment Service
- `apps/idp`: OpenID Provider
- `apps/tasklists`: Tasklists client and server
- `pkg`: shared Go libraries

The migration retains each source project’s rewritten Git history and
namespaced release tags. Cross-project feature changes belong in follow-up
commits.

## Development

Prerequisites are Go `1.26.6`, Node.js `22+`, pnpm `11.3.0`, Docker (for the
Tasklists browser suite), and [Go Task](https://taskfile.dev/). Install the
pinned task runner once and make its Go bin directory available on `PATH`:

```bash
go install github.com/go-task/task/v3/cmd/task@v3.53.1
```

Install the JavaScript workspace dependencies, then use the root tasks:

```bash
pnpm install
task build
task test
task lint
task ci
```

`task ci` runs linting, all tests, and all builds sequentially. Application
specific commands remain available through the namespaced task names such as
`task idp:test` and `task tasklists:build`.

## Deployment

Canonical Debian systemd units, Nginx sites, sanitized configuration examples,
and operational runbooks live in [`deploy/`](deploy/README.md). Production
secrets and mutable service data remain outside the repository.

Build a versioned Linux deployment archive and checksum for one application
with the common packaging task:

```bash
task package APP=rssgrid VERSION=v1.5.0
task package APP=tasklists VERSION=tasklists/v1.5.0
```

Outputs are written to the ignored `dist/releases/` directory by default.

## Publishing releases

Pushing an application-scoped release tag starts the
[`Publish release`](.github/workflows/release.yml) workflow. It accepts these
tag forms: `rssgrid/vX.Y.Z`, `bookmarks/vX.Y.Z`, `comments/vX.Y.Z`,
`idp/vX.Y.Z`, and `tasklists/vX.Y.Z`. The tag must point to a commit reachable
from `main`.

For example, after the release commit has been merged into `main`:

```bash
git tag -a tasklists/v1.5.0 -m "Tasklists v1.5.0"
git push origin tasklists/v1.5.0
```

The workflow re-runs `task ci`, builds the matching Linux/amd64 package, checks
its SHA-256 file, and creates a GitHub Release with the archive and checksum as
assets. Generated notes start at the previous tag for that same service;
prerelease tags become GitHub prereleases, and no service release is marked as
repository-wide “Latest”. It never deploys to a host. The repository must allow
GitHub Actions to use a write-capable workflow token; the workflow requests only
`contents: write`.
