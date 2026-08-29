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

const createMemoryStorage = (
  seedState: SyncState = {
    clientId: "client-1",
    lastServerSeq: 4,
    datasetGenerationKey: "dataset-old",
  }
): ListStorage => {
  let syncState: SyncState = { ...seedState };
  let outbox: SyncOp[] = [];
  return {
    ready: async () => {},
    clear: async () => {
      syncState = { clientId: "", lastServerSeq: 0, datasetGenerationKey: "" };
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

test("replaceWithSnapshot preserves dataset generation key in sync state", async () => {
  const storage = createMemoryStorage();
  const repository = new ListRepository({
    storageFactory: async () => storage,
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.replaceWithSnapshot({
    registryState: { clock: 0, entries: [] },
    lists: [],
    publishSnapshot: false,
  });

  const state = await storage.loadSyncState();
  assert.equal(state.clientId, "client-1");
  assert.equal(state.lastServerSeq, 0);
  assert.equal(state.datasetGenerationKey, "dataset-old");
});
