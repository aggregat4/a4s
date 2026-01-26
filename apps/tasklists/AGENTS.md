# AGENTS.md

## Platform Assumptions

- `crypto.randomUUID` is always available in both the browser and test environments. Do not add Math.random-based fallbacks or guards around `crypto`.
- IndexedDB (`window.indexedDB`) is always available in the runtime we target. The codebase should not attempt to fall back to `localStorage` or any other persistence layer for production logic.
- `window.localStorage` exists in the production runtime. It is ok to use localStorage synchronously for the actor id persistence.
- `navigator.storage.persist()` is present. Code can call it directly to request persistent quota; tests should stub `navigator.storage` if they rely on this behavior outside the browser.

Document any future deviations from these assumptions here so other contributors know whether the guarantees have changed.

## Dev/Test Workflow

- The default way to execute Playwright end-to-end tests is via the Docker harness baked into `client/playwright.config.ts`. Always run `PLAYWRIGHT_USE_DOCKER=1 npm run test:e2e` (or the headed variant) from `client/` so that the HTTP server starts inside a container, mapped to the client workspace at `/work`.
- `PLAYWRIGHT_DOCKER_IMAGE` can be overridden if you need a different Playwright release, but keep the default unless there's a documented reason to bump.
- Running without Docker (`PLAYWRIGHT_USE_DOCKER` unset) is still possible for local debugging, yet do not rely on it in scripts or documentation so CI and Codex have the exact same environment.

## Commit Messages

- First line: concise summary in imperative mood.
- Body: explain the why and key behavior changes; wrap at ~72 chars.

## State Ownership

- Repository/registry updates should populate the store via explicit actions (for example, upsert) before UI events emit metric updates. Avoid using UI event handlers as a backfill path for missing store data.

## UI Guidelines

- Avoid UI that is hidden until hover; controls and indicators should remain visible.
- Do not use toast notifications.
