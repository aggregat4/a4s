import test from "node:test";
import assert from "node:assert/strict";
import { ListRepository } from "../../../src/app/list-repository.js";
import type { ListStorage } from "../../../src/types/storage.js";
import type { SyncOp, SyncState } from "../../../src/types/sync.js";

const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
  };
};

const createMemoryStorage = (): ListStorage => {
  let syncState: SyncState = {
    clientId: "client-1",
    lastServerSeq: 0,
    datasetGenerationKey: "",
  };
  let outbox: SyncOp[] = [];
  return {
    ready: async () => {},
    clear: async () => {
      syncState = { clientId: "client-1", lastServerSeq: 0, datasetGenerationKey: "" };
      outbox = [];
    },
    loadAllLists: async () => [],
    loadList: async (listId) => ({
      listId,
      state: null,
      operations: [],
      updatedAt: null,
    }),
    loadRegistry: async () => ({
      state: null,
      operations: [],
      updatedAt: null,
    }),
    loadSyncState: async () => ({ ...syncState }),
    persistSyncState: async (state) => {
      syncState = { ...state };
    },
    loadOutbox: async () => outbox.map((op) => ({ ...op })),
    persistOutbox: async (ops) => {
      outbox = Array.isArray(ops) ? ops.map((op) => ({ ...op })) : [];
    },
    persistOperations: async () => {},
    persistRegistry: async () => {},
  };
};

test("queues registry ops into outbox when sync is disabled", async () => {
  const storage = createMemoryStorage();
  const repository = new ListRepository({
    storageFactory: async () => storage,
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-1", title: "Inbox" });

  const outbox = await storage.loadOutbox();
  assert.equal(outbox.some((op) => op.scope === "registry"), true);
});

test("queues list ops into outbox when sync is disabled", async () => {
  const storage = createMemoryStorage();
  const repository = new ListRepository({
    storageFactory: async () => storage,
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-1", title: "Inbox" });
  await storage.persistOutbox([]);

  await repository.insertTask("list-1", {
    itemId: "task-1",
    text: "Hello",
    done: false,
  });

  const outbox = await storage.loadOutbox();
  assert.equal(outbox.some((op) => op.scope === "list"), true);
});

test("a completed edit has a durable outbox entry before a client restart", async () => {
  const storage = createMemoryStorage();
  const repository = new ListRepository({
    storageFactory: async () => storage,
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });
  await repository.createList({ listId: "list-1", title: "Inbox" });
  await repository.insertTask("list-1", { itemId: "task-1", text: "Offline" });
  repository.dispose();

  const queued = await storage.loadOutbox();
  assert.deepEqual(queued.map(({ scope, payload }) => [scope, payload.type]), [
    ["registry", "createList"],
    ["list", "renameList"],
    ["list", "insert"],
  ]);
});
