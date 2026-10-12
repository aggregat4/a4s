# Tasklists refactoring plan

Remaining cleanup of the Tasklists client, found in a review after the list
element refactoring (commits `d3a86a9` to `d3a3046`). Line numbers are as of
`d3a3046` and drift as work lands. Tick items off as they are committed, and
delete this file when everything is done.

## Working agreements

- The user reviews every change before it is committed and pushed.
- Bug fixes start with an E2E test that reproduces the bug as a user meets it;
  it fails before the fix and passes after.
- Refactors, fixes, test changes and dependency upgrades are separate commits,
  with subjects as `refactor(tasklists): …`, `fix(tasklists): …`,
  `test(tasklists): …` or `deps: …`. No assistant attribution.
- User-visible changes add an entry under `## [Unreleased]` in
  `apps/tasklists/CHANGELOG.md`, in the same commit.
- After a push, watch CI until it finishes.

## Verifying a change

- Full suite: `task tasklists:test` from the repository root; `task lint` too.
- One test: build the client (`pnpm build` in `apps/tasklists/client`), then
  `PLAYWRIGHT_USE_DOCKER=1 pnpm exec playwright test --project='chromium*' -g "<name>"`.
- The UI model (`tests/ui-model.spec.ts`) runs 10 sequences in the suite. For
  steps that touch editing, focus, rendering or sync, also run
  `UI_MODEL_RUNS=25` or more. A failure prints a shrunk counterexample.
- For races, repeat the relevant tests: `--repeat-each=5 --workers=8` puts the
  machine under load, closer to CI.
- When a change removes code that might be load-bearing, break it on purpose
  and check that a test fails.

## 1. Open problems

- [x] **Undo test race.** `tests/tasklist.spec.ts:573` checks
  `repository.canUndo()` once, right after the new task shows. The task now
  shows before the repository has saved it and recorded the undo step, so a
  slow machine sees `false`. It fails 4 times in 15 under
  `--repeat-each=15 --workers=6`. Fix: `expect.poll` for `canUndo()`.
  Commit: `test(tasklists): wait for the undo step after adding a task`.
- [ ] **Search flake on CI.** In CI run 38133330500, "tasklist header mirrors
  title, search, and show-done state" (`tests/tasklist.spec.ts:414`) still
  showed all 20 tasks five seconds after searching for "umbrella". The rerun
  passed, and 40 local runs under load passed. CI now keeps a trace of a
  failed test and uploads `apps/tasklists/client/test-results` as the
  `tasklists-test-results` artifact; diagnose the next recurrence from it.
  One lead: the search reaches the list elements through `ListRegistry`
  records (`app-shell.ts` `applySearchToLists`), whose `element` is set only
  when a render attaches it.

## 2. Mechanical cleanup

The first four items are one commit,
`refactor(tasklists): remove dead code and leftovers`. Each of the others is
a refactor of its own commit.

- [x] `src/shared/drag-behavior.ts`: `beginFloating` (line 393) computes values
  and discards them; `deferFloatingInit` and `_pendingInitCoords` are never
  set to anything that matters; `_lastDragOverLogTs` is a logging leftover;
  the `debug` and `pointerFallback` options (lines 59–60, 97) are never read.
- [x] Unused methods: `ListRepository.getTaskSnapshot`
  (`list-repository.ts:1528`), `ListStorage.pruneOperations`
  (`list-storage.ts:333`), `ListRegistry.ensureActiveListId`
  (`list-registry.ts:104`), and the unused `repository` constructor parameter
  of `ListRegistry` (line 57).
- [x] Comments that describe old behaviour: the class comment of
  `a4-tasklist.ts` (line 71, mentions a reducer and a store); the comments on
  `_changeQueue` and `_textEditSessions` in `list-repository.ts` (lines 108,
  111).
- [x] `a4-tasklist.ts`, the `name` attribute: the element writes the title to
  it (tests use `a4-tasklist[name='…']` as a locator, so keep that), but
  nothing sets it from outside. Remove renaming from the attribute:
  `observedAttributes` (146), `attributeChangedCallback` (232),
  `suppressNameSync`, the `name` getter and setter (1500), and the fallback
  title read from the attribute in the `ListState` constructor call.
- [x] `a4-tasklist.ts`: eleven handlers repeat "find the task id from the
  event" (`closest("li")`, `dataset.itemId`). Add one `taskIdOf(event)`
  helper.
- [x] `a4-tasklist.ts`: `handleEditCommit` (1231) has six early returns that
  each call `scheduleSearchRender(0)`.
