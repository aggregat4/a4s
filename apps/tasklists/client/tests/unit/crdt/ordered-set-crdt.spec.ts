import test from "node:test";
import assert from "node:assert/strict";
import { OrderedSetCRDT } from "../../../src/domain/crdt/ordered-set-crdt.js";
import { deserializeOrderedSetSnapshot, serializeOrderedSetSnapshot } from "../../../src/storage/serde.js";

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
  assert.equal(withDeleted[0].deletedAt! > 0, true);
});

function seedConcurrentReplicas() {
  const seed = new OrderedSetCRDT({ actorId: "seed" });
  seed.generateInsert({ itemId: "a", data: { label: "a" } });
  seed.generateInsert({ itemId: "b", data: { label: "b" }, afterId: "a" });
  seed.generateInsert({ itemId: "c", data: { label: "c" }, afterId: "b" });
  const entries = seed.exportState().entries;
  const clock = seed.getClockValue();
  const clientA = new OrderedSetCRDT({ actorId: "actor-a" });
  const clientB = new OrderedSetCRDT({ actorId: "actor-b" });
  // importRecords alone does not advance the clock, so merge it explicitly to
  // mirror hydration from persisted state.
  clientA.importRecords(entries);
  clientA.clock.merge(clock);
  clientB.importRecords(entries);
  clientB.clock.merge(clock);
  return { clientA, clientB };
}

test("concurrent moves with equal clocks converge", () => {
  const { clientA, clientB } = seedConcurrentReplicas();

  const moveA = clientA.generateMove({ itemId: "b", beforeId: "a" }).op;
  const moveB = clientB.generateMove({ itemId: "b", afterId: "c" }).op;
  assert.equal(moveA.clock, moveB.clock);

  // Each replica already applied its own move; now exchange them.
  clientA.applyOperation(moveB);
  clientB.applyOperation(moveA);

  assert.deepEqual(
    clientA.getSnapshot().map((entry) => entry.id),
    clientB.getSnapshot().map((entry) => entry.id)
  );
});

test("concurrent updates with equal clocks converge", () => {
  const { clientA, clientB } = seedConcurrentReplicas();

  const updateA = clientA.generateUpdate({
    itemId: "b",
    data: { label: "from-a" },
  }).op;
  const updateB = clientB.generateUpdate({
    itemId: "b",
    data: { label: "from-b" },
  }).op;
  assert.equal(updateA.clock, updateB.clock);

  clientA.applyOperation(updateB);
  clientB.applyOperation(updateA);

  const labelA = clientA.getSnapshot().find((entry) => entry.id === "b")?.data;
  const labelB = clientB.getSnapshot().find((entry) => entry.id === "b")?.data;
  assert.deepEqual(labelA, labelB);
});

test("a concurrent completion and move preserve the same item order on both clients", () => {
  const { clientA, clientB } = seedConcurrentReplicas();
  // A has moved b to the front while B completes it without seeing the move.
  const move = clientA.generateMove({ itemId: "b", beforeId: "a" }).op;
  const complete = clientB.generateUpdate({
    itemId: "b",
    data: { done: true },
  }).op;
  assert.equal(move.clock, complete.clock);

  clientA.applyOperation(complete);
  clientB.applyOperation(move);

  const view = (client: OrderedSetCRDT) =>
    client.getSnapshot().map(({ id, data }) => ({ id, data }));
  assert.deepEqual(view(clientA), view(clientB));
  assert.deepEqual(clientA.getSnapshot().map(({ id }) => id), ["b", "a", "c"]);

  // Saving and reopening a client must retain the independent write markers.
  const restored = new OrderedSetCRDT({ actorId: "actor-b" });
  restored.importRecords(deserializeOrderedSetSnapshot(serializeOrderedSetSnapshot(clientB.exportState().entries)));
  assert.deepEqual(view(restored), view(clientA));
  assert.deepEqual(restored.getItem("b")?.pos, clientA.getItem("b")?.pos);
});

test("a concurrent move does not suppress an older actor's completion", () => {
  const { clientA, clientB } = seedConcurrentReplicas();
  const complete = clientA.generateUpdate({ itemId: "b", data: { done: true } }).op;
  const move = clientB.generateMove({ itemId: "b", beforeId: "a" }).op;

  clientA.applyOperation(move);
  clientB.applyOperation(complete);

  assert.deepEqual(clientA.getSnapshot(), clientB.getSnapshot());
  assert.equal(clientB.getItem("b")?.data.done, true);
});

