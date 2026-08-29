# Sync Protocol Spec

This document defines the client-server protocol for syncing CRDT operations.
The server treats operation payloads as opaque JSON and only uses metadata for
ordering and deduplication.

## Overview

- Transport: HTTP + JSON.
- Server storage: SQLite snapshot blob + op log since snapshot.
- Live updates: fixed-interval polling via `GET /sync/pull`.
- Dedupe key: `(actor, clock, scope, resourceId)`.

## Sync Envelope

Each operation is wrapped in a generic envelope so the server does not need to
understand CRDT payloads.

```json
{
  "scope": "registry",
  "resourceId": "registry",
  "actor": "actor-123",
  "clock": 42,
  "payload": { "type": "renameList", "listId": "list-1", "title": "Inbox" },
  "serverSeq": 100
}
```

### Fields

- `scope`: `"registry"` or `"list"`.
- `resourceId`: registry id or list id.
- `actor`: client actor id.
- `clock`: Lamport clock value from the client CRDT instance.
- `payload`: CRDT operation payload (opaque to server).
- `serverSeq`: assigned by server on ingestion.

## Endpoints

### GET /sync/bootstrap

Returns the current snapshot blob, op log replay since snapshot, and current `serverSeq`.

Response:
```json
{
  "datasetGenerationKey": "dataset-uuid",
  "snapshot": "{...snapshot json...}",
  "serverSeq": 100,
  "ops": [ /* SyncOp[] */ ]
}
```

### POST /sync/push

Pushes a batch of operations and updates the client's cursor.

Request:
```json
{
  "clientId": "client-abc",
  "datasetGenerationKey": "dataset-uuid",
  "ops": [ /* SyncOp[] without serverSeq */ ]
}
```

Response:
```json
{
  "serverSeq": 120,
  "datasetGenerationKey": "dataset-uuid"
}
```

### GET /sync/pull?since=123&clientId=client-abc&datasetGenerationKey=dataset-uuid

Pulls operations newer than `since` and updates the client's cursor.

Response:
```json
{
  "serverSeq": 130,
  "datasetGenerationKey": "dataset-uuid",
  "ops": [ /* SyncOp[] */ ]
}
```

If the dataset key is stale, the server responds with `409 Conflict` and:

```json
{
  "datasetGenerationKey": "dataset-uuid",
  "snapshot": "{...snapshot json...}"
}
```

### POST /sync/reset

Replaces the current dataset with a new snapshot (import/reset).

Request:
```json
{
  "clientId": "client-abc",
  "datasetGenerationKey": "dataset-uuid",
  "snapshot": "{...snapshot json...}"
}
```

Response:
```json
{
  "serverSeq": 0,
  "datasetGenerationKey": "dataset-uuid"
}
```

## Dedupe Behavior

- The server ignores any op with a `(actor, clock, scope, resourceId)` key that
  already exists in storage.
- The server does not parse or validate `payload` beyond JSON decoding.

## Client Cursor Tracking

- Client includes `clientId` on every push and pull.
- Server records `clientId` -> `lastSeenServerSeq` for safe compaction (only for the active generation).

## Notes

- The server treats `snapshot` as an opaque JSON string.
- Compaction can drop ops prior to the current snapshot.
