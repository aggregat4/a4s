# Delicious Bookmarks

A really simple web based bookmark storage and retrieval system that can be easily integrated in bookmarklets and extensions and which can serve as a very basic replacement for `del.icio.us`- or `pinboard`-like services.

In addition to storing, editing and searching bookmarks, the system also contains a simple webpage archiver. If you mark a page as read later it will be fetched and the contents of the page will be reduced to just the content and the page is stored in the database. These archived pages are then made available to clients through an RSS feed.

## Starting the Server

The service will generate a random session key, which invalidates existing
login cookies after a restart. Configure a stable production key with
`DELBM_SESSION_COOKIE_SECRET_KEY`.

The default port is `1323`; override it with `DELBM_SERVER_PORT`. The server
loads a local `.env` file when one exists, but all settings can instead be
provided directly by the environment. Database and OpenID Connect settings are
required. See the canonical production example in
[`../../deploy/env/bookmarks.env.example`](../../deploy/env/bookmarks.env.example).

Build and start the server from the monorepo root with:

```bash
task bookmarks:build
./apps/bookmarks/bin/bmserver
```

## Security

There are no public pages in delicous bookmarks. All pages require authentication.

All queries use bound variables to prevent SQL injection attacks.

All pages are generated using go templates and all database strings are automatically escaped for the corresponding context they are used. This prevents Cross Site Scripting (XSS) attacks.

CSRF vulnerabilities are avoided by doing same origin checks on relevant methods.

It is a good idea to operate the service behind a reverse proxy so you can layer concerns like HTTPS and rate limiting on top of it.

The canonical reverse-proxy configuration is maintained under
[`../../deploy/nginx`](../../deploy/nginx). Login rate limiting belongs at the
OpenID Provider, where the login endpoint actually lives.

## Building

Build from the monorepo root with `task bookmarks:build`. For a Linux binary
with the repository's supported Go toolchain and stable Debian Bookworm libc
baseline, run `apps/bookmarks/scripts/build-in-docker.sh`.

## Migrating from Pinboard

The distribution includes a tool that will take a JSON export of a Pinboard account and import it into an empty database. If a database does not exist, it will be created and a new user will be added.

```bash
./importer -importUsername myusername -importFile my-pinboard-bookmarks.json
```

## Bookmarklet

You can call the `/addbookmark` page using a bookmarklet in the browser to quickly allow capturing new bookmarks. The code can look something like this (replace the URL with your own instance):

```js
javascript:void(window.open(`https://example.com/addbookmark?description=${encodeURIComponent(document.querySelector('meta[name="description"]')?.content  ?? document.querySelector('meta[name="twitter:description"]')?.content ?? "")}&title=${encodeURIComponent(document.title)}&url=${encodeURIComponent(location.href)}`,'Save Bookmark', 'width=700,height=500,left=0,top=0,resizable=yes,toolbar=no,location=no,scrollbars=yes,status=no,menubar=no'));
```

Note the usage of query parameters to prefill a bunch of fields from the existing metadata of the page.

## Architecture

This is a web application written in go, distributed as a statically linked binary. It stores its data in two tables in a sqlite 3 database: `users` and `bookmarks`. Users have bookmarks.

User authentication uses OpendID Connect. No credentials are stored.

After logging into the application a cookie is set that is symmetrically encrypted and which contains the userid of the authenticated user.

The web application is completely JavaScript free, not for ideological reasons but simply because it doesn't need any at the moment.

The application supports adding, editing, searching and showing all bookmarks.

The bookmarks collection page is reverse chronologically sorted and paged using the [Scrolling Cursor pattern](https://www2.sqlite.org/cvstrac/wiki?p=ScrollingCursor) in sqlite.

Pages are delivered with gzip compression.

Pages are cached with a revalidate strategy that is based on the time of the last change made to the database for the current user.

Full text search is implemented using the sqlite fts5 extension. A build script is included for local and docker based builds to make sure the extension is activated.

One requirement of the design was that the `/addbookmark` page should be easily invokable from a bookmarklet or a browser extension as a shortcut for adding new URLs.
