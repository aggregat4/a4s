# Repository Guidelines

## Project Structure & Module Organization

The service uses standard Go modules. `cmd/runserver` contains the HTTP server entry point, while `cmd/createencryptionkey` and `cmd/createservice` provide admin CLIs. Shared domain logic lives under `internal/domain`, persistence in `internal/repository`, and HTTP handlers, assets, and auth helpers in `internal/server`. Built artifacts are written to `bin/`. Configuration samples and embeddings sit in `example/`, and automation scripts in `scripts/`.

## Build, Test, and Development Commands

Use `scripts/build.sh` to compile production binaries with the `fts5` tag into `bin/`. Run `scripts/runexampleserver.sh` to start the server locally with the example SendGrid settings; pair it with `scripts/runcreateexampleservice.sh` to seed a demo service and encryption key. `go run cmd/runserver/main.go` works for quick iterations. Always execute `scripts/test.sh` before pushing, and `scripts/lint.sh` to run `golangci-lint`.

## Coding Style & Naming Conventions

Format Go code with `gofmt` (tab indentation) or let `goimports` run via your editor; the lint target expects canonical Go spacing and import grouping. Package names stay lowercase and concise, files are named after the feature they host (e.g., `server_utils.go`). Keep exported symbols CamelCase and describe intent in doc comments when they form part of the public API.

## Testing Guidelines

Unit and integration tests reside in `internal/server/*_test.go` and follow the standard `_test.go` suffix. Target deterministic tests; prefer table-driven layouts for handlers and domain functions. Run `scripts/test.sh` (wraps `go test ./...`) locally; enable the commented `-race` and coverage commands when touching concurrency or persistence code. New features should include tests that cover both success and failure paths.

## Commit & Pull Request Guidelines

Commits mirror the existing log: a single-line, capitalized imperative summary under ~70 characters, followed by focused changes. Squash fixups before review. Pull requests should link related issues, outline functional impact, and note any manual steps (schema migrations, new env vars). Attach screenshots or curl transcripts when UI or API behavior changes.

## Security & Configuration Tips

Sensitive keys come from environment variables; never hardcode secrets. Document required variables in PRs and add sane defaults to example files. When adding dependencies, prefer vetted libraries and update `go.sum` via `go mod tidy`.

## Architecture

* This is a go web application that has a vanilla js frontend where we use modern baseline css, html and javascript features.
* Reusable components are written as web components.
* HTML should be accessible and semantic.
* CSS should use custom-properties for reusable design tokens, style selectors should use nesting where appropriate and colors should take into account contrast and accessibility.
* JavaScript is targeting modern baseline browsers.
