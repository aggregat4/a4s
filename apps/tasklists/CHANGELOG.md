# Changelog

All notable changes to A4 Tasklists are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

### Fixed

- Fix task moves and list reorders not converging between clients that edited
  offline and shared a Lamport clock; concurrent writes are now ordered
  deterministically by `(clock, actor)`.
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
