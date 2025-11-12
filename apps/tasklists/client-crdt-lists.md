# Client-side CRDT-backed Lists – Implementation Plan

## Goals & Constraints

- Maintain eventual consistency of each task list so future multi-device sync can merge without conflicts.
- Support full offline usage with durable browser persistence, no server required initially.
- Keep code approachable for front-end contributors; prefer clear data structures over hyper-optimized algorithms.
- Reuse as much of the existing UI (`index.html`, custom element `A4TaskList`, sidebar logic) as possible, only refactoring where CRDT integration requires it.

## Phase 1 – CRDT Foundations

1. **Define shared utilities**
   - Introduce `lib/crdt/ids.js` with helpers for generating stable actor IDs and Lamport clocks.
     - Persist a random `actorId` in `localStorage` once; reuse across sessions.
     - Expose `nextClock(remoteClock)` to bump a Lamport counter whenever we create/apply an operation.
   - Add `lib/crdt/position.js` implementing fractional indexing similar to Logoot/LSEQ.
     - Positions are arrays of `{ digit: number, actor: string }`.
     - Provide `between(left, right, { base = 1024, depth = 6 })` to create dense positions with deterministic tie-breaking by actor.

2. **Model list items as a CRDT**
   - Create `lib/crdt/task-list-crdt.js` exporting a `TaskListCRDT` class.
     - Internal state: `items` map keyed by `itemId`, storing `{ id, pos, content, done, createdAt, updatedAt, deletedAt }`.
     - Track `tombstones` implicitly via `deletedAt !== null`.
     - Maintain `clock` (Lamport) and `actorId` references.
   - Define operation envelope shared across clients:

     ```ts
     type Operation =
       | { type: "insert", itemId, payload: { text, done, pos }, clock, actor }
       | { type: "remove", itemId, clock, actor }
       | { type: "move", itemId, payload: { pos }, clock, actor }
       | { type: "update", itemId, payload: { text?, done? }, clock, actor }
       | { type: "renameList", payload: { title }, clock, actor };
     ```

   - Implement `applyOperation(op)` with idempotency:
     - Ignore duplicate clocks (store `seenOps` hash of `${clock}:${actor}`).
     - For inserts, keep the earliest insert per `itemId`; later inserts with newer clocks overwrite text/done but not `pos`.
     - For updates/removes/moves, apply only if `op.clock` is greater than the stored `updatedAt`/`deletedAt`.
   - Provide derived views:
     - `getSnapshot({ includeDeleted = false })` → array sorted by `pos`.
     - `toListState()` → `{ title, items: [{ id, text, done }] }` to feed the existing Redux-like reducer.
   - Implement mutation helpers that generate operations (`generateInsert`, `generateToggle`, etc.) for local UI events; helpers should return `{ op, resultingSnapshot }`.

3. **List registry CRDT**
   - Add `lib/crdt/lists-crdt.js` for managing multiple lists.
     - Use an Observed-Remove Map keyed by `listId` with values `{ title, createdAt, updatedAt, pos }`.
     - Support operations: `createList`, `removeList`, `reorderList`.
     - Use the same fractional positions to order lists in the sidebar.
   - Ensure registry emits change events so `ListsApp` can refresh sidebar order without direct access to CRDT internals.

4. **Documentation & developer ergonomics**
   - Document CRDT concepts inline with succinct comments describing intent (especially around position math and Lamport checks).
   - Provide a README section (or extend `client-crdt-lists.md`) summarizing the operations contract for future sync services.

## Phase 2 – Persistence & Offline Durability

1. **Storage abstraction**
   - Create `lib/storage/list-storage.js` with asynchronous API:

     ```ts
     loadAllLists(): Promise<Array<{ listId, snapshot, ops }>>
     loadList(listId): Promise<{ snapshot, ops }>
     persistOperations(listId, opsBatch, { snapshot }): Promise<void>
     pruneOperations(listId, beforeClock): Promise<void>
     ```

   - Backend: IndexedDB (`window.indexedDB`) with a database `protoLists` containing:
     - `store lists`: key `listId`, value `{ metadata, snapshotVersion }`.
     - `store listSnapshots`: key `listId`, value serialized `TaskListCRDT` state.
     - `store operations`: compound key `[listId, clock, actor]` for merge-friendly logs.

2. **Serialization**
   - Create `lib/storage/serde.js` to convert CRDT state/ops into JSON-safe payloads (positions become arrays of primitive tuples to avoid method loss).
   - Ensure versioning metadata is embedded (`schemaVersion`) so future migrations can distinguish formats.

