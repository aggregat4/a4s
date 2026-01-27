# Feature Design: Export & Import (Snapshot JSON)

## Summary
Add sidebar Export/Import buttons. Export produces a versioned JSON snapshot. Import replaces local data with a snapshot and propagates the change to all clients by uploading the snapshot blob to the server. The server remains opaque: it stores the snapshot blob and op log without understanding their structure.

## Goals
- Simple user-facing Export/Import.
- Export is a full snapshot (no edit log).
- Import is a reset: replace local data and converge all clients to the new snapshot.
- Keep server lightweight (no snapshot parsing).
- Support future rollback by retaining older snapshot blobs.

## Non-Goals
- Merge import into existing data (v1).
- Keep edit history in exports.
- Server-side inspection or querying of snapshot contents.

## UX
- Sidebar: add `Export` and `Import` buttons near list actions.
- Export: trigger download with timestamped filename.
- Import: file picker + confirmation modal before overwrite.
- Success feedback uses existing UI patterns (no toast).

## Snapshot Format
- Documented in `docs/export-snapshot-spec.md`.
- Versioned envelope with a `schema` string.
- Payload uses the existing serialized snapshot shapes from `serde.ts`:
  - `registry` is `serializeRegistryState()` output.
  - `lists` is array of `{ listId, state }` where `state` is `serializeListState()` output.
- Snapshots contain only the current state (no historical ops or edit history).

## Core Design (Opaque Snapshot Blob)

### Server
- Stores **snapshot blob** (the export JSON) as opaque bytes.
- Stores **datasetGenerationKey** (generation id).
- Stores **op log** for incremental sync since snapshot.
- On **reset/import**:
  - Generate a new datasetGenerationKey.
  - Store the new snapshot blob as the active snapshot.
  - Optionally retain the previous snapshot blob for rollback.
  - Clear op log and reset serverSeq.

### Client
- Export: build snapshot JSON via existing serializers and download.
- Import:
  - Parse and validate snapshot schema.
  - Replace local storage with snapshot state.
  - Clear outbox and reset sync cursor.
  - Send snapshot blob to server (reset/import endpoint).
- Bootstrap:
  - Fetch snapshot blob + datasetGenerationKey + ops since snapshot.
  - Apply snapshot (hydrate) then apply ops.
  - Persist datasetGenerationKey and serverSeq.

### Sync Handshake
- Every sync request includes `datasetGenerationKey`.
- If server datasetGenerationKey != client datasetGenerationKey:
  - client clears local data,
  - fetches snapshot blob from server,
  - resets lastServerSeq,
  - applies ops since snapshot.

## Storage & API Changes

### Server tables
- `snapshot`: { datasetGenerationKey, snapshotBlob, updatedAt }
- `snapshot_history` (optional): { datasetGenerationKey, snapshotBlob, archivedAt }
- `ops`: existing op log (opaque payload)
- `clients`: lastSeenServerSeq for compaction safety (active generation only)

### Endpoints
- `GET /sync/bootstrap` returns:
  - `datasetGenerationKey`, `snapshotBlob`, `serverSeq`, `ops` (since snapshot)
- `POST /sync/reset` accepts:
  - `datasetGenerationKey` (new), `snapshotBlob`
  - clears ops, sets serverSeq to 0

## Validation & Safety
- Client validates schema/version before applying.
- Import shows confirmation before destructive overwrite.
- If import fails validation, leave existing data untouched.

## Edge Cases
- Import file from newer schema: block with clear error.
- Empty snapshot: allowed, results in zero lists.
- Large snapshots: show progress state.

## Implementation Plan
1. Client export: build snapshot via `serializeRegistryState` + `serializeListState`, download JSON.
2. Client import: validate schema, clear storage, write snapshot state, clear outbox + reset sync cursor.
3. Server storage: add snapshot blob store (active snapshot + optional history).
4. Server reset endpoint: accept new snapshot blob, create datasetGenerationKey, reset serverSeq + ops.
5. Sync handshake: include datasetGenerationKey on push/pull/bootstrap; on mismatch, fetch snapshot blob and reset local state.
6. UI: sidebar Export/Import buttons + confirmation modal (no toasts).
7. Tests: snapshot round‑trip, import reset locally, multi-client convergence after reset.

## Future Enhancements
- Retain historical snapshot blobs for rollback (if not enabled by default).
- Optional merge import path.
- Snapshot dedupe / compression (server-side).
