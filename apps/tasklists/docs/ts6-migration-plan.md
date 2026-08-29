# TypeScript 6 Gradual Migration Plan

## Goal
Migrate the frontend codebase from TypeScript 5.9 to 6.0 using a gradual approach:
- Start with `strict: false` to establish a working baseline under TS 6
- Enable individual strict flags one at a time
- Each step must leave the build green and all tests passing
- Final step: enable `strict: true`

## Background

TypeScript 6.0 changes the default of `strict` from `false` to `true`. This project was written without strict mode and has ~260 errors under `strict: true`. The errors fall into four categories:

| Category | Count | Complexity |
|----------|-------|------------|
| `noImplicitAny` | ~83 | Low (mechanical) |
| `strictNullChecks` | ~97 | Medium (needs null guards) |
| `strictFunctionTypes` (store reducers) | ~56 | High (needs store redesign) |
| Other (`useUnknownInCatchVariables`, etc.) | ~24 | Low |

## Branch Strategy

Create a dedicated branch for the migration:
```bash
git checkout -b ts6-migration
```

Each step in this plan should be its own commit. This makes review easy and allows bisecting if something breaks.

---

## Step 1: Establish TS 6 Baseline

**What:** Install TypeScript 6 and add `"strict": false` to `tsconfig.base.json`.

**Why:** Get the project compiling under TS 6 before touching any strict flags.

**Files to change:**
- `client/package.json` — bump `typescript` to `6.0.3`
- `client/package-lock.json` — regenerate after install
- `client/tsconfig.base.json` — add `"strict": false`

**Verification:**
```bash
cd client && npm run build
```

**Expected result:** Build passes. Unit tests pass.

**Note:** Even with `strict: false`, TS 6 may surface a small number of new errors due to other default changes (e.g., `types: []` default, `rootDir` default). Fix those here if they appear.

---

## Step 2: Fix `useUnknownInCatchVariables`

**What:** Add `"useUnknownInCatchVariables": true` to `tsconfig.base.json` and fix any catch blocks that treat the caught value as `Error` without narrowing.

**Why:** This is the smallest strict flag. It teaches the codebase to handle errors safely before tackling the bigger ones.

**Pattern to fix:**
```typescript
// Before
} catch (err) {
  console.error(err.message); // Error: 'err' is of type 'unknown'
}

// After
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
}
```

**Files likely affected:**
- `client/src/app/sync-engine.ts`
- `client/src/app/list-repository.ts`
- `client/src/ui/components/app-shell.ts`
- `client/src/ui/components/a4-tasklist.ts`

**Verification:**
```bash
cd client && npm run build && npm run test:unit
```

---

## Step 3: Fix `noImplicitAny`

**What:** Add `"noImplicitAny": true` to `tsconfig.base.json` and add explicit types everywhere the compiler currently infers `any`.

**Why:** ~83 mechanical errors. This is pure typing work with minimal risk of runtime behavior changes. Getting it out of the way early makes the remaining steps smaller.

**Patterns to fix:**

1. **Untyped callback parameters**
```typescript
// Before
tokens.map((token) => token.toLowerCase());

// After
tokens.map((token: string) => token.toLowerCase());
```

2. **Untyped destructured parameters**
```typescript
// Before
function matchesSearchEntry({ originalText, noteText, tokens }) { ... }

// After
function matchesSearchEntry({
  originalText,
  noteText,
  tokens,
}: {
  originalText: string;
  noteText: string;
  tokens: string[];
}) { ... }
```

3. **Empty arrays without element types**
```typescript
// Before
const response = [];

// After
const response: PersistedListRecord[] = [];
```

**Files affected:**
- `client/src/ui/state/highlight-utils.ts` (~20 errors)
- `client/src/shared/drag-behavior.ts` (~15 errors)
- `client/src/ui/components/a4-tasklist.ts` (~10 errors)
- `client/src/domain/crdt/task-list-crdt.ts` (~5 errors)
- `client/src/domain/crdt/lists-crdt.ts` (~2 errors)
- `client/src/domain/crdt/ordered-set-crdt.ts` (~3 errors)
- `client/src/entrypoints/demo-seeds.ts` (~4 errors)
- `client/src/storage/list-storage.ts` (~3 errors)
- `client/src/ui/components/app-shell.ts` (~2 errors)
- `client/src/ui/components/move-dialog.ts` (~1 error)
- `client/src/ui/state/move-tasks-controller.ts` (~1 error)

