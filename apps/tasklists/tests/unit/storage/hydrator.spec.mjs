import test from "node:test";
import assert from "node:assert/strict";
import { seedDefaultsIfEmpty, hydrateFromStorage } from "../../../lib/storage/hydrator.js";
import { ListsCRDT } from "../../../lib/crdt/lists-crdt.js";
import { TaskListCRDT } from "../../../lib/crdt/task-list-crdt.js";

const clone = (value) =>
    value == null ? value : JSON.parse(JSON.stringify(value));

class MemoryListStorage {
    constructor() {
        this.lists = new Map();
        this.registry = { state: null, operations: [], updatedAt: null };
    }

    async ready() {}

    async clear() {
        this.lists.clear();
        this.registry = { state: null, operations: [], updatedAt: null };
    }

    async loadAllLists() {
        return Array.from(this.lists.entries()).map(([listId, record]) => ({
            listId,
            state: clone(record.state),
            operations: record.operations.map((op) => clone(op)),
            updatedAt: record.updatedAt,
        }));
    }

    async loadRegistry() {
        return {
            state: clone(this.registry.state),
            operations: this.registry.operations.map((op) => clone(op)),
            updatedAt: this.registry.updatedAt,
        };
    }

    async persistOperations(listId, operations = [], options = {}) {
        if (typeof listId !== "string" || !listId.length) {
            throw new Error("persistOperations requires a listId");
        }
        const record =
            this.lists.get(listId) ?? { state: null, operations: [], updatedAt: null };
        if (Array.isArray(operations) && operations.length) {
            record.operations.push(...operations.map((op) => clone(op)));
        }
        if (options.snapshot) {
            record.state = clone(options.snapshot);
        }
        record.updatedAt = Date.now();
        this.lists.set(listId, record);
    }

    async persistRegistry({ operations = [], snapshot = null } = {}) {
        if (Array.isArray(operations) && operations.length) {
            this.registry.operations.push(...operations.map((op) => clone(op)));
        }
        if (snapshot) {
            this.registry.state = clone(snapshot);
        }
        this.registry.updatedAt = Date.now();
    }

    async loadList(listId) {
        const record = this.lists.get(listId);
        if (!record) {
            return { listId, state: null, operations: [], updatedAt: null };
        }
        return {
            listId,
            state: clone(record.state),
            operations: record.operations.map((op) => clone(op)),
            updatedAt: record.updatedAt,
        };
    }
}

test("hydrator seeds defaults and hydrates stored lists", async () => {
    const storage = new MemoryListStorage();
    await storage.clear();

    const index = new ListsCRDT({ actorId: "seed-index" });
    const seeded = await seedDefaultsIfEmpty({
        storage,
        listsCrdt: index,
        createListCrdt: () => new TaskListCRDT({ actorId: "seed-list" }),
        seedConfigs: [
            {
                id: "alpha",
                title: "Alpha",
                items: [
                    { id: "alpha-1", text: "One", done: false },
                    { id: "alpha-2", text: "Two", done: true },
                ],
            },
            { id: "beta", title: "Beta", items: [] },
        ],
    });
    assert.equal(seeded, true);

    const seededAgain = await seedDefaultsIfEmpty({
        storage,
        listsCrdt: index,
        seedConfigs: [{ title: "Should not apply" }],
    });
    assert.equal(seededAgain, false);

    const newIndex = new ListsCRDT({ actorId: "hydrate-index" });
    const hydrateResult = await hydrateFromStorage({
        storage,
        listsCrdt: newIndex,
        createListCrdt: (listId, state) =>
            new TaskListCRDT({ actorId: `hydrate-${listId}`, title: state?.title }),
    });

    const lists = newIndex.getVisibleLists();
    assert.equal(lists.length, 2);
    assert.deepEqual(
        lists.map((entry) => entry.id).sort(),
        ["alpha", "beta"],
    );

    const alpha = hydrateResult.lists.get("alpha");
    assert.ok(alpha);
    const alphaSnapshot = alpha.crdt.getSnapshot();
    assert.equal(alphaSnapshot.length, 2);
    assert.equal(alphaSnapshot[0].text.length > 0, true);
    assert.equal(typeof alphaSnapshot[0].done, "boolean");

    assert.ok(Array.isArray(hydrateResult.registryOperations));
});