test("mixed concurrent edits converge in every arrival order and after serialization", () => {
  const seed = new OrderedSetCRDT({ actorId: "seed" });
  seed.generateInsert({ itemId: "a", data: { text: "old", done: false, note: "" } });
  seed.generateInsert({ itemId: "b", data: { text: "second", done: false, note: "" }, afterId: "a" });
  const baseline = seed.exportState();
  const makeReplica = () => {
    const replica = new OrderedSetCRDT({ actorId: "reader" });
    replica.importRecords(baseline.entries);
    replica.clock.merge(baseline.clock);
    return replica;
  };
  const sources = ["text", "done", "note", "move"].map((actorId) => {
    const replica = new OrderedSetCRDT({ actorId });
    replica.importRecords(baseline.entries);
    replica.clock.merge(baseline.clock);
    return replica;
  });
  const moveOp = sources[3].generateMove({ itemId: "b", beforeId: "a" }).op;
  const ops = [
    sources[0].generateUpdate({ itemId: "a", data: { text: "new" } }).op,
    sources[1].generateUpdate({ itemId: "a", data: { done: true } }).op,
    sources[2].generateUpdate({ itemId: "a", data: { note: "detail" } }).op,
    moveOp,
  ];
  const permutations = (remaining: typeof ops, prefix: typeof ops = []): Array<typeof ops> =>
    remaining.length === 0
      ? [prefix]
      : remaining.flatMap((op, index) =>
          permutations(remaining.filter((_, i) => i !== index), [...prefix, op])
        );
  const view = (replica: OrderedSetCRDT) =>
    replica.getSnapshot().map(({ id, pos, data }) => ({ id, pos, data }));
  const expected = [
    { id: "b", pos: moveOp.payload.pos, data: { text: "second", done: false, note: "" } },
    { id: "a", pos: baseline.entries[0].pos, data: { text: "new", done: true, note: "detail" } },
  ];

  for (const order of permutations(ops)) {
    const replica = makeReplica();
    order.forEach((op) => replica.applyOperation(op));
    assert.deepEqual(view(replica), expected);
    const reopened = makeReplica();
    reopened.importRecords(deserializeOrderedSetSnapshot(serializeOrderedSetSnapshot(replica.exportState().entries)));
    assert.deepEqual(view(reopened), expected);
  }
});

test("equal positions sort identically after opposite insert arrival orders", () => {
  const clientA = new OrderedSetCRDT({ actorId: "actor-a" });
  const clientB = new OrderedSetCRDT({ actorId: "actor-b" });
  const pos = [{ digit: 512, actor: "shared" }];
  const inserts = ["z", "a"].map((itemId, index) => ({
    type: "insert" as const,
    itemId,
    actor: "shared",
    clock: index + 1,
    payload: { pos, data: { label: itemId } },
  }));

  inserts.forEach((op) => clientA.applyOperation(op));
  inserts.slice().reverse().forEach((op) => clientB.applyOperation(op));

  assert.deepEqual(clientA.getSnapshot().map(({ id }) => id), ["a", "z"]);
  assert.deepEqual(clientB.getSnapshot().map(({ id }) => id), ["a", "z"]);
});

test("an item brought back after its removal stays, in every arrival order and after reopening", () => {
  const source = new OrderedSetCRDT({ actorId: "source" });
  const ops = [
    source.generateInsert({ itemId: "x", data: { label: "x" } }).op,
    source.generateRemove("x").op,
    source.generateInsert({ itemId: "x", data: { label: "x" } }).op,
  ];
  const view = (replica: OrderedSetCRDT) => replica.getSnapshot().map(({ id }) => id);
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of orders) {
    const replica = new OrderedSetCRDT({ actorId: "reader" });
    order.forEach((i) => replica.applyOperation(ops[i]));
    assert.deepEqual(view(replica), ["x"], `order ${order}`);

    // Reopening replays the stored operations on the saved state.
    const reopened = new OrderedSetCRDT({ actorId: "reader" });
    reopened.importRecords(
      deserializeOrderedSetSnapshot(serializeOrderedSetSnapshot(replica.exportState().entries))
    );
    ops.forEach((op) => reopened.applyOperation(op));
    assert.deepEqual(view(reopened), ["x"], `reopened after order ${order}`);
  }
});

test("a removal after an item was brought back removes it", () => {
  const source = new OrderedSetCRDT({ actorId: "source" });
  source.generateInsert({ itemId: "x", data: {} });
  source.generateRemove("x");
  source.generateInsert({ itemId: "x", data: {} });
  source.generateRemove("x");
  assert.deepEqual(source.getSnapshot(), []);
});

test("exported state captures entries and clock", () => {
  const crdt = new OrderedSetCRDT({ actorId: "tester" });
  crdt.generateInsert({ itemId: "one", data: { value: 1 } });
  const state = crdt.exportState();
  assert.ok(Number.isFinite(state.clock));
  assert.equal(state.entries.length, 1);
});
