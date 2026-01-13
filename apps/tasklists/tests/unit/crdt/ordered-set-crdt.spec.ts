import test from "node:test";
import assert from "node:assert/strict";
import { OrderedSetCRDT } from "../../../lib/crdt/ordered-set-crdt.js";

test("ordered set retains positional ordering across inserts", () => {
  const crdt = new OrderedSetCRDT({ actorId: "tester" });

  const first = crdt.generateInsert({ itemId: "a", data: { label: "first" } });
  const second = crdt.generateInsert({
    itemId: "b",
    data: { label: "second" },
    afterId: "a",
  });
  const beforeFirst = crdt.generateInsert({
    itemId: "c",
    data: { label: "before" },
    beforeId: "a",
  });

  assert.equal(first.op.type, "insert");
  assert.equal(second.op.type, "insert");
  assert.equal(beforeFirst.op.type, "insert");

  const snapshot = crdt.getSnapshot();
  assert.equal(snapshot.length, 3);
  assert.deepEqual(
    snapshot.map((item) => item.id),
    ["c", "a", "b"]
  );
});

test("update operations modify payload data and respect causality", () => {
  const crdt = new OrderedSetCRDT({ actorId: "tester" });
  crdt.generateInsert({ itemId: "item-1", data: { value: 1 } });

  const { op } = crdt.generateUpdate({
    itemId: "item-1",
    data: { value: 2, added: true },
  });
  assert.equal(op.type, "update");
  assert.equal(op.payload.data.value, 2);

  const snapshot = crdt.getSnapshot();
  assert.equal(snapshot[0].data.value, 2);
  assert.equal(snapshot[0].data.added, true);

  // Re-applying the same operation should be idempotent.
  const changed = crdt.applyOperation(op);
  assert.equal(changed, false);
});

test("remove operations set tombstones and snapshots omit deleted items by default", () => {
  const crdt = new OrderedSetCRDT({ actorId: "tester" });
  crdt.generateInsert({ itemId: "item-1", data: {} });
  const { op } = crdt.generateRemove("item-1");
  assert.equal(op.type, "remove");

  const visible = crdt.getSnapshot();
  assert.equal(visible.length, 0);

  const withDeleted = crdt.getSnapshot({ includeDeleted: true });
  assert.equal(withDeleted.length, 1);
  assert.equal(withDeleted[0].deletedAt > 0, true);
});

test("exported state captures entries and clock", () => {
  const crdt = new OrderedSetCRDT({ actorId: "tester" });
  crdt.generateInsert({ itemId: "one", data: { value: 1 } });
  const state = crdt.exportState();
  assert.ok(Number.isFinite(state.clock));
  assert.equal(state.entries.length, 1);
});
