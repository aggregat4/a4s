## List of Lists Application Plan

### Goals
- Reuse the existing `A4Tasklist` custom element to power multiple task lists inside a unified application shell.
- Provide a sidebar for global navigation and search, while keeping individual list state self-contained.
- Support cross-list search, keyboard-driven item moves, and drag-to-sidebar moves.
- Seed the application with three predefined lists containing realistic sample data (≈20 items each).
- Defer persistence; rely on in-memory state managed by each `A4Tasklist` instance.

### Architecture Overview
- **Core Components**
  - `A4Tasklist` (existing): the single-list custom element remains the source of truth for its tasks. Enhance only as necessary to expose methods/events for external orchestration.
  - `ListsApp` controller: lightweight coordinator that manages list metadata, the active list, global search state, and cross-list actions (move items, search broadcast).
  - `Sidebar` view: renders global search input, list navigation, and management controls (add, rename, delete). Acts as drag-drop target surface for moving tasks between lists.
  - `KeyboardMoveDialog`: modal utility invoked when moving items via keyboard shortcut.
- **State Strategy**
  - Each `A4Tasklist` retains its own internal store and logic (items array, filtering, ordering).
  - `ListsApp` tracks only metadata: `{ lists: [{ id, name, element }], activeListId, searchQuery }`.
  - Communication relies on a small set of public methods/events:
    - Methods consumed by controller: `setTitle(name)`, `applyFilter(query)`, `clearFilter()`, `getItems()`, `removeItemById(id)`, `prependItem(item)`, `focusItem(id)`.
    - Events emitted to controller: `taskAdded`, `taskDeleted`, `taskReordered`, `taskMoveRequest`, `taskSelected` (for keyboard focus context).

### UI Layout
- **Sidebar (left)**
  - Global search input (debounced).
  - Scrollable list of lists showing name, item count, active highlight, and drop target affordances.
  - Buttons for “Add List”, “Rename List”, “Delete List”.
  - Optional stats (e.g., filtered match counts) displayed inline during search mode.
- **Main Content (right)**
  - Default: only the active list’s `A4Tasklist` rendered/visible.
  - Search mode: all lists stacked vertically, each showing its filtered results and title header for clarity.
  - Each list retains controls for adding/reordering tasks within itself (as provided by `A4Tasklist`).

### Seed Data
- On initialization, instantiate three lists with seeded items resembling the existing demo data (titles like “Inbox”, “Todo”, “Contextual”).
- Each list contains roughly 20 items mixing completed and pending states to exercise functionality.
- Seed data handled in controller boot logic before user interactions.

### Interaction Flows
- **Global Search**
  - Sidebar search input updates `searchQuery` state (debounce ~150ms).
  - Controller calls `applyFilter(searchQuery)` on every list:
    - In empty query state: ensure only active list is visible and all other lists have filters cleared.
    - In non-empty query state: reveal all lists, each shows only matches (via `A4Tasklist`’s internal filtering). Lists emit match counts for sidebar display.
  - Clearing search transitions back to single-list view and calls `clearFilter()` on each list.
- **Active List Selection**
  - Clicking a sidebar entry sets `activeListId`, visually highlights selection, ensures the corresponding `A4Tasklist` element is visible while hiding others (when search is empty).
  - Maintains focus state (e.g., newly active list receives focus on header or first task).
- **Moving Items (Keyboard)**
  - Inside `A4Tasklist`, pressing the move shortcut (e.g., “META+M” key or dedicated button) emits `taskMoveRequest` with `{ taskId, taskData }`.
  - Controller opens `KeyboardMoveDialog` listing all other lists (ordered as in sidebar). Supports arrow navigation and Enter to confirm; ESC cancels.
  - On confirmation, controller performs move:
    1. Calls `removeItemById(taskId)` on source list.
    2. Calls `prependItem(taskData)` on target list.
    3. Calls `focusItem(taskId)` on target list to maintain context (optional).
  - Modal closes and returns focus to originating list element.
- **Moving Items (Drag & Drop)**
  - `A4Tasklist` enables dragging tasks, setting `dataTransfer` payload with serialized task details.
  - Sidebar list entries register `dragenter`, `dragleave`, `dragover`, `drop` handlers:
    - Highlight entry on hover.
    - On drop, controller retrieves payload, removes item from source, prepends to target, and triggers a brief visual confirmation (e.g., flash highlight).
  - Supports moving only when not in search mode to avoid layout shifts or clarifies behavior (decide visual cues accordingly).
- **List Management**
  - Add List: prompts user for name (default “New List”), creates new `A4Tasklist`, seeds it empty, registers drag targets, selects it as active.
  - Rename List: updates internal metadata and calls `setTitle(name)` on the respective `A4Tasklist`.
  - Delete List: confirms action; on approval, removes element and metadata. If deleting active list, choose next list (or previous) as new active. Prevent deletion when only one list remains to preserve app functionality.

### Enhancements to `A4Tasklist`
- Verify or add:
  - Public setters/getters for title and items.
  - Ability to externally trigger filtering without exposing internal implementation details.
  - Emission of `taskMoveRequest` (include task content snapshot suitable for rehydration).
  - Focus management hooks (`focusItem`) to improve UX after moves.
  - Optional: method to report match counts after applying filter so sidebar can reflect counts.

### Controller Logic
- Initialize with seeded lists:
  - Create metadata array and corresponding DOM elements.
  - Append `A4Tasklist` instances to main container; mark one as active.
  - Populate each with seed data via `setItems`.
- Event handling:
  - Bind sidebar events to controller actions.
  - Listen to list events for cross-list features and for potential future persistence hooks.
  - Manage view mode (single vs. search) by toggling CSS classes on container or lists.
- Utility functions:
  - `moveTask(sourceId, targetId, task)` encapsulates remove + prepend operations.
  - `updateSearchMode()` toggles layout based on `searchQuery`.
  - `refreshSidebarCounts()` updates counts (total and filtered).

### Accessibility & UX Considerations
- Ensure keyboard shortcut is discoverable (tooltip or inline hint).
- Modal is accessible: focus trapped, labelled, supports screen readers.
- Drag targets communicate state via `aria-dropeffect` or equivalent attributes.
- Search mode clearly labels each list; list titles include `aria-level` heading semantics.
- Provide empty-state messages when a list has no items or no matches.

### Implementation Order
1. Audit and extend `A4Tasklist` API to expose needed hooks (filters, move requests, focus).
2. Build `ListsApp` scaffolding: seed three lists, render sidebar, manage active list visibility.
3. Implement global search flow and view-mode toggling.
4. Wire keyboard move dialog and shared move logic.
5. Add drag-to-sidebar move support with visual feedback.
6. Finish list management actions (add/rename/delete) within controller.
7. Polish UI states and run manual testing checklist.
8. Extend existing single-list tests with a higher-level application test that covers multi-list initialization, global search, and cross-list moves.

### Manual Testing Checklist
- Verify initial render shows seeded active list with ~20 items.
- Switch between lists via sidebar; ensure only one visible when search empty.
- Enter global search term; confirm all lists appear, filtered results correct, counts update.
- Clear search; confirm return to single-list view and filters reset.
- Trigger keyboard move from active list; confirm modal navigation, item moves, focus behavior.
- Drag item to another list name; verify item relocates and target highlights.
- Add, rename, and delete lists; ensure state and visibility remain consistent.
