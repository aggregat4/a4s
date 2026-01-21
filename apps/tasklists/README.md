# Prototype Lists

Prototype Lists is a browser-based task manager that showcases collaborative-friendly data structures (CRDTs) while keeping the UI deliberately lightweight. The app has ordered collections, multi-list drag-and-drop, keyboard flows, and persistent storage without a traditional backend.

## Architecture Overview

The application is organized around a clear separation between presentation logic, domain orchestration, and persistence:

- **UI layer (`<a4-lists-app>`)** renders the sidebar, keyboard move dialog, and `<a4-tasklist>` custom elements. The app shell owns these widgets, wires DOM events, and forwards intent to the repository.
- **List repository (`src/app/list-repository.ts`)** is the single source of truth for domain data. It initializes CRDT instances, hydrates them from IndexedDB via the storage layer, exposes query helpers, and surfaces observable change streams (`subscribeList`, `subscribeRegistry`, `subscribe`).
- **CRDT layer (`src/domain/crdt/*.ts`)** contains `ListsCRDT` for the registry (which lists exist and in what order) and `TaskListCRDT` for per-list ordered tasks. Both derive from a shared `OrderedSetCRDT`, so operations like insert/move/remove remain conflict-free and commutative.
- **Storage (`src/storage/*.ts`)** persists serialized snapshots plus the operation log in IndexedDB. `hydrateFromStorage` replays everything back into the CRDTs during boot, while `_persistList` / `_persistRegistry` flush writes asynchronously after every mutation.

### Data Flow At A Glance

1. **Bootstrap:** `bootstrapListsApp()` creates `<a4-lists-app>` and calls its `initialize()` after `ListRepository.initialize()` hydrates state. The repository creates an IndexedDB-backed storage instance, and the UI (via `ensureDemoData`) optionally pre-populates demo lists *using only public repository APIs*. After that, stored registry + list operations are replayed through their CRDTs before `subscribeRegistry` notifies the UI.
2. **Rendering:** For each list reported by the repository, `<a4-lists-app>` instantiates `<a4-tasklist>` and injects `listRepository` + `listId`. Each custom element subscribes to live list snapshots (`subscribeList`) and mirrors them into its internal reducer so lit rendering can diff efficiently.
3. **User actions:** When a user edits, reorders, or drags a task, the custom element delegates to the repository (`insertTask`, `moveTask`, `renameList`, etc.). The repository updates the relevant CRDT(s), emits change events, and persists the resulting operations/snapshots in the background.
4. **Feedback loop:** CRDT state changes propagate back to `<a4-lists-app>` (for sidebar counts, ordering, and dialogs) and to each `<a4-tasklist>` instance, which rerenders without re-querying storage. Because CRDT operations encode intent + ordering metadata, eventual consistency is preserved even if multiple actors were to apply changes offline.

### Typical Interaction Walkthrough

1. **Drag a task to a new list:** `<a4-tasklist>` emits an `itemMoved` detail that `<a4-lists-app>` converts into `repository.moveTask(...)`. The repository asks the source/target `TaskListCRDT` instances to generate remove/insert operations, persists both batches, and emits list-level updates so each component redraws once.
2. **Rename a list:** Sidebar actions call `repository.renameList(listId, title)`. `ListsCRDT` and the list’s `TaskListCRDT` both generate rename operations (so the registry ordering view and the list header stay in sync). After persistence, sidebar buttons and the main title update via registry subscriptions, while the active `<a4-tasklist>` updates via its per-list subscription.
3. **Search across lists:** The UI never queries storage directly. Instead, it filters the cached snapshots already supplied by the repository, keeping storage I/O on the initialization path only.

This flow ensures the UI stays responsive (mutations resolve against in-memory CRDTs), the repository maintains authoritative ordering semantics, and storage writes happen asynchronously without blocking user interactions.

## Build Pipeline

The build produces static assets by bundling TypeScript entrypoints with esbuild. This allows the UI to import npm packages like `lit` directly, while keeping the runtime deployment as plain ESM served from `dist/`.
