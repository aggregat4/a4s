import test from "node:test";
import assert from "node:assert/strict";
import { applyPendingChanges } from "../../../src/ui/state/pending-changes.js";
import type { PendingChange } from "../../../src/ui/state/pending-changes.js";
import type { TaskListState } from "../../../src/types/domain.js";

const task = (id: string, text = id) => ({ id, text, done: false, note: "" });
const list = (...ids: string[]): TaskListState => ({ title: "List", items: ids.map((id) => task(id)) });
const ids = (state: TaskListState) => state.items.map((item) => item.id);

test("an insert goes after its neighbour, or before the other one", () => {
  const insert = (afterId: string | null, beforeId: string | null): PendingChange => ({
    type: "insert",
    item: task("new"),
    afterId,
    beforeId,
  });
  assert.deepEqual(ids(applyPendingChanges(list("a", "b"), [insert("a", "b")])), ["a", "new", "b"]);
  assert.deepEqual(ids(applyPendingChanges(list("a", "b"), [insert("gone", "b")])), ["a", "new", "b"]);
  assert.deepEqual(ids(applyPendingChanges(list("a", "b"), [insert(null, "a")])), ["new", "a", "b"]);
  assert.deepEqual(ids(applyPendingChanges(list("a", "b"), [insert(null, "gone")])), ["new", "a", "b"]);
  assert.deepEqual(ids(applyPendingChanges(list("a", "b"), [insert("gone", "gone")])), ["a", "b", "new"]);
});

test("a move takes the task to its new neighbours", () => {
  const moved = applyPendingChanges(list("a", "b", "c"), [
    { type: "move", id: "a", afterId: "b", beforeId: "c" },
  ]);
  assert.deepEqual(ids(moved), ["b", "a", "c"]);
});

test("changes the repository already saved change nothing more", () => {
  const changes: PendingChange[] = [
    { type: "insert", item: task("new"), afterId: null, beforeId: "a" },
    { type: "update", id: "a", fields: { text: "edited", done: true } },
    { type: "remove", id: "b" },
    { type: "move", id: "c", afterId: null, beforeId: "new" },
    { type: "rename", title: "Renamed" },
  ];
  const once = applyPendingChanges(list("a", "b", "c"), changes);
  assert.deepEqual(applyPendingChanges(once, changes), once);
  assert.deepEqual(once, {
    title: "Renamed",
    items: [task("c"), task("new"), { ...task("a"), text: "edited", done: true }],
  });
});

test("changes to a task another device deleted change nothing", () => {
  const state = list("a");
  assert.deepEqual(
    applyPendingChanges(state, [
      { type: "update", id: "gone", fields: { text: "x" } },
      { type: "move", id: "gone", afterId: "a", beforeId: null },
      { type: "remove", id: "gone" },
    ]),
    state
  );
});
