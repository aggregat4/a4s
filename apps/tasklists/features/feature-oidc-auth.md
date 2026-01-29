# Feature Design: OIDC Authentication (Backend-Handled) + User Partitioning

## Goals

- Add OIDC-based authentication handled by the backend, using an external IDP.
- Ensure server endpoints are protected and data access is scoped by user.
- Keep the auth library footprint small and avoid vendor lock-in.
- Preserve existing sync behavior while introducing identity-aware partitions.

## Non-Goals (initially)

- SSO across multiple apps.
- Fine-grained role/permission management beyond tenant membership.
- Cross-tenant sharing or collaboration.
- Device management or admin UI.

## Assumptions

- The app remains a browser SPA with a Go backend.
- The IDP supports the Authorization Code flow.
- The backend handles the OIDC flow and maintains a session for the browser.
- Client still owns local CRDT state and syncs via existing endpoints.

## Backend Library Choice

Use `github.com/aggregat4/go-baselib-services` for OIDC, sessions, and CSRF:
- OIDC management: `oidc/oidc_std.go`
- Session management: `oidc/session_std.go` (wraps `gorilla/sessions`)
- CSRF middleware: `middleware/middleware_std.go`

## Proposed Auth Flow (Backend-Handled)

- Authorization Code flow initiated by the backend.
- Browser hits `/auth/login` on the backend, which redirects to the IDP.
- IDP redirects back to `/auth/callback`; backend exchanges code for tokens.
- Backend creates a session (cookie) and stores identity claims server-side.
- API calls rely on the session cookie; no token handling in the SPA.

## Session + Token Storage Strategy

- Encrypted session cookies containing `user_id` (from ID token `sub`).
- Encryption/signing key is configurable; default to a randomly generated key.
- Cookie is HttpOnly + Secure + SameSite=Lax.
- Session TTL: 30 days.
- Avoid exposing access tokens to the browser.
- No refresh tokens for now; re-auth on session expiry.

## Server-Side Auth (Required)

- Require a valid session cookie on all sync endpoints.
- Token validation happens in the auth callback (once per login):
  - JWT verification using IDP JWKS.
- Extract identity claims on login:
  - `sub` as `user_id`.

## User-Scoped Data Model

Current server schema stores ops/snapshots globally. We will scope everything
per user and do not support shared data.

- Use `user_id` (OIDC `sub`) as the partition key.
- Add `user_id` to:
  - snapshots
  - meta
  - ops
  - clients
- Key the active dataset per user.

## API Changes

- Add `/auth/login`, `/auth/callback`, `/auth/logout`.
- All sync endpoints require a valid session.
- Pass `user_id` through request context.
- Update sync queries to scope by partition key.
- No `/me` endpoint for now.

## Client Changes (Minimal)

- Minimal: UI triggers `/auth/login` (full page redirect).
- Gate sync bootstrapping on authenticated session.

## Migration Plan (High-Level)

1) Define config keys (issuer, client_id, redirect_uri, session key).
2) Implement backend OIDC flow + session management via go-baselib-services.
3) Add server-side auth middleware and request identity context.
4) Introduce user partitioning in storage + API queries.
5) Update sync endpoints to scope by `user_id`.
6) Add tests (unit for token validation, integration for scoped sync).

## Risks & Edge Cases

- Session expiry during sync loops (need retry + re-auth behavior).

## Open Questions

None currently.
