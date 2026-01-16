# Feature Design: Undo/Redo

## Assumptions

- Undo/redo is local to the current user/session.
- Undo/redo covers list registry operations and task list operations.
- Keyboard shortcuts are required (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Cmd/Ctrl+Y).
- Undo/redo history is global, not scoped per list.
- Text edits should be coalesced when possible.
- Delete list undo should restore the list and its tasks.

## Scope

In scope:
- List registry operations: create, remove, rename, reorder.
- Task list operations: insert, remove, move, update (text/done), list rename.
- Keyboard shortcut handling at the application shell level.
- Local history stack with undo/redo and optional batching.
- Tests for repository and end-to-end flows.

Out of scope (initially):
- Cross-user or cross-device undo/redo.
- Persisted history across sessions.

## Implementation Plan

1) Inventory operations and define a reversible action shape
- Enumerate all user-initiated mutation paths and the CRDT ops they emit.
- Define a HistoryEntry that includes:
  - scope (registry or list id)
  - forwardOps and inverseOps (CRDT ops)
  - label, timestamp, actor

2) Compute inverse ops at mutation time
- Capture pre-mutation state for affected records.
- Map forward ops to inverse ops:
  - insert -> remove (itemId)
  - remove -> insert (full snapshot: id + data + pos)
  - update -> update (previous data)
  - move/reorder -> move to previous pos
  - rename -> rename with previous title

3) History manager in the repository layer
- Maintain undoStack and redoStack.
- record(entry) for user actions; clear redo on new action.
- undo() applies inverse ops through the same persistence pipeline.
- redo() reapplies forward ops.
- Add batching for text edits with time-based coalescing.

4) UI + keyboard integration
- Global key handler (app shell) for Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z/Cmd/Ctrl+Y.
- Ignore global undo when focused in contenteditable unless action is non-text.

5) Testing strategy
- Unit tests for inverse op computation.
- Integration tests for repository undo/redo.
- E2E tests for list creation/removal, task insertion, reorders, and toggles.

## Open Questions

- Exact batching window for text edits (e.g., 500-1000ms).
- Whether to expose a UI affordance for undo/redo later.
