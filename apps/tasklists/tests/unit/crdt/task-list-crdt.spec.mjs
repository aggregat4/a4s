import test from "node:test";
import assert from "node:assert/strict";
import { TaskListCRDT } from "../../../lib/crdt/task-list-crdt.js";

test("task list CRDT inserts, toggles, and updates tasks", () => {
    const crdt = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });

    const insert = crdt.generateInsert({
        itemId: "task-1",
        text: "Initial task",
        done: false,
    });
    assert.equal(insert.op.type, "insert");
    assert.equal(insert.resultingSnapshot.length, 1);

    const toggle = crdt.generateToggle("task-1");
    assert.equal(toggle.op.payload.done, true);

    const update = crdt.generateUpdate({
        itemId: "task-1",
        text: "Renamed task",
    });
    assert.equal(update.op.payload.text, "Renamed task");

    const snapshot = crdt.getSnapshot();
    assert.equal(snapshot[0].text, "Renamed task");
    assert.equal(snapshot[0].done, true);
});

test("task list CRDT rename propagates and survives serialization round-trip", () => {
    const crdt = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });
    const rename = crdt.generateRename("Updated Inbox");
    assert.equal(rename.op.type, "renameList");
    assert.equal(crdt.title, "Updated Inbox");

    const exported = crdt.exportState();
    assert.equal(exported.title, "Updated Inbox");

    const restored = new TaskListCRDT({ actorId: "actor-2" });
    restored.resetFromState(exported);
    assert.equal(restored.title, "Updated Inbox");
    assert.equal(restored.getSnapshot().length, 0);

    const insert = crdt.generateInsert({
        itemId: "task-1",
        text: "Example",
    });
    const applied = restored.applyOperation(insert.op);
    assert.equal(applied, true);
    assert.equal(restored.getSnapshot()[0].text, "Example");
});
