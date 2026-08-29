# A4S contributor notes

## Repository boundaries

- Keep applications independently buildable and deployable under `apps/`.
- Keep shared Go code under `pkg/`; it must not depend on application code.
- There is one Go module at the repository root. Do not add nested `go.mod`
  files or app-local dependency locks.
- Preserve application behavior while changing structure. Keep refactors,
  dependency upgrades, and deployment changes in distinct commits.

## Tooling and validation

- Use the root Taskfile for repository orchestration: `task build`,
  `task test`, `task lint`, and `task ci`.
- The required Go checks are `gofmt`, `go vet`, `go mod verify`, and
  `govulncheck`. Do not add `golangci-lint`, `staticcheck`, or `goimports` as
  required tooling.
- `task modernize` is a pinned, report-only review tool. Modernization changes
  should be deliberate, separately reviewed work.
- Tasklists uses the root pnpm workspace. Its browser suite must run through
  `task tasklists:test`, which starts its Go server in Docker.

## Application-specific invariants

- Bookmarks is the only Echo application. Its Echo OIDC and CSRF adapters stay
  under `apps/bookmarks/internal`; shared packages expose standard `net/http`
  APIs only.
- Tasklists targets browsers with `crypto.randomUUID`, IndexedDB,
  `localStorage`, and `navigator.storage.persist()`. Keep controls visible,
  avoid toast notifications, and populate its state store before emitting UI
  events.
- Comments and OpenID Provider use mtlog. Keep its curly-brace interpolation
  style and do not use `.With` metadata logging in those applications.
- For UI work, prefer semantic accessible HTML, CSS custom properties for
  reusable values, and CSS nesting where appropriate.
