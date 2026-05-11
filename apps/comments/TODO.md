# TODO

## User Status Bar

The current header with the user ID and logout button is ugly and unfitting. Needs to be more minimal and better integrated and take as little real estate as possible.
Should be merged with the "add new comment" and "administer comments" functions to be one whole thing.

## Add comment entry point on public comment list

The post comments page (`/services/{serviceKey}/posts/{postKey}/comments/`) renders approved comments but gives unauthenticated visitors no way to reach the comment form or log in. Need an "Add comment" link or button that starts the OIDC popup flow (or links to the full-page login as fallback).

## Show pending comments to their authors

`GetCommentsForPost` only returns approved comments. A logged-in user viewing a post should see their own pending comments with some visual marker (e.g., "awaiting moderation") so they know their submission arrived.

## Miscellaneous

* align the user comment styling with the admin dashboard styling

* retain some minimal formatting from comments. At least paragraphs.

* when logged in as a user and seeing your comments on a post and being able to modify them, we should highlight the comment somehow

* after confirming the comment and then rendering the original post, there is an error in the console

* need a way for service owners to specify custom css for the comments page

* consider real caching of the postcomments page: we need to make sure that the comments are always up to date, but we also need to make sure that the page is not too slow to load

* Set caching headers on responses where it makes sense

* Redirect from collection pages without a trailing slash to the one with the slash

## Postponed

* Offer an alternative JSON way to manage comments — keeping iframe as the primary integration path for now.
