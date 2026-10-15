# A4S Development Guidelines

## HTML

- Write semantic, accessible, concise HTML

## CSS

- Never use inline styles
- Use custom properties to extract design tokens from CSS and make it easier to change and reuse
- Use CSS nesting to make stylesheets more concise

## Repository boundaries

- Keep applications independently buildable and deployable under `apps/`.
- Keep shared Go code under `pkg/`; it must not depend on application code.
- There is one Go module at the repository root. Do not add nested `go.mod`
  files or app-local dependency locks.
- Preserve application behavior while changing structure. Keep refactors,
  dependency upgrades, and deployment changes in distinct commits.

## Commits and pull requests

- Write commit subjects as `type(app): summary`, for example
  `fix(tasklists): …` or `refactor(rssgrid): …`. Use `deps: …` for
  dependency upgrades.
- Every user-visible change adds an entry under `## [Unreleased]` in the
  affected app's `CHANGELOG.md`, in the same commit. Follow the Keep a
  Changelog sections (`Added`, `Changed`, `Fixed`, …); `task lint` checks
  the file format.
- Do not add `Co-Authored-By` trailers, AI session links, or other
  assistant attribution to commit messages or pull request descriptions.

## Tooling and validation

- Use the root Taskfile for repository orchestration: `task build`,
  `task test`, `task lint`, and `task ci`.
- The required Go checks are `gofmt`, `go vet`, `go mod verify`, and
  `govulncheck`. Do not add `golangci-lint`, `staticcheck`, or `goimports` as
  required tooling.
- `task modernize` is a pinned, report-only review tool. Modernization changes
  should be deliberate, separately reviewed work.
- Direct Go commands need the `fts5` build tag to match the Taskfiles, for
  example `go test -tags=fts5 ./...`.
- Tasklists uses the root pnpm workspace. `task tasklists:test` runs its full
  suite; the browser tests build and start the Go server natively with
  `apps/tasklists/scripts/run-test-server.sh` (no Docker). To run a single
  test, build the client and run from `apps/tasklists/client`:
  `pnpm exec playwright test -g "<name>"`.
- Every browser test is its own dev-mode user (the `a4_dev_user` cookie set in
  `tests/fixtures.ts`), so tests share no server data and all run in parallel.
  A test that opens several devices gets the same user on each of them.
- CI keeps the model tests short (`MODEL_RUNS`, `UI_MODEL_RUNS`); the nightly
  workflow runs them far longer, together with the Firefox and mobile WebKit
  smoke suite (`test:e2e:cross-browser`), which needs those browsers installed
  with `pnpm exec playwright install firefox webkit`.
- Keep tests deterministic: do not depend on the machine's timezone, locale,
  or the current time. Pin them in the test, or compare parsed values rather
  than formatted strings.

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
