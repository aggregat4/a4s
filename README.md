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
