import test from "node:test";
import assert from "node:assert/strict";
import { ListRepository } from "../../../src/app/list-repository.js";
import type { ListStorage } from "../../../src/types/storage.js";

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

const createMemoryStorage = (): ListStorage => ({
  ready: async () => {},
  clear: async () => {},
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
  loadSyncState: async () => ({
    clientId: "client-1",
    lastServerSeq: 0,
    datasetGenerationKey: "",
  }),
  persistSyncState: async () => {},
  loadOutbox: async () => [],
  persistOutbox: async () => {},
  persistOperations: async () => {},
  persistRegistry: async () => {},
});

const createRepository = () =>
  new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

const listIds = (repository: ListRepository) =>
  repository.getRegistrySnapshot().map((entry) => entry.id);

test("createList appends after the last list when no neighbors are given", async () => {
  const repository = createRepository();

  await repository.createList({ listId: "list-1", title: "One" });
  await repository.createList({
    listId: "list-2",
    title: "Two",
    afterId: "list-1",
  });
  await repository.createList({ listId: "list-3", title: "Three" });

  assert.deepEqual(listIds(repository), ["list-1", "list-2", "list-3"]);
});

test("createList honors explicit neighbors and positions", async () => {
  const repository = createRepository();

  await repository.createList({ listId: "list-1", title: "One" });
  await repository.createList({
    listId: "list-2",
    title: "Two",
    afterId: "list-1",
  });
  await repository.createList({
    listId: "list-3",
    title: "Three",
    afterId: "list-1",
    beforeId: "list-2",
  });

  assert.deepEqual(listIds(repository), ["list-1", "list-3", "list-2"]);
});
