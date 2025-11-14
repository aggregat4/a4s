# AGENTS.md

## Platform Assumptions

- `crypto.randomUUID` is always available in both the browser and test environments. Do not add Math.random-based fallbacks or guards around `crypto`.
- IndexedDB (`window.indexedDB`) is always available in the runtime we target. The codebase should not attempt to fall back to `localStorage` or any other persistence layer for production logic.
- `window.localStorage` exists in the production runtime. Logic that needs persistence should use it directly; tests running in non-browser contexts must inject their own storage via the existing hooks.
- `navigator.storage.persist()` is present. Code can call it directly to request persistent quota; tests should stub `navigator.storage` if they rely on this behavior outside the browser.

Document any future deviations from these assumptions here so other contributors know whether the guarantees have changed.

## Dev/Test Workflow

- The default way to execute Playwright end-to-end tests is via the Docker harness baked into `playwright.config.ts`. Always run `PLAYWRIGHT_USE_DOCKER=1 npm run test:e2e` (or the headed variant) so that the HTTP server starts inside `mcr.microsoft.com/playwright:v1.56.0-jammy`, mapped to the repository at `/work`.
- `PLAYWRIGHT_DOCKER_IMAGE` can be overridden if you need a different Playwright release, but keep the default unless there's a documented reason to bump.
- Running without Docker (`PLAYWRIGHT_USE_DOCKER` unset) is still possible for local debugging, yet do not rely on it in scripts or documentation so CI and Codex have the exact same environment.
