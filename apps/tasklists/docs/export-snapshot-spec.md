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
    "lists": [
      {
        "listId": "<list-id>",
        "title": "List title",
        "items": [
          {
            "id": "<task-id>",
            "text": "Task",
            "done": false,
            "note": ""
          }
        ]
      }
    ]
  }
}
```

## Lists
`data.lists` is the ordered list of lists as they appear in the UI.

```json
{
  "listId": "list-...",
  "title": "List title",
  "items": [
    { "id": "task-...", "text": "Task", "done": false, "note": "" }
  ]
}
```

## Items
Each `items[]` entry represents the current task state in list order.

```json
{
  "id": "task-...",
  "text": "Task",
  "done": false,
  "note": ""
}
```

## Validation Rules (Client)
- `schema` must equal `net.aggregat4.tasklist.snapshot@v1`.
- `data.lists` must be an array of `{ listId, title, items }`.
- Each list item must include `id`, `text`, and `done`.
- Unknown fields are ignored.

## Compatibility
- Future versions must update `schema`.
- Import should reject unknown schema values.
