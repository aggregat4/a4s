# Changelog

All notable changes to RSSGrid are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

### Removed

- The logout button and `POST /logout` route. Logging out only cleared the
  local session, so the identity provider signed the user straight back in.

### Fixed

- Adding a feed that is already known no longer fails with an internal error
  when the feed server answers 304 Not Modified.
- Foreign keys are now enforced on every database connection, so deleting a
  feed removes its posts and read states. A migration removes rows that were
  left behind earlier.
- Display preferences are validated on the server (posts per feed 1-50,
  columns 1-5) and stored together.
- The updater runs a cycle at startup, shuts down cleanly before the database
  is closed, counts only newly inserted posts, does not overwrite feed titles
  with an empty title, and no longer reports cache-skipped feeds as fetched.
- `Cache-Control: max-age` now takes precedence over `Expires`, and all HTTP
  date formats are accepted in `Expires`.
- Pruning keeps posts that are still in the feed, so they no longer reappear
  as unread on every update.
