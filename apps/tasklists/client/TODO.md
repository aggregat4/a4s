# TODO

- when searching across lists, don't show the Add button (do we need to show the show Done checkbox? Takes place but useful? but hide when no results?)
- Consider refactoring `src/ui/components/app-shell.ts` to avoid `querySelector` by using lit `ref` (or direct element references) for custom elements.

## CRDT Store Open Questions & Follow-ups

- **Tombstone cleanup:** Introduce optional garbage collection when a majority of replicas confirm deletion (future multi-client work).
- **Schema migrations:** Plan version bump strategy for CRDT snapshots so we can evolve data structure without losing user data.
