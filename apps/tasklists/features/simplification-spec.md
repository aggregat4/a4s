# Frontend Simplification Plan

This document outlines incremental refactors to reduce complexity in the client codebase. Each refactor is designed to be completed independently and verified without breaking existing functionality.

---

## Phase 1: Utility Consolidation (Low Risk)

### 1.1 Extract `arraysEqual` to Shared Utilities

**Current State:** `arraysEqual` is implemented in both:
- `app-shell.ts` (line 738)
- `sidebar.ts` as `areOrdersEqual` (line 553)

**Refactor:**
- Create `client/src/shared/array-utils.ts` with a generic `arraysEqual<T>(a: T[], b: T[]): boolean`
- Replace both implementations with imports
- Add unit tests for the utility

**Verification:**
- All existing tests pass
- No behavioral changes in list reordering or sidebar drag-drop

---

### 1.2 Consolidate Count Formatting Utilities

**Current State:** `formatMatchCount` and `formatTotalCount` are:
- Defined in `SidebarCoordinator` (lines 57-65)
- Passed through to `MoveTasksController` via constructor
- Used in `app-shell.ts` both directly and via coordinator
- Also passed to `ListRegistry.getSidebarListData()`

**Refactor:**
- Create `client/src/shared/format-utils.ts` with pure functions:
  ```typescript
  export function formatMatchCount(count: number): string
  export function formatTotalCount(count: number): string
  ```
- Remove methods from `SidebarCoordinator`
- Update `MoveTasksController` to import directly
- Update `app-shell.ts` to import directly
- Update `ListRegistry.getSidebarListData()` to not receive formatters, return raw numbers

**Verification:**
- Sidebar count labels render identically
- Move dialog count labels render identically

---

## Phase 2: Remove Thin Wrappers (Low-Medium Risk)

### 2.1 Inline `SidebarCoordinator`

**Current State:** `SidebarCoordinator` (68 lines) is a pass-through wrapper:
- `wireHandlers()` → `sidebar.setHandlers()`
- `renderSidebar()` → `sidebar.setLists()` with formatting
- Formatting methods (to be moved in 1.2)

**Refactor:**
- Delete `SidebarCoordinator` class
- In `app-shell.ts`, call `sidebarElement.setHandlers()` directly
- In `app-shell.ts`, call `sidebarElement.setLists()` directly with pre-formatted data

**Verification:**
- Sidebar still renders correctly
- All handlers (search, select, add, delete, etc.) work

---

### 2.2 Merge `DragCoordinator` into `DraggableBehavior`

**Current State:**
- `DragCoordinator` (79 lines) wraps `DraggableBehavior`
- Adds event listener management that `DraggableBehavior` already does
- Two levels of abstraction for the same feature

**Refactor:**
- Move `DragCoordinator`'s attach/detach/event cleanup logic into `DraggableBehavior`
- Update `DraggableBehavior` constructor to accept optional callbacks (`onDragStart`, `onDragEnd`, `onDrop`)
- Replace `DragCoordinator` usage with direct `DraggableBehavior` usage
- Delete `DragCoordinator`

**Verification:**
- Task list drag-and-drop works
- Sidebar list reordering works
- FLIP animations still function

---

## Phase 3: State Management Simplification (Medium Risk)

### 3.1 Remove Duplicate State from `ListRegistry`

**Current State:** `ListRegistry` tracks:
- `title: string` (line 22)
- `name: string` (line 23)
- `totalCount: number` (line 30)
- `matchCount: number` (line 31)

These duplicate what's in `app-store` and can be derived from elements.

**Refactor:**
- Remove `title`, `name` from `ListRecord` - use `app-store` selectors instead
- Remove `totalCount`, `matchCount` - query elements when needed
- Simplify `createList()` to not compute display names
- Update `getSidebarListData()` callers to use store data + element queries

**Verification:**
- Sidebar list names display correctly
- List counts update correctly when items change
- No regression in search result counts

---

### 3.2 Simplify `RepositorySync` Action Dispatching

**Current State:** `RepositorySync.handleRegistryChange()` (lines 75-144):
- Dispatches individual `APP_ACTIONS.upsertList` for each list
- Then dispatches bulk `APP_ACTIONS.setRegistry`

**Refactor:**
- Remove individual `upsertList` dispatches
- Ensure `setRegistry` reducer handles the full update correctly
- Verify no listeners depend on the intermediate `upsertList` actions

**Verification:**
- Repository changes still propagate to UI
- No duplicate renders
- Tests pass

---

## Phase 4: Component Decomposition (Medium-High Risk)

### 4.1 Extract Title Editing from `a4-tasklist.ts`

