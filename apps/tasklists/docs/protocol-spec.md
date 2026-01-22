# Sync Protocol Spec

This document defines the client-server protocol for syncing CRDT operations.
The server treats operation payloads as opaque JSON and only uses metadata for
ordering and deduplication.

## Overview

- Transport: HTTP + JSON.
- Server storage: SQLite op log (no snapshots initially).
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

Returns the full op log replay and current `serverSeq`.

Response:
```json
{
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
  "ops": [ /* SyncOp[] without serverSeq */ ]
}
```

Response:
```json
{
  "serverSeq": 120
}
```

### GET /sync/pull?since=123&clientId=client-abc

Pulls operations newer than `since` and updates the client's cursor.

Response:
```json
{
  "serverSeq": 130,
  "ops": [ /* SyncOp[] */ ]
}
```

## Dedupe Behavior

- The server ignores any op with a `(actor, clock, scope, resourceId)` key that
  already exists in storage.
- The server does not parse or validate `payload` beyond JSON decoding.

## Client Cursor Tracking

- Client includes `clientId` on every push and pull.
- Server records `clientId` -> `lastSeenServerSeq` for safe compaction.

## Notes

- Snapshots are deferred; all bootstrap relies on op log replay.
- Compaction can be added later by pruning ops below the minimum client cursor
  once all active clients have seen them.
