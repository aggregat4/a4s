# TODO

- Make Ctrl+Home and Ctrl+End move to begining of first item and end of last item
- Make Ctrl+Enter toggle completion on an item
- when searching across lists, don't show the Add button (do we need to show the show Done checkbox? Takes place but useful? but hide when no results?)
- find out if there are any GUI affordances we can make to inline editable things to make it clearer for the user (show list rename with a floating pencil icon or something)
- Consider refactoring `src/ui/components/app-shell.ts` to avoid `querySelector` by using lit `ref` (or direct element references) for custom elements.

## CRDT Store Open Questions & Follow-ups

- **Tombstone cleanup:** Introduce optional garbage collection when a majority of replicas confirm deletion (future multi-client work).
- **Schema migrations:** Plan version bump strategy for CRDT snapshots so we can evolve data structure without losing user data.
- **Background sync:** For eventual server support, design API to sync batched operations (probably via POST `/lists/{id}/ops`) using same envelopes.
