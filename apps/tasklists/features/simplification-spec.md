# Frontend Simplification Plan (Revised)

This document outlines incremental refactors to reduce complexity in the client codebase. Each refactor is designed to be completed independently and verified without breaking existing functionality.

**Last Updated:** 2026-02-01

---

## Current Architecture Overview

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `a4-tasklist.ts` | 2689 | Task list rendering, inline editing, title editing, search, drag-drop |
| `list-repository.ts` | 1601 | CRDT operations, persistence, sync |
| `inline-text-editor.ts` | 723 | Task text inline editing behavior |
| `app-shell.ts` | 713 | App orchestration, search coordination, import/export |
| `sidebar.ts` | 551 | Sidebar rendering, list reordering |
| `drag-behavior.ts` | 450 | Generic drag-drop with FLIP animations |
| `move-tasks-controller.ts` | 209 | Task move dialog and cross-list moves |
| `app-store.ts` | 218 | Global app state (lists, order, search) |
| `list-store.ts` | 244 | List-level state + generic createStore |
| `list-registry.ts` | 299 | DOM element lifecycle for lists |
| `repository-sync.ts` | 133 | Sync repository changes to UI state |

**Total UI/Component Code:** ~6,374 lines

---

## Completed Phases ✅

### Phase 1: Utility Consolidation
- **1.1** Extract `arraysEqual` to shared utilities ✅
- **1.2** Consolidate count formatting utilities ✅

### Phase 2: Remove Thin Wrappers
- **2.1** Inline `SidebarCoordinator` ✅
- **2.2** Merge `DragCoordinator` into `DraggableBehavior` ✅

### Phase 3: State Management Cleanup
- **3.1** Remove duplicate state from `ListRegistry` ✅
- **3.2** Inline `TaskListView` into `a4-tasklist.ts` ✅
- **3.3** Unify event naming to kebab-case ✅

---

## Remaining Opportunities

### Phase 4: Component Decomposition (Medium Risk)

#### 4.1 Extract Title Editing from `a4-tasklist.ts` ⏳ HIGH VALUE

**Current State:**
- Title editing logic (~150 lines) mixed with 2689-line component
- Complex state machine: `isTitleEditing`, `titleOriginalValue`, `titleLiveUpdates`
- Event handlers: `startTitleEditing`, `finishTitleEditing`, `commitTitleEditing`, `cancelTitleEditing`, `handleTitleInput`, `handleTitleKeyDown`

**Refactor:**
```typescript
// Create a4-tasklist-title.ts
class TaskListTitleElement extends HTMLElement {
  // Props via attributes
  title: string;
  editing: boolean;
  
  // Events
  @event title-change { title: string }
  @event title-edit-start
  @event title-edit-end
  
  // Internal state management
  private originalValue: string;
  private hasLiveUpdates: boolean;
}
```

**Benefits:**
- Reduces a4-tasklist.ts by ~150 lines
- Title editing becomes testable in isolation
- Reusable if we add list titles elsewhere

**Risk:** Medium | **Est. Time:** 2-3 hours

---

#### 4.2 Extract Search Logic from `app-shell.ts` ⏳ HIGH VALUE

**Current State:**
- `app-shell.ts` (713 lines) contains:
  - Search query state management
  - Tokenization via `tokenizeSearchQuery`
  - Match counting across lists via `getSearchMatchCountForList`
  - Search highlighting coordination

**Refactor:**
```typescript
// Create ui/state/search-controller.ts
class SearchController {
  private query: string;
  private tokens: string[];
  
  setQuery(query: string): void;
  getTokens(): string[];
  countMatches(items: TaskItem[], showDone: boolean): number;
  subscribe(listener: () => void): () => void;
}
```

**Benefits:**
- Reduces app-shell.ts by ~100 lines
- Search logic becomes testable in isolation
- Could enable future features (search history, saved searches)

**Risk:** Medium | **Est. Time:** 2-3 hours

---

### Phase 5: Repository Sync Simplification (Medium Risk)

#### 5.1 Simplify `RepositorySync` Dispatching ⏳ REVISED ASSESSMENT

**Current State:**
- `RepositorySync.handleRegistryChange()` dispatches individual `APP_ACTIONS.upsertList` for each list, then bulk `APP_ACTIONS.setRegistry`

