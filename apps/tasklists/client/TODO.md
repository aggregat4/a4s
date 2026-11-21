# TODO

- **Saved searches:** store searches to run again later.
  - Probably named after their search string.
  - Clicking a saved search replaces the current search with it.
  - Pin them near the search field, or at least somewhere easy to reach.
  - They belong to no one list; a saved search runs across all lists, like the search field.
  - They need not sync across devices for now; keeping them on the device is enough.
- Consider refactoring `src/ui/components/app-shell.ts` to avoid `querySelector` by using lit `ref` (or direct element references) for custom elements.

## CRDT Store Open Questions & Follow-ups

- **Tombstone cleanup:** Introduce optional garbage collection when a majority of replicas confirm deletion (future multi-client work).
- **Schema migrations:** Plan version bump strategy for CRDT snapshots so we can evolve data structure without losing user data.

## Flaky tests

None of these have been investigated yet.

- "tasklist header mirrors title, search, and show-done state" fails only in CI (first seen in run 38133330500). A failing CI run uploads `client/test-results`, with traces, as `tasklists-test-results`; diagnose the next recurrence from that.
- The OIDC test "expired session reauthenticates through the identity provider" failed once locally with `page.goto: net::ERR_ABORTED` and passed on rerun.
- The PWA test "app loads from service worker cache when offline" failed once locally when waiting for the service worker timed out, and passed on rerun.
