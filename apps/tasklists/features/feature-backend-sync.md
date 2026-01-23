# Feature Design: Backend Sync

## Assumptions

- Single-user data model (no auth yet, but future OIDC in mind).
- Each client has a stable actor id (already via localStorage).
- CRDT operations are the source of truth; merge is operation-based.
- Server is lightweight: store and serve latest data.
- Client must never drop local updates when server updates arrive.

## Scope

In scope:
- Sync protocol for registry + list operations.
- Server storage for op log.
- Client outbox + pull updates with safe merge behavior.
- Fixed-interval polling for refresh.
- Monorepo layout proposal.

Out of scope (initially):
- Multi-user auth and permissions.
- Server-driven access control.
- Cross-user sharing or collaboration.
- Data encryption or key management.

## Current Client Snapshot (Constraints)

- Registry + list CRDTs emit `ListsOperation` and `TaskListOperation`.
- Lamport clock per actor (`actor` + `clock` uniqueness).
- Local storage is IndexedDB via `ListStorage`.
- `ListRepository` owns CRDT state and emits registry/list updates.
- UI state sync is centralized in `RepositorySync`.

## Proposed Architecture

### Data Model

- Introduce a generic sync envelope so the server can treat payloads as opaque:
  - `scope`: `registry` | `list`.
  - `resourceId`: registry id or list id.
  - `actor`, `clock`.
  - `payload`: serialized op body (opaque to server).
  - `serverSeq` assigned by server.
  - Full protocol details: `docs/protocol-spec.md`.

- Client tracks:
  - `lastServerSeq` cursor (persisted).
  - `outbox` of unsent ops (persisted).
  - `knownActorClocks` (optional for validation).

### Server Responsibilities

- Accept op batches and dedupe on `(actor, clock, scope, resourceId)`.
- Assign `serverSeq` in arrival order to enable incremental pulls.
- Store op log for bootstrap and incremental pulls.
- Serve bootstrap payload with full op log replay + current `serverSeq`.
- Track `clientId` cursors to make compaction safe.

### Sync Flow

1. Bootstrap
   - Client calls `GET /sync/bootstrap`.
   - Response includes op log and current `serverSeq`.
   - Client hydrates repository with op replay, then starts live sync.

2. Push
   - Client sends batched ops from outbox.
   - Server dedupes, stores, assigns `serverSeq`.
   - Server records `clientId` cursor for compaction safety.

3. Pull
   - Client requests ops since `lastServerSeq`.
   - Server returns op batches in `serverSeq` order.
   - Client applies ops to repository CRDTs.
   - Server records `clientId` cursor for compaction safety.

4. Live Refresh (optional)
   - Fixed-interval polling via `GET /sync/pull`.
   - Client updates `lastServerSeq` after apply.

### Conflict Handling

- CRDT merge remains source of truth; incoming ops are applied through the
  existing CRDT pipeline.
- Local ops are applied immediately (optimistic), with server ack later.
- If server sends ops already applied locally, CRDT idempotency handles it.

## Protocol Reference

- See `docs/protocol-spec.md` for the full endpoint definitions and payloads.

## Server Storage Plan

- Storage tables (SQLite):
  - `ops`: `serverSeq`, `scope`, `resourceId`, `actor`, `clock`, `payload`.
  - `clients`: `clientId`, `lastSeenServerSeq`.

- Compaction:
  - Periodically compute snapshots and prune ops with
    `serverSeq < min(client.lastSeenServerSeq)`.
  - Keep a safety buffer to avoid edge case data loss during reconnects.

## Client Changes

- Add a `SyncEngine` owned by `ListRepository` (or a sibling module):
  - Maintains outbox and cursor.
  - Pushes ops and updates `lastServerSeq`.
  - Pulls ops and applies them via repository methods.

- Extend storage to persist:
  - `outbox`.
  - `lastServerSeq`.
  - `clientId` (actor id) for server cursor tracking.

- Ensure state ownership:
  - Apply remote ops via repository methods and emit registry/list changes.
  - UI state updates stay downstream of repository updates.

## Monorepo Layout Proposal

- `client` (current app).
- `server` (Go backend).
- `docs/protocol-spec.md` (sync envelope spec + payload examples; no shared code).

Tooling options:
- npm workspaces for the client app (already using npm).
- `server/go.mod` (standalone Go module).

## Implementation Plan

1. Protocol and shared types
   - Maintain the spec in `docs/protocol-spec.md`.
   - Document the `(actor, clock, scope, resourceId)` dedupe key invariant.

2. Client outbox + cursor storage
   - Persist `outbox` and `lastServerSeq` alongside existing storage.
   - Append to outbox whenever a local op is emitted.

3. Server skeleton (Go)
   - HTTP server with `/sync/bootstrap`, `/sync/push`, `/sync/pull`.
   - SQLite storage (op log + client cursors).
   - Dedup logic keyed by `(actor, clock, scope, resourceId)`.
   - Persist client cursors on every push/pull.

4. Apply/merge logic
   - On pull, apply ops through repository CRDT pipeline.
   - Confirm idempotency + lamport merge behavior.

5. Live refresh
   - Implement fixed-interval polling for updates.
   - Update client to poll and apply remote ops.

6. Compaction
   - Prune old ops only when safe for all known clients.
   - Future improvement: expire inactive clients to unblock compaction.

7. Tests
   - Unit tests for protocol encoding/decoding and dedupe.
   - Integration tests for push/pull cycles.
   - E2E test with two clients syncing via server.

## TS vs Go Decision Factors

- Decision: Go backend with op-log storage; server treats payload as opaque.
- CRDT logic stays client-side; snapshots are deferred and optional.

## Future Enhancements (Optional)

- Add server-side snapshots to speed up bootstrap on large datasets.
- Add compaction that leverages snapshots once they exist.

## Decision Log

- 2026-01-22: Choose Go backend with SQLite storage and opaque payload sync.
- 2026-01-22: Dedupe key uses `(actor, clock, scope, resourceId)`; no `opId`.
- 2026-01-22: Bootstrap uses op log replay; snapshots deferred.
- 2026-01-22: Use fixed-interval polling for live updates; low volume and simpler/robust operation.
- 2026-01-22: Track client cursors on every push/pull; compaction uses min cursor.
- 2026-01-22: Send `clientId` on pull via query parameter.

## Open Questions

None (all current decisions locked in).