**Verification:**
```bash
cd client && npm run build && npm run test:unit
```

**Commit message suggestion:**
```
Enable noImplicitAny

Add explicit parameter and variable types throughout the codebase to
satisfy TypeScript 6's noImplicitAny check.
```

---

## Step 4: Fix `strictFunctionTypes`

**What:** Add `"strictFunctionTypes": true` to `tsconfig.base.json` and fix function type incompatibilities.

**Why:** This is where the custom store's reducer typing breaks. The `createStore` function declares reducers as `(state, action: { type: string }) => S`, but actual reducers expect `action: ListAction | AppAction` which has a `payload` property. TS 5 was lenient; TS 6 is not.

**Approach:**

Instead of redesigning the entire store architecture, the minimal fix is to widen the `Reducer` type to accept actions with extra properties:

```typescript
// client/src/ui/state/list-store.ts
// Before
type Reducer<S, A> = (state: S | undefined, action: { type: string }) => S;

// After
type Reducer<S, A extends { type: string }> = (
  state: S | undefined,
  action: A
) => S;
```

Then update `createStore` to be generic over the action type:

```typescript
function createStore<S, A extends { type: string }>(
  reducer: Reducer<S, A>,
  preloadedState?: S
) { ... }
```

This preserves the existing API while satisfying the stricter check.

**Secondary fixes in this step:**
- The `ListRecord` type conflict in `app-shell.ts` (two different `ListRecord` types from different modules). Consolidate by importing the canonical type or using an interface.

**Files affected:**
- `client/src/ui/state/list-store.ts` (core change)
- `client/src/ui/components/a4-tasklist.ts` (dispatch sites)
- `client/src/ui/components/app-shell.ts` (dispatch sites)
- `client/src/ui/state/app-store.ts` (dispatch sites)

**Verification:**
```bash
cd client && npm run build && npm run test:unit
```

**Commit message suggestion:**
```
Enable strictFunctionTypes

Widen the custom store's Reducer generic to accept action types with
extra properties (like payload), fixing dispatch sites that pass
discriminated union actions.
```

---

## Step 5: Fix `strictNullChecks` — Part A: DOM & Optional Properties

**What:** Add `"strictNullChecks": true` to `tsconfig.base.json` and fix the first half of null-safety issues.

**Why:** 97 errors is too many for one commit. Split into two commits:
- Part A: DOM elements, event targets, and optional property access (the "easy" null checks)
- Part B: Function signatures and API boundaries (the "hard" null checks)

**Patterns to fix in Part A:**

1. **Possibly-null DOM elements**
```typescript
// Before
this.placeholder.style.height = `${height}px`;

// After
if (this.placeholder) {
  this.placeholder.style.height = `${height}px`;
}
```

2. **Optional chaining for safe access**
```typescript
// Before
const label = element.textContent.trim();

// After
const label = element?.textContent?.trim() ?? "";
```

3. **Guard clauses for nullable controller references**
```typescript
// Before
this.moveTasksController.handleTaskMoveRequest(event);

// After
this.moveTasksController?.handleTaskMoveRequest(event);
```

**Files affected (Part A):**
- `client/src/shared/drag-behavior.ts` (~15 errors)
- `client/src/shared/inline-text-editor.ts` (~2 errors)
- `client/src/ui/components/move-dialog.ts` (~2 errors)
- `client/src/ui/components/sidebar.ts` (~2 errors)
- `client/src/ui/components/app-shell.ts` (~5 errors)
- `client/src/ui/components/a4-tasklist.ts` (~10 errors)

**Verification:**
```bash
cd client && npm run build && npm run test:unit
```

---

## Step 6: Fix `strictNullChecks` — Part B: API Boundaries & Signatures

**What:** Fix the remaining null-safety issues related to function signatures and data flow.

**Patterns to fix in Part B:**

