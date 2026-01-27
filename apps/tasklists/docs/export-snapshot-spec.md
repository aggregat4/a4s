# Export Snapshot Spec (v1)

## Overview
The export snapshot is a JSON document representing the current state of all lists. It is intended for export/import and for server-side storage as an opaque snapshot blob. The server must not interpret the contents.

## Media Type
- `application/json`

## Schema ID
- `net.aggregat4.tasklist.snapshot@v1`

## Top-Level Structure

```json
{
  "schema": "net.aggregat4.tasklist.snapshot@v1",
  "exportedAt": "2026-01-27T00:00:00.000Z",
  "appVersion": "<optional build/version>",
  "data": {
    "registry": { /* RegistryState */ },
    "lists": [
      {
        "listId": "<list-id>",
        "state": { /* ListState */ }
      }
    ]
  }
}
```

## RegistryState
`registry` is the output of `serializeRegistryState()` and follows:

```json
{
  "version": 1,
  "clock": 0,
  "entries": [
    {
      "id": "list-...",
      "pos": [{ "digit": 1, "actor": "actor-..." }],
      "data": { "title": "List title" },
      "createdAt": 0,
      "updatedAt": 0,
      "deletedAt": null
    }
  ]
}
```

## ListState
Each `state` is the output of `serializeListState()` and follows:

```json
{
  "version": 1,
  "clock": 0,
  "title": "List title",
  "titleUpdatedAt": 0,
  "entries": [
    {
      "id": "task-...",
      "pos": [{ "digit": 1, "actor": "actor-..." }],
      "data": { "text": "Task", "done": false, "note": "" },
      "createdAt": 0,
      "updatedAt": 0,
      "deletedAt": null
    }
  ]
}
```

## Validation Rules (Client)
- `schema` must equal `net.aggregat4.tasklist.snapshot@v1`.
- `data.registry` must be a valid RegistryState shape.
- `data.lists` must be an array of `{ listId, state }`.
- Each `state` must be a valid ListState shape.
- Unknown fields are ignored.

## Compatibility
- Future versions must update `schema`.
- Import should reject unknown schema values.