3. **Load / Save workflow**
   - On app startup:
     - Open storage, fetch list registry + per-list snapshots.
     - If storage is empty, the UI bootstrapper (in `index.html`) may call into the repository API to create the demo lists defined in `SEED_LIST_CONFIGS`, preserving order via normal CRDT operations.
   - On every local mutation:
     - Generate operation via CRDT helper.
     - Apply to in-memory CRDT.
     - Enqueue persistence (debounce to batch multiple ops within ~250ms).
     - Persist both operations and updated snapshot version (snapshot only periodically, e.g., every 20 ops or on unload).
   - Implement `navigator.storage.persist?.()` call during initialization to request persistent quota when available.

4. **Compaction and recovery**
   - Provide `pruneOperations` that keeps only ops newer than the latest snapshot clock and a small margin (e.g., keep last 100 ops) to bound storage.
   - Add integrity checks on load: if applying operations to snapshot fails (e.g., corruption), reset the list to last good snapshot and log to console with recovery instructions.

## Phase 3 – Application Integration

1. **Bridge CRDT to existing UI**
   - Introduce `lib/app/list-repository.js` encapsulating CRDT instances + storage.
     - Methods: `getListView(listId)`, `createList`, `removeList`, `renameList`, `moveTask`, `insertTask`, `toggleTask`, `updateTaskText`.
     - Emit `change` events to subscribers with `{ listId, state }` snapshots.
   - Refactor `A4TaskList` inside `index.html`:
     - Replace `createStore` (`listReducer`) usage with observer pattern subscribing to `listRepository`.
     - Maintain compatibility by translating CRDT snapshots into the reducer state; minimal UI changes.
     - Ensure inline editor callbacks call repository methods instead of dispatching Redux-like actions.
   - Update `ListsApp` logic (index.html:3200+) to:
     - Initialize repository asynchronously before rendering lists.
     - Use registry CRDT to build sidebar list order.
     - When user creates/renames/deletes lists, call repository methods and rely on emitted updates for UI refresh.

2. **Cross-list moves**
   - When moving a task between lists (`ListsApp.moveTask`):
     - Generate a `remove` operation in source list CRDT.
     - Generate an `insert` in target list CRDT using new position (front of list by default).
     - Persist both operations in a single transactional call to storage to avoid partial moves.

3. **Search, filtering, and metrics**
   - Keep existing search/tokenization logic (`A4TaskList.performSearch`) but ensure it re-runs whenever CRDT change events deliver a new snapshot.
   - Update metrics (`itemcountchange`, `searchresultschange`) to rely on CRDT-derived counts so sidebar stays in sync.

4. **Saving list titles & order**
  - When `titlechange` fires from `A4TaskList`, call repository `renameList` which updates the list's `TaskListCRDT` title register and persists.
   - For list deletion, emit registry operation marking list as removed; cascade to delete per-list storage after a grace period to support undo later.

5. **Graceful degradation**
   - If IndexedDB unavailable or storage write fails, surface a toast/banner informing the user sync is disabled, but continue in-memory operation.
   - Ensure all repository methods throw descriptive errors logged to console for debugging.

## Phase 4 – Testing, Tooling, and Observability

1. **Unit tests for CRDT logic**
   - Add a light-weight test harness (e.g., `vitest` or `uvu`) under `tests/crdt` to cover:
     - Concurrent inserts producing consistent order across replicas.
     - Remove + re-insert behaviour.
     - Lamport clock conflict resolution for `update` and `renameList`.
     - Serialization round-trips.
   - Simulate multi-actor scenarios by applying ops in differing orders and asserting identical snapshots.

2. **Integration tests**
   - Extend Playwright tests to ensure persistence works:
     - Create tasks, reload page, verify tasks persist and order matches expectations.
     - Toggle offline mode (Playwright `context.setOffline(true)`) to confirm functionality without network.

3. **Developer tooling**
   - Add debug helpers (behind `NODE_ENV !== "production"`) to inspect CRDT state via `window.__listsDebug.getState()`.
   - Document manual recovery steps (clearing storage) in `TESTING.md` or new `docs/persistence.md`.

4. **Analytics & logging**
   - Add structured console logs when storage initialization fails or data migrates, to aid early debugging.
   - Consider feature flag (`localStorage['lists.crdt.enabled']`) to allow gradual rollout during development.

## Open Questions & Follow-ups
- **Undo/Redo:** Decide whether to derive from CRDT op log or implement separate command history.
- **Tombstone cleanup:** Introduce optional garbage collection when a majority of replicas confirm deletion (future multi-client work).
- **Schema migrations:** Plan version bump strategy for CRDT snapshots so we can evolve data structure without losing user data.
- **Background sync:** For eventual server support, design API to sync batched operations (probably via POST `/lists/{id}/ops`) using same envelopes.

This plan provides a staged path: start with the CRDT core, add persistence, then integrate with the UI while keeping code maintainable and ready for future multi-client sync.
