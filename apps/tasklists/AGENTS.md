# AGENTS.md

## Platform Assumptions

- `crypto.randomUUID` is always available in both the browser and test environments. Do not add Math.random-based fallbacks or guards around `crypto`.
- IndexedDB (`window.indexedDB`) is always available in the runtime we target. The codebase should not attempt to fall back to `localStorage` or any other persistence layer for production logic.
- `window.localStorage` exists in the production runtime. Logic that needs persistence should use it directly; tests running in non-browser contexts must inject their own storage via the existing hooks.
- `navigator.storage.persist()` is present. Code can call it directly to request persistent quota; tests should stub `navigator.storage` if they rely on this behavior outside the browser.

Document any future deviations from these assumptions here so other contributors know whether the guarantees have changed.
