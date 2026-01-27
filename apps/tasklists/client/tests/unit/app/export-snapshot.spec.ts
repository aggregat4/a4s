import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExportSnapshot,
  parseExportSnapshot,
  parseExportSnapshotText,
  SNAPSHOT_SCHEMA,
} from "../../../src/app/export-snapshot.js";

const makeRegistryState = () => ({
  clock: 1,
  entries: [
    {
      id: "list-1",
      pos: [{ digit: 1, actor: "actor-a" }],
      data: { title: "List One" },
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
  ],
});

const makeListState = () => ({
  clock: 2,
  title: "List One",
  titleUpdatedAt: 2,
  entries: [
    {
      id: "task-1",
      pos: [{ digit: 1, actor: "actor-a" }],
      data: { text: "Task", done: false, note: "" },
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
  ],
});

test("export snapshot builds schema envelope", () => {
  const envelope = buildExportSnapshot({
    registryState: makeRegistryState(),
    lists: [{ listId: "list-1", state: makeListState() }],
    exportedAt: "2026-01-27T00:00:00.000Z",
  });
  assert.equal(envelope.schema, SNAPSHOT_SCHEMA);
  assert.equal(envelope.data.lists.length, 1);
  assert.equal(envelope.data.registry.entries.length, 1);
});

test("snapshot parsing validates schema", () => {
  const result = parseExportSnapshot({ schema: "bad", data: {} });
  assert.equal(result.ok, false);
});

test("snapshot parse round-trips serialized data", () => {
  const envelope = buildExportSnapshot({
    registryState: makeRegistryState(),
    lists: [{ listId: "list-1", state: makeListState() }],
    exportedAt: "2026-01-27T00:00:00.000Z",
  });
  const parsed = parseExportSnapshot(envelope);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.lists.length, 1);
  assert.equal(parsed.value.registryState.entries.length, 1);
  assert.equal(parsed.value.lists[0].state.entries[0].data.text, "Task");
});

test("snapshot parse rejects invalid json", () => {
  const parsed = parseExportSnapshotText("{");
  assert.equal(parsed.ok, false);
});