**Current State:** `a4-tasklist.ts` (1000+ lines) handles:
- Task list rendering and state
- Title editing with complex state machine (`isTitleEditing`, `titleOriginalValue`, `titleLiveUpdates`)

**Refactor:**
- Create `a4-tasklist-title.ts` component:
  - Props: `title: string`, `editing: boolean`
  - Events: `titlechange`, `titleeditstart`, `titleeditend`
- Replace inline title rendering in `a4-tasklist.ts` with new component
- Move title editing state/logic to new component

**Verification:**
- Title editing works (click to edit, enter to save, escape to cancel)
- Title changes sync to repository
- Live updates during editing work

---

### 4.2 Extract Search Logic from `app-shell.ts`

**Current State:** `app-shell.ts` (748 lines) handles:
- Global search query state
- Search tokenization
- Match counting across lists
- Search result highlighting coordination

**Refactor:**
- Create `SearchController` class:
  - Manages search query state
  - Handles tokenization
  - Computes match counts given a list of items
- `app-shell.ts` instantiates and subscribes to controller
- Move `getSearchMatchCountForList` logic to controller

**Verification:**
- Search works across all lists
- Match counts display correctly in sidebar
- Search highlighting works in task lists

---

## Phase 5: Advanced Simplification (High Risk)

### 5.1 Consolidate Store Implementations

**Current State:**
- `createStore` in `list-store.ts` (lines 216-244) - generic implementation
- Used by both `app-store.ts` and `a4-tasklist.ts`
- `list-store.ts` also contains `listReducer` and list-specific actions

**Refactor:**
- Keep single `createStore` export from `list-store.ts`
- Move `createStore` to `shared/store.ts` if it feels more appropriate
- Ensure type safety is maintained

**Verification:**
- All stores initialize correctly
- State updates propagate
- No type errors

---

### 5.2 Simplify Repository Sync Pause/Resume

**Current State:** `a4-tasklist.ts` has:
- `repositorySyncPaused: number` (counter)
- `queuedRepositoryState: TaskListState | null`
- `pauseRepositorySync()` / `resumeRepositorySync()` methods
- Complex state machine for managing repository updates during editing

**Refactor:**
- Replace counter with boolean `isSyncPaused`
- Use a simple queue array instead of single `queuedRepositoryState`
- Or: Remove pause/resume entirely and use optimistic updates with conflict resolution

**Verification:**
- Editing text doesn't get overwritten by repository sync
- Changes are applied after editing completes
- No dropped updates

---

## Progress Tracking

| Phase | Description | Status | Commit |
|-------|-------------|--------|--------|
| 1.1 | Extract `arraysEqual` to shared utilities | ✅ Done | c384192 |
| 1.2 | Consolidate count formatting utilities | ✅ Done | db29592 |
| 2.1 | Inline `SidebarCoordinator` | ⏳ Pending | - |
| 2.2 | Merge `DragCoordinator` into `DraggableBehavior` | ⏳ Pending | - |
| 3.1 | Remove duplicate state from `ListRegistry` | ⏳ Pending | - |
| 3.2 | Simplify `RepositorySync` action dispatching | ⏳ Pending | - |
| 4.1 | Extract title editing from `a4-tasklist.ts` | ⏳ Pending | - |
| 4.2 | Extract search logic from `app-shell.ts` | ⏳ Pending | - |
| 5.1 | Consolidate store implementations | ⏳ Pending | - |
| 5.2 | Simplify repository sync pause/resume | ⏳ Pending | - |

---

## Appendix: Verification Checklist

For each refactor:

- [ ] Unit tests pass (`npm run test:unit`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] No TypeScript errors (`npx tsc --noEmit`)
- [ ] Knip reports no orphaned exports (`npm run lint:deps`)
- [ ] Manual smoke test of affected features

---

## Appendix: Risk Assessment Summary

| Phase | Risk Level | Files Modified | Est. Time |
|-------|------------|----------------|-----------|
| 1.1 | Low | 3 | 30 min |
| 1.2 | Low | 5 | 45 min |
| 2.1 | Low-Medium | 3 | 30 min |
| 2.2 | Low-Medium | 4 | 1 hour |
| 3.1 | Medium | 4 | 2 hours |
| 3.2 | Medium | 2 | 1 hour |
| 4.1 | Medium-High | 3 | 3 hours |
| 4.2 | Medium-High | 3 | 3 hours |
| 5.1 | High | 4 | 2 hours |
| 5.2 | High | 2 | 4 hours |

**Recommended Order:** 1.1 → 1.2 → 2.1 → 2.2 → 3.2 → 3.1 → 4.2 → 4.1 → 5.1 → 5.2