1. **`number | null` → `number | undefined` normalization**
```typescript
// Before
window.setTimeout(callback, this.searchDebounceId);
// this.searchDebounceId: number | null

// After
window.setTimeout(callback, this.searchDebounceId ?? undefined);
```

2. **`string | null` not assignable to `string`**
```typescript
// Before
ensureActorId(state.activeItemId);

// After
if (state.activeItemId) {
  ensureActorId(state.activeItemId);
}
```

3. **Nullable `removeEventListener` handlers**
```typescript
// Before (in sync-engine.ts)
window.removeEventListener("offline", this.handleOffline);
// this.handleOffline: (() => void) | null

// After: store listeners in a way that guarantees non-null at removal time,
// or use a sentinel no-op function.
```

4. **Catch-variable type narrowing**
```typescript
// Before
} catch (err) {
  return err.message;
}

// After
} catch (err) {
  return err instanceof Error ? err.message : String(err);
}
```

**Files affected (Part B):**
- `client/src/app/sync-engine.ts` (~2 errors)
- `client/src/app/list-repository.ts` (~5 errors)
- `client/src/domain/crdt/ordered-set-crdt.ts` (~5 errors)
- `client/src/domain/crdt/task-list-crdt.ts` (~3 errors)
- `client/src/ui/components/a4-tasklist.ts` (~10 errors)
- `client/src/ui/state/move-tasks-controller.ts` (~5 errors)
- `client/src/ui/state/repository-sync.ts` (~1 error)
- `client/src/ui/state/list-registry.ts` (~1 error)

**Verification:**
```bash
cd client && npm run build && npm run test:unit && npx playwright test --project=chromium
```

**Commit message suggestion:**
```
Enable strictNullChecks

Add null-safety guards throughout the codebase:
- DOM element existence checks
- Optional chaining for nullable properties
- Normalize null/undefined at API boundaries
- Type-narrow catch variables before accessing properties
```

---

## Step 7: Enable `strict: true`

**What:** Remove the individual strict flags from `tsconfig.base.json` and replace them with a single `"strict": true`.

**Why:** By this point, all sub-flags have been addressed. `strict: true` is the canonical way to express this and ensures any future strict flags added by TS are also enabled.

**Files to change:**
- `client/tsconfig.base.json`

**Before:**
```json
{
  "compilerOptions": {
    "strict": false,
    "useUnknownInCatchVariables": true,
    "noImplicitAny": true,
    "strictFunctionTypes": true,
    "strictNullChecks": true
  }
}
```

**After:**
```json
{
  "compilerOptions": {
    "strict": true
  }
}
```

**Verification:**
```bash
cd client && npm run build && npm run test:unit && npx playwright test --project=chromium
```

**Commit message suggestion:**
```
Enable strict mode

Remove individually-enabled strict flags and set strict: true.
All strict-family checks now pass.
```

---

## Step 8: Final Integration & Merge

**What:** Run the full test matrix and merge the branch.

**Verification checklist:**
- [ ] `cd client && npm run build` passes
- [ ] `cd client && npm run test:unit` passes (49/49)
- [ ] `cd client && npx playwright test --project=chromium` passes
- [ ] `cd server && go build ./cmd/server` passes
- [ ] Release build script (`scripts/build-release.sh`) produces a working binary

**Merge:**
```bash
git checkout main
git merge --ff-only ts6-migration
```

---

## Appendix: Rollback Strategy

If any step introduces regressions:
1. Revert that single commit
2. The branch remains in a buildable state because every prior step was verified
3. Revisit the problematic step with a different approach

## Appendix: Testing Tips Per Step

- **Unit tests** catch logic errors but won't catch type-only changes
- **E2E tests** catch DOM and interaction regressions
- After `strictNullChecks` steps, pay special attention to:
  - Drag-and-drop behavior (`drag-behavior.ts`)
  - Task list editing and focus management (`a4-tasklist.ts`)
  - Sync engine online/offline transitions (`sync-engine.ts`)
- If E2E tests are slow, run only the relevant spec files:
  ```bash
  npx playwright test tests/tasklist.spec.ts --project=chromium
  npx playwright test tests/pwa.spec.ts --project=chromium
  npx playwright test tests/sync-server.spec.ts --project=chromium
  ```
