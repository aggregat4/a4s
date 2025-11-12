import test from "node:test";
import assert from "node:assert/strict";
import { hydrateFromStorage } from "../../../lib/storage/hydrator.js";
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

test("hydrateFromStorage rebuilds CRDT instances from persisted registry and lists", async () => {
    const storage = new MemoryListStorage();
    await storage.clear();

    const listsCrdt = new ListsCRDT({ actorId: "seed-index" });
    const seedConfigs = [
        {
            id: "alpha",
            title: "Alpha",
            items: [
                { id: "alpha-1", text: "One", done: false },
                { id: "alpha-2", text: "Two", done: true },
            ],
        },
        { id: "beta", title: "Beta", items: [] },
    ];

    let previousId = null;
    for (const config of seedConfigs) {
        const createResult = listsCrdt.generateCreate({
            listId: config.id,
            title: config.title,
            afterId: previousId,
        });
        previousId = config.id;

        const listCrdt = new TaskListCRDT({
            actorId: `seed-${config.id}`,
            title: config.title,
        });
        const ops = [];
        const rename = listCrdt.generateRename(config.title);
        ops.push(rename.op);
        let afterId = null;
        config.items.forEach((item) => {
            const insert = listCrdt.generateInsert({
                itemId: item.id,
                text: item.text,
                done: item.done,
                afterId,
            });
            ops.push(insert.op);
            afterId = item.id;
        });
        await storage.persistOperations(config.id, ops, {
            snapshot: listCrdt.exportState(),
        });
        await storage.persistRegistry({
            operations: [createResult.op],
            snapshot: listsCrdt.exportState(),
        });
    }

    const hydrationIndex = new ListsCRDT({ actorId: "hydrate-index" });
    const hydrateResult = await hydrateFromStorage({
        storage,
        listsCrdt: hydrationIndex,
        createListCrdt: (listId, state) =>
            new TaskListCRDT({ actorId: `hydrate-${listId}`, title: state?.title }),
    });

    const lists = hydrationIndex.getVisibleLists();
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
