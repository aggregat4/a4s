import test from "node:test";
import assert from "node:assert/strict";
import { ListsCRDT } from "../../../src/domain/crdt/lists-crdt.js";

test("lists CRDT creates, reorders, and removes lists", () => {
    const index = new ListsCRDT({ actorId: "actor-idx" });

    const first = index.generateCreate({ listId: "alpha", title: "Alpha" });
    const second = index.generateCreate({
        listId: "beta",
        title: "Beta",
        afterId: "alpha",
    });

    assert.equal(first.snapshot.length, 1);
    assert.equal(second.snapshot.length, 2);
    assert.deepEqual(
        second.snapshot.map((entry) => entry.id),
        ["alpha", "beta"],
    );

    const reorder = index.generateReorder({
        listId: "beta",
        beforeId: "alpha",
    });
    assert.equal(reorder.snapshot[0].id, "beta");

    const remove = index.generateRemove("beta");
    assert.equal(remove.snapshot.length, 1);
    assert.equal(remove.snapshot[0].id, "alpha");
});

test("concurrent reorders converge with equal Lamport clocks", () => {
    const seed = new ListsCRDT({ actorId: "actor-seed" });
    let previousId: string | null = null;
    for (const id of ["a", "b", "c", "d"]) {
        seed.generateCreate({ listId: id, title: id, afterId: previousId });
        previousId = id;
    }
    const state = seed.exportState();

    const clientA = new ListsCRDT({ actorId: "actor-a" });
    const clientB = new ListsCRDT({ actorId: "actor-b" });
    clientA.resetFromState(state);
    clientB.resetFromState(state);

    const moveA = clientA.generateReorder({ listId: "c", beforeId: "a" }).op;
    const moveB = clientB.generateReorder({ listId: "c", afterId: "d" }).op;
    assert.equal(moveA.clock, moveB.clock);

    clientA.applyOperation(moveB);
    clientB.applyOperation(moveA);

    const order = (crdt: ListsCRDT) =>
        crdt.getVisibleLists().map((entry) => entry.id);
    assert.deepEqual(order(clientA), order(clientB));
});

test("lists CRDT rename updates title metadata", () => {
    const index = new ListsCRDT({ actorId: "actor-idx" });
    index.generateCreate({ listId: "alpha", title: "Alpha" });

    const result = index.generateRename("alpha", "Renamed");
    assert.equal(result.snapshot.length, 1);
    assert.equal(result.snapshot[0].title, "Renamed");

    const record = index.getRecord("alpha");
    assert.ok(record);
    assert.equal(record.title, "Renamed");
});
