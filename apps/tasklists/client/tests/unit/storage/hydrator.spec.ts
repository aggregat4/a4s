import test from "node:test";
import assert from "node:assert/strict";
import { hydrateFromStorage } from "../../../src/storage/hydrator.js";
import { ListsCRDT } from "../../../src/domain/crdt/lists-crdt.js";
import { TaskListCRDT } from "../../../src/domain/crdt/task-list-crdt.js";

const clone = (value: any) =>
    value == null ? value : JSON.parse(JSON.stringify(value));

class MemoryListStorage {
    lists: Map<string, any>;
    registry: any;
    syncState: any;
    outbox: any[];

    constructor() {
        this.lists = new Map();
        this.registry = { state: null, operations: [], updatedAt: null };
        this.syncState = { clientId: "", lastServerSeq: 0 };
        this.outbox = [];
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
            operations: record.operations.map((op: any) => clone(op)),
            updatedAt: record.updatedAt,
        }));
    }

    async loadRegistry() {
        return {
            state: clone(this.registry.state),
            operations: this.registry.operations.map((op: any) => clone(op)),
            updatedAt: this.registry.updatedAt,
        };
    }

    async loadSyncState() {
        return clone(this.syncState);
    }

    async persistSyncState(state: any) {
        this.syncState = clone(state);
    }

    async loadOutbox() {
        return this.outbox.map((op) => clone(op));
    }

    async persistOutbox(ops: any[] = []) {
        this.outbox = Array.isArray(ops) ? ops.map((op) => clone(op)) : [];
    }

    async persistList(listId: string, state: any) {
        if (typeof listId !== "string" || !listId.length) {
            throw new Error("persistList requires a listId");
        }
        this.lists.set(listId, { state: clone(state), operations: [], updatedAt: Date.now() });
    }

    async persistRegistry(state: any) {
        this.registry.state = clone(state);
        this.registry.operations = [];
        this.registry.updatedAt = Date.now();
    }

    async loadList(listId: string) {
        const record = this.lists.get(listId);
        if (!record) {
            return { listId, state: null, operations: [], updatedAt: null };
        }
        return {
            listId,
            state: clone(record.state),
            operations: record.operations.map((op: any) => clone(op)),
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
        listsCrdt.generateCreate({
            listId: config.id,
            title: config.title,
            afterId: previousId,
        });
        previousId = config.id;

        const listCrdt = new TaskListCRDT({
            actorId: `seed-${config.id}`,
            title: config.title,
        });
        listCrdt.generateRename(config.title);
        let afterId: string | null = null;
        config.items.forEach((item) => {
            listCrdt.generateInsert({
                itemId: item.id,
                text: item.text,
                done: item.done,
                afterId,
            });
            afterId = item.id;
        });
        await storage.persistList(config.id, listCrdt.exportState());
        await storage.persistRegistry(listsCrdt.exportState());
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
    const alphaSnapshot = (alpha.crdt as TaskListCRDT).getSnapshot();
    assert.equal(alphaSnapshot.length, 2);
    assert.equal(alphaSnapshot[0].text.length > 0, true);
    assert.equal(typeof alphaSnapshot[0].done, "boolean");

    assert.ok(Array.isArray(hydrateResult.registryOperations));
});
