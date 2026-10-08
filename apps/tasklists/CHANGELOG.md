# Changelog

All notable changes to A4 Tasklists are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

### Fixed

- Spaces in tasks and list titles are shown and saved as typed. Spaces at the
  start or end of a task disappeared from view, the cursor could not be placed
  after them, and a trailing space was saved as a no-break space, so undoing
  a second word left that space behind.
- Deleting the last character of a task leaves it empty, so Backspace deletes
  it. The browser's placeholder for an empty line was turned into a space and
  saved, which made the task look empty but impossible to delete with
  Backspace.
- A list no longer briefly shows an older state while its changes are being
  saved. On slow devices a deleted task could reappear for a moment, and the
  task being edited could lose the cursor, so the next Backspace or click
  went nowhere and an empty task seemed impossible to delete.
- Undoing the deletion of a task restores its note as well.
- Undo keeps working after undoing the deletion of a list: the restored list
  keeps each task's position, so undoing an earlier move of one of its tasks
  puts it back in the right place.
- A list that is deleted and then restored with undo looks the same on every
  device. Deleting a list now only hides it, keeping its tasks and history, so
  undo shows it again exactly as it was instead of rebuilding it; a device
  that had reloaded in between could show an old title or miss later changes.
- Typing that pauses for more than a second is a separate undo step even on a
  slow device. Whether edits merge into one undo step was decided when they
  were saved instead of when they were made, so a burst of delayed saves could
  merge keystrokes, or list renames, that were seconds apart.

## [v1.7.1] - 2026-10-07

### Fixed

- Backspace no longer reaches tasks hidden by "Show done" or the search.
  Deleting an empty task above hidden completed tasks put the cursor inside a
  completed task and showed it, and Backspace at the start of a task below
  them merged it into the hidden completed task. The cursor now moves to the
  visible task above.

## [v1.7.0] - 2026-10-06

### Added

- Undo and redo buttons. On wide screens they sit next to the app title in the
  sidebar. On phones a toolbar at the bottom of the screen holds undo, redo,
  "Show done" and "Add" for the current list, within reach of the thumb, and
  shows a shadow while more tasks are hidden below it.
- Links in tasks open in a new tab. Tags (#tag) and contexts (@context) in
  tasks are clickable: clicking one adds it to the search, so each one clicked
  narrows the results further, and clicking it again removes it.
- The search is part of the URL, so it survives a reload, can be bookmarked,
  and the browser's back and forward buttons step through searches made by
  clicking tags and contexts.

### Fixed

- Splitting a task with Enter or joining two with Backspace right after typing
  no longer saves the wrong text on slow devices: the split-off text was saved
  twice, the joined text could be lost, and undo reverted a keystroke instead
  of the split.
- Deleting or moving a task right after typing waits for the typed text to be
  saved first. On slow devices, undoing such a delete reverted a keystroke
  instead and restored the task with only part of its text.
- Undo always reverts the last change you made. Changes are saved one at a
  time in the order you make them; on slow devices an undo pressed while a
  change was still saving could revert an earlier change instead.
- Ctrl+Z right after ticking a task off undoes it; it was ignored while the
  checkbox had focus. A tick that is undone or changed on another device now
  also updates a checkbox you clicked before.
- Reloading the page keeps the selected list instead of returning to the first
  list. The selected list is part of the URL, so a list can be bookmarked and
  the browser's back and forward buttons move between the lists you opened.
- Pasting formatted text, such as text copied from a web page, into a task or
  a list title inserts it as plain text on one line instead of keeping its
  formatting and running separate lines together.
- Clearing a list title and typing a new one no longer ends editing and
  restores the old title.
- Adding or editing a task no longer makes its text flash empty while the
  change is still being saved. A stale snapshot could replace the text with
  nothing until the save landed.

## [v1.6.2] - 2026-10-03

### Fixed

- Scrolling the list on a touch screen no longer starts editing the task under
  the finger and opens the on-screen keyboard. Tapping a task still edits it.

## [v1.6.1] - 2026-09-27

### Fixed

- Version the service worker cache per release so a deployment installs a fresh
  cache instead of continuing to serve the previous app shell.

### Changed

- Refresh the app icon and theme color, and respect the device safe area on
  mobile.

## [v1.6.0] - 2026-09-27

### Added

- Show the service and client versions in the Options disclosure. The service
  version comes from a dedicated authenticated endpoint, while the client
  version is embedded at build time so a service-worker-cached UI can be
  compared against the running server.

## [v1.5.5] - 2026-09-27

### Fixed

- Update other clients immediately after a snapshot is imported on one device.
  The server now notifies connected clients, and each client checks for a
  replaced dataset on startup because a stale generation key prevents its event
  stream from opening.
- Report when an imported snapshot was applied only on this device because sync
  is unavailable, instead of silently leaving other devices unchanged.

## [v1.5.4] - 2026-09-27

### Fixed

- Converge concurrent edits to the same task: content and position now carry
  independent write markers, so completing a task and moving it on different
  clients no longer suppress each other. Per-field versions are persisted and
  restored with the snapshot.
- Order tasks that share a position deterministically by id, so clients agree
  on the order regardless of the order in which concurrent inserts arrive.
- Keep offline edits in the durable outbox before an edit is reported as saved,
  so pending changes survive a client restart.
- Retry a remote operation or snapshot that fails to apply instead of advancing
  the pull cursor or discarding the current dataset, so no remote change is
  skipped.

## [v1.5.3] - 2026-09-25

### Fixed

- Fix task moves and list reorders not converging between clients that edited
  offline. Concurrent writes are now ordered deterministically by
  `(clock, actor)`, and a client no longer skips a concurrent operation when
  its own push advances the sync cursor past it.
- Add new lists after the last list instead of at a shared midpoint, which made
  them collide with the first list.
- Keep newly added tasks at the top of a list when an existing item's position
  begins with a digit-zero component.

## [v1.5.2] - 2026-09-20

### Fixed

- Create a new session when an existing session cookie cannot be validated.

## [v1.5.1] - 2026-09-20

### Fixed

- Let the browser handle OIDC navigations instead of intercepting them in the
  service worker.

## [v1.5.0] - 2026-09-20

### Fixed

- Revalidate the app shell in the service worker.
- Gate only the app document behind OIDC so static assets stay public.
- Fix focusing in the shortcuts dialog and improve server-sent events error
  handling.

### Changed

- Migrate Tasklists into the root Go module and pnpm workspace.
- Add root monorepo CI and unified release packaging.
- Normalize the Tasklists executable name and add canonical Debian packaging
  configuration.

## [v1.4.0] - 2026-07-04

### Added

- Swipe motion on task items driven by pointer events.
