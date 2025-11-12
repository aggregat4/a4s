# AGENTS.md

## Platform Assumptions
- `crypto.randomUUID` is always available in both the browser and test environments. Do not add Math.random-based fallbacks or guards around `crypto`.
- IndexedDB (`window.indexedDB`) is always available in the runtime we target. The codebase should not attempt to fall back to `localStorage` or any other persistence layer for production logic.

Document any future deviations from these assumptions here so other contributors know whether the guarantees have changed.
