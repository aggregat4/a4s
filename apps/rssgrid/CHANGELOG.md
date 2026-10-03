# Changelog

All notable changes to RSSGrid are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes for a tag are taken from the matching version section, so the
`Unreleased` section is renamed to the release version when a release is cut.

## [Unreleased]

## [v1.6.0] - 2026-10-03

### Changed

- Feeds are fetched in parallel (up to four at a time) during an update
  cycle, so slow or unreachable feeds no longer delay the others.
- The dashboard loads the posts of all feeds in a single query, and posts are
  indexed by feed and publication date.
- Post titles on the dashboard are real links to the post page. A plain click
  still opens the post in the dialog; middle and modified clicks open it in a
  new tab, and the dashboard works without JavaScript.
- Dashboard post dates are shown relative to now ("3 hours ago"), with the
  full date in the tooltip. All dates are marked up as `<time>` elements.
- A post is marked as read when it is opened, on the server, instead of by a
  separate request from the dashboard script. This also covers posts opened
  in a new tab. The `POST /posts/{id}/seen` endpoint is removed.
- Logs are written with `log/slog` as key/value text lines without stack
  traces. Per-feed update progress is logged at debug level.

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
- The "mark all as read" button of a feed without a title now names the
  feed's host instead of leaving the name empty.
- Moving a feed up or down past the first or last position is now a no-op
  instead of an internal server error, and moving a feed that is not in the
  user's list returns 404.
- A template error no longer sends a partial page with a 200 status; the
  page is rendered completely before it is written.
- Two simultaneous first logins of the same user no longer fail on a
  duplicate user row.
