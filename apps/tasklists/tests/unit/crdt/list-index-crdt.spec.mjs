import test from "node:test";
import assert from "node:assert/strict";
import { ListIndexCRDT } from "../../../lib/crdt/list-index.js";

test("list index CRDT creates, reorders, and removes lists", () => {
    const index = new ListIndexCRDT({ actorId: "actor-idx" });

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

    const rename = index.generateRename("beta", "Renamed");
    assert.equal(rename.snapshot[0].title, "Renamed");

    const remove = index.generateRemove("beta");
    assert.equal(remove.snapshot.length, 1);
    assert.equal(remove.snapshot[0].id, "alpha");
});
