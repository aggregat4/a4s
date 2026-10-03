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
- Tasklists uses the root pnpm workspace. Its full browser suite must run
  through `task tasklists:test`, which starts its Go server in Docker. To run
  a single test, build the client and run from `apps/tasklists/client`:
  `PLAYWRIGHT_USE_DOCKER=1 pnpm exec playwright test --project=chromium -g "<name>"`.
  Only the `chromium` project is part of `task tasklists:test`; cross-browser
  coverage comes from a separate smoke suite that runs in the
  `mcr.microsoft.com/playwright` image. The `firefox` project in
  `playwright.config.ts`, which runs when `--project` is omitted, is not
  maintained and currently fails.
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
