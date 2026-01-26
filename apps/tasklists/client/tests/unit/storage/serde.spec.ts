import test from "node:test";
import assert from "node:assert/strict";
import {
    serializeListState,
    deserializeListState,
    serializeRegistryState,
    deserializeRegistryState,
    serializeOperation,
    deserializeOperation,
    serializeOrderedSetSnapshot,
    deserializeOrderedSetSnapshot,
} from "../../../src/storage/serde.js";
import type { TaskListOperation } from "../../../src/types/crdt.js";

test("list state serialization round-trips entries and metadata", () => {
    const original = {
        clock: 5,
        title: "Inbox",
        titleUpdatedAt: 4,
        entries: [
            {
                id: "task-1",
                pos: [
                    { digit: 10, actor: "a" },
                    { digit: 5, actor: "b" },
                ],
                data: { text: "Task", done: true, note: "Context" },
                createdAt: 1,
                updatedAt: 2,
                deletedAt: null,
            },
        ],
    };

    const encoded = serializeListState(original);
    const decoded = deserializeListState(encoded);
    assert.equal(decoded.title, original.title);
    assert.equal(decoded.entries.length, 1);
    assert.equal(decoded.entries[0].data.text, "Task");
    assert.equal(decoded.entries[0].data.done, true);
    assert.equal(decoded.entries[0].data.note, "Context");
});

test("registry state serialization retains ordering data", () => {
    const original = {
        clock: 3,
        entries: [
            {
                id: "list-1",
                pos: [{ digit: 1, actor: "a" }],
                data: { title: "A" },
                createdAt: 1,
                updatedAt: 2,
                deletedAt: null,
            },
        ],
    };

    const encoded = serializeRegistryState(original);
    const decoded = deserializeRegistryState(encoded);
    assert.equal(decoded.entries[0].data.title, "A");
    assert.equal(decoded.entries[0].pos.length, 1);
});

test("operation serialization drops undefined fields and restores payload", () => {
    const original: TaskListOperation = {
        type: "insert",
        itemId: "task-1",
        payload: { pos: [{ digit: 5, actor: "x" }] },
        clock: 7,
        actor: "actor-1",
    };
    const encoded = serializeOperation(original);
    assert.equal(Object.prototype.hasOwnProperty.call(encoded, "listId"), false);
    const decoded = deserializeOperation(encoded);
    assert.equal(decoded.actor, "actor-1");
    assert.equal(decoded.payload.pos[0].digit, 5);
});

test("ordered set snapshot helpers filter invalid entries", () => {
    const encoded = serializeOrderedSetSnapshot(
        [
            {
                id: "valid",
                pos: [{ digit: 1, actor: "a" }],
                data: { value: 1 },
                createdAt: 0,
                updatedAt: 0,
                deletedAt: null,
            },
            {
                id: "",
                pos: [],
                data: {},
            },
        ],
        (data) => data,
    );
    assert.equal(encoded.length, 1);
    const decoded = deserializeOrderedSetSnapshot(encoded, (data) => data);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].id, "valid");
});