- [x] `a4-tasklist.ts`: `renderFromState` (708, about 150 lines) mixes
  rendering, three change events de-duplicated by four `lastReported*`
  fields, the title attribute, starting edits and restoring focus, pruning
  open notes and actions, and the empty state. Split it into named steps and
  replace the `lastReported*` fields with one "emit when changed" helper.
- [x] `app-shell.ts` (19 `bind` calls from line 167) and `sidebar.ts` (12):
  do what the list element did in `d3a86a9`, with lit's `host` render option
  for template handlers and one `AbortController` per connection for other
  listeners.

## 3. App-level state consolidation

`ListRegistry` (`src/ui/state/list-registry.ts`), the app store
(`src/ui/state/app-store.ts`) and `RepositorySync`
(`src/ui/state/repository-sync.ts`) overlap: the list order, the active list
and the list names are copied between the repository's registry, the app
store and `ListRegistry`.

Agreed design: what the user sees of the lists is the repository's registry
with the user's unsaved list changes on top, as `ListState` does for the
tasks of a list. The store copies the registry on every change, so a
snapshot taken before a reorder or rename was saved shows the old order or
name again, and failures are rolled back case by case.

- [x] Delete the shell's `dispose` and `RepositorySync.dispose`; nothing
  calls them, and the shell lives as long as the page.
- [x] The repository gives a list the registry's title until the list's own
  state arrives (after an import, or from another device). Until now only
  `RepositorySync`'s copy into the elements' `initialState` covered this.
- [x] The shell listens once for the list events, which bubble and are
  composed, instead of `ListRegistry` attaching seven listeners to every
  element. Drop the unused `task-focus` event.
- [ ] Stop copying `initialState` into the list elements (the setter, and
  `stateVersion` and `appliedStateVersion`); each follows the repository
  through `ListState.connect`.
- [ ] The main pane, which renders the list elements, finds a list's element
  and flashes its section. The move controller and the shell use it, and
  `ListRegistry` is deleted.
- [ ] E2E tests on a slow device for reordering, renaming, creating and
  deleting lists while other registry changes arrive. Review with the user
  before going on.
- [ ] Factor the pending-changes core shared with `ListState` out of it.
- [ ] Add `ListsState`: the registry with pending creates, removes, moves and
  renames. A rename is one request, pending in both the list's `ListState`
  and `ListsState`. The sidebar, the main pane and the move dialog use it.
- [ ] Remove the app store and `RepositorySync`; the active list, the list
  waited for from the URL and the search query become the shell's state.

## 4. Repository changes

- [ ] Each of the twelve changes in `list-repository.ts` repeats the same
  steps: initialize, find the list record, generate the operation, persist,
  emit, record history (40–60 lines each). A helper for persist, emit and
  record could remove a few hundred lines. Undo and redo replay history
  through the `*Internal` methods (`applyHistoryOp`); keep that working.
- [ ] `queueOpsForSync` (line 1576) writes to the outbox itself while sync is
  off, next to `SyncEngine`'s own writer. Two writers of the same IndexedDB
  record can race. Give the outbox one owner. Start with a test of changes
  made while sync is off, then turned on.
- [ ] `ListStorage.persistOperations` (line 278) saves a list's state and
  appends its operations, and loading replays those operations onto a state
  that already includes them. That overlap exposed the redo bug fixed in
  `accc4c4`. Consider keeping only operations after the saved state.

## 5. Sidebar drag reorder

- [ ] `sidebar.ts` repairs the DOM after a drag (`syncListDomOrder`, and the
  `"reorder"` render mode, `pendingRenderMode` at line 50), as the task list
  did before `785de9c`. Apply the same approach: at drop time the dragged
  element is in its final place, so its neighbours give the move. Run the
  sidebar drag tests repeatedly; they were flaky before.

## 6. List element merges

- [ ] Ticking a task off has two paths, `handleToggle` (856, a click) and
  `toggleItemDone` (1001, the keyboard), both delayed with `setTimeout(0)`
  "so click events settle". Check whether the delay is still needed (the
  `ListState` refactoring removed similar workarounds), and merge the paths.
- [ ] Keydown is handled in three places: the module-level document listener
  (1514), `handleListKeyDown` (1146) and `handleItemKeyDown` (1048), with
  "tick off" handled in two. Merge them into one.
- [ ] Notes (about 150 lines: `toggleNoteForItem` 1020, `handleNoteKeyDown`
  972, the note handlers and the note panel template). Escape duplicates the
  close logic of `toggleNoteForItem`. The drafts already moved into
  `ListState`; consider extracting the rest into a controller.

## Not planned

- The item template stays in the list element: it reads per-item state the
  element owns and wires its handlers.
- The editable title stays in the header until a second editable label
  appears.
- `src/shared/inline-text-editor.ts` was not reviewed in depth; no problems
  pointed there.