**Analysis:**
- The individual `upsertList` dispatches may be intentional for proper list name tracking
- The bulk `setRegistry` replaces the entire state
- **Verdict:** Keep as-is for now; the redundancy ensures consistency
- **Action:** Remove from roadmap - not a clear win

**Risk:** Low-Medium | **Est. Time:** 1 hour | **Status:** DEPRIORITIZED

---

### Phase 6: Store Consolidation (Low Risk)

#### 6.1 Consolidate `createStore` Implementation ⏳ EASY WIN

**Current State:**
- `createStore` in `list-store.ts` (lines 216-244)
- Generic implementation used by both `app-store.ts` and `a4-tasklist.ts`
- `list-store.ts` also contains list-specific reducer and actions

**Refactor:**
- Move `createStore` to `shared/store.ts`
- Keep list-specific code in `list-store.ts`
- Update imports in `app-store.ts`

**Benefits:**
- Cleaner separation of concerns
- Generic store in shared/, domain logic in ui/state/

**Risk:** Low | **Est. Time:** 30 minutes

---

### Phase 7: Advanced Simplification (High Risk) ⏳ DEFERRED

#### 7.1 Simplify Repository Sync Pause/Resume

**Current State:** `a4-tasklist.ts` has complex pause/resume:
- `repositorySyncPaused: number` (counter, not boolean)
- `queuedRepositoryState: TaskListState | null`
- `pauseRepositorySync()` / `resumeRepositorySync()`

**Analysis:**
- This complexity exists to prevent repository sync from overwriting text being edited
- It's working correctly and is well-tested
- Risk of breaking editing UX is high

**Verdict:** Defer until there's a compelling reason to change

**Risk:** High | **Est. Time:** 4+ hours | **Status:** DEFERRED

---

## New Opportunities Discovered

### 8.1 Extract `EditController` from `a4-tasklist.ts` 🔍 NEW

**Current State:**
- `EditController` class defined at lines ~60-180 in a4-tasklist.ts
- Manages edit queue for focusing items after render

**Refactor:**
- Move to separate file `ui/state/edit-controller.ts`
- Benefits: Testable in isolation, reduces a4-tasklist.ts

**Risk:** Low | **Est. Time:** 30 minutes

---

### 8.2 Consolidate Drag Payload Types 🔍 NEW

**Current State:**
- `TaskDragPayload` defined in `sidebar.ts` (line ~12)
- Similar types likely in drag-behavior.ts
- Move tasks controller may have its own version

**Refactor:**
- Create shared `types/drag.ts` with canonical types
- Update all consumers

**Risk:** Low | **Est. Time:** 30 minutes

---

### 8.3 Simplify `MoveTasksController` Target Counts 🔍 NEW

**Current State:**
- `MoveTasksController.handleTaskMoveRequest()` (lines 93-154) queries repository for counts
- Now that we removed cached metrics, this queries repository directly

**Analysis:**
- Could simplify by using element queries like sidebar does
- But this is working correctly and is clear

**Verdict:** Optional cleanup, not high priority

---

## Revised Priority Order

### Immediate (High Value, Low Risk)
1. **6.1** Move `createStore` to `shared/store.ts` (30 min)
2. **8.1** Extract `EditController` to separate file (30 min)
3. **8.2** Consolidate drag payload types (30 min)

### Short-term (High Value, Medium Risk)
4. **4.1** Extract title editing component (2-3 hours)
5. **4.2** Extract search controller (2-3 hours)

### Long-term / Optional
6. **5.1** Repository sync dispatching - DEPRIORITIZED
7. **7.1** Repository sync pause/resume - DEFERRED
8. **8.3** MoveTasksController counts - OPTIONAL

---

## Appendix: Verification Checklist

For each refactor:

- [ ] Unit tests pass (`npm run test:unit`)
- [ ] E2E tests pass (`npm run test:e2e`)
- [ ] No TypeScript errors (`npx tsc --noEmit`)
- [ ] Knip reports no orphaned exports (`npm run lint:deps`)
- [ ] No commit before manual review by user
- [ ] Manual smoke test of affected features

---

## Metrics Tracking

| Date | Total UI Lines | a4-tasklist.ts | app-shell.ts | Notes |
|------|---------------|----------------|--------------|-------|
| 2026-02-01 | 6,374 | 2,689 | 713 | Starting point for revised plan |
