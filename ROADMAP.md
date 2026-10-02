# Roadmap

Planned cross-application work for the A4S monorepo. Items here are agreed
direction but not yet scheduled; application-specific backlogs stay with each
application.

## Migrate CSRF protection to `http.CrossOriginProtection`

Go 1.25 added [`net/http.CrossOriginProtection`][cop], which rejects
cross-origin state-changing requests using the `Sec-Fetch-Site` header (sent by
all current browsers) and falls back to comparing `Origin` with `Host`. It
needs no tokens and no form or template changes, and it is maintained as part of
the standard library.

We currently use our own Origin-based middleware:

| Application | Current protection |
| ----------- | ------------------ |
| Bookmarks | `apps/bookmarks/internal/echomiddleware/csrf.go` (Echo port of the shared middleware) |
| Comments | `pkg/http/middleware.CsrfMiddlewareStd`, behind the `enableCsrf` flag |
| OpenID Provider | `pkg/http/middleware.CreateCsrfMiddlewareWithSkipperStd`, skipping `/token` and `/revoke` |
| Tasklists | `pkg/http/middleware.CsrfMiddlewareStd` |
| RSSGrid | none |

Compared with the standard library, the custom middleware only compares host
names (ignoring scheme and port) and trusts the client-controllable
`X-Forwarded-Host` header.

### Plan

1. Adopt `http.CrossOriginProtection` in RSSGrid first, since it has no
   protection today.
2. Migrate Tasklists, Comments and the OpenID Provider. Replace the skipper
   with `AddInsecureBypassPattern` for the OAuth endpoints
   (`POST /token`, `POST /revoke`), which are called server-to-server.
3. Migrate Bookmarks by wrapping the handler with `echo.WrapMiddleware`, and
   delete `echomiddleware/csrf.go`.
4. Deprecate, then remove, `CsrfMiddlewareStd` and
   `CreateCsrfMiddlewareWithSkipperStd` from `pkg/http/middleware`.

### Things to check during migration

- Requests that carry neither `Sec-Fetch-Site` nor `Origin` (non-browser
  clients such as curl or other services) are allowed by the standard library
  but rejected by the custom middleware. Make sure no application relied on
  that rejection.
- The fallback check compares `Origin` with the `Host` header. The shared
  Nginx snippet `deploy/nginx/snippets/a4-proxy-headers.conf` already forwards
  `Host $host`; keep it that way for every site.
- Add a test per application asserting that a cross-site `POST` is rejected
  with 403 and a same-origin one is accepted.

[cop]: https://pkg.go.dev/net/http#CrossOriginProtection
