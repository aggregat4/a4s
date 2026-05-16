# TODO

## Product and UX

### Integrate the user actions into one compact header

The current authentication header is visually heavy and feels disconnected from
the page-specific actions. Make it more minimal and integrate it with actions
such as "Add new comment" and "Administer comments" so the top of the page reads
as one coherent control area.

### Show pending comments to their authors on post pages

`GetCommentsForPost` only returns approved comments. A logged-in user viewing a
post should also see their own pending comments with a clear visual marker such
as "awaiting moderation" so they know their submission arrived.

### Improve comment presentation

* Align public comment styling with the admin dashboard styling.
* Visually distinguish a logged-in user's own comments on a post page,
  especially when they can still edit them.
* Preserve minimal formatting in comments, at least paragraph breaks.
* Investigate the console error that appears after confirming a comment and
  returning to the original post.

### Make embed presentation configurable

Allow service owners to provide custom CSS for the embedded comments page.

## HTTP and performance

* Consider real caching for the post comments page. Comments should stay fresh,
  but the page should not become unnecessarily slow to load.
* Set caching headers on responses where it makes sense beyond hashed static
  assets.
* Redirect collection routes without a trailing slash to the canonical path with
  the slash.

## E2E test coverage

* Test comment submission end-to-end: fill the form, submit, and verify the
  pending/approved lifecycle.
* Test admin approve/delete comment flows via Chromedp.
* Test logout and session cleanup in a real browser session.
* Test CSRF token validation through real browser interactions.

## Postponed

* Offer an alternative JSON way to manage comments, while keeping the iframe as
  the primary integration path for now.
