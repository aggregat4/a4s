import test from "node:test";
import assert from "node:assert/strict";
import { ListRepository } from "../../../src/app/list-repository.js";
import type { ListStorage } from "../../../src/types/storage.js";

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
  loadSyncState: async () => ({ clientId: "", lastServerSeq: 0 }),
  persistSyncState: async () => {},
  loadOutbox: async () => [],
  persistOutbox: async () => {},
  persistOperations: async () => {},
  persistRegistry: async () => {},
});

const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
  };
};

test("undo/redo restores list creation", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-1", title: "List One" });
  assert.equal(repository.getRegistrySnapshot().length, 1);

  const undone = await repository.undo();
  assert.equal(undone, true);
  assert.equal(repository.getRegistrySnapshot().length, 0);

  const redone = await repository.redo();
  assert.equal(redone, true);
  assert.equal(repository.getRegistrySnapshot().length, 1);
});

test("undo/redo coalesces text edits into a single entry", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", {
    itemId: "item-1",
    text: "Hello",
    done: false,
  });

  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    await repository.updateTask("list-1", "item-1", { text: "Helloa" });
    now += 200;
    await repository.updateTask("list-1", "item-1", { text: "Helloab" });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(repository.getListState("list-1").items[0].text, "Helloab");
  await repository.undo();
  assert.equal(repository.getListState("list-1").items[0].text, "Hello");
  await repository.redo();
  assert.equal(repository.getListState("list-1").items[0].text, "Helloab");
});

test("text edits split into multiple undo segments on boundaries", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", {
    itemId: "item-1",
    text: "",
    done: false,
  });

  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    await repository.updateTask("list-1", "item-1", { text: "Hello" });
    now += 200;
    await repository.updateTask("list-1", "item-1", { text: "Hello world" });
  } finally {
    Date.now = originalNow;
  }

  await repository.undo();
  assert.equal(repository.getListState("list-1").items[0].text, "Hello");
  await repository.undo();
  assert.equal(repository.getListState("list-1").items[0].text, "");
});

test("undo/redo restores cross-list task moves", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-a", title: "List A" });
  await repository.createList({ listId: "list-b", title: "List B" });
  await repository.insertTask("list-a", {
    itemId: "task-1",
    text: "Move me",
    done: false,
  });

  await repository.moveTask("list-a", "list-b", "task-1");
  assert.equal(repository.getListState("list-a").items.length, 0);
  assert.equal(repository.getListState("list-b").items.length, 1);

  await repository.undo();
  assert.equal(repository.getListState("list-a").items.length, 1);
  assert.equal(repository.getListState("list-b").items.length, 0);

  await repository.redo();
  assert.equal(repository.getListState("list-a").items.length, 0);
  assert.equal(repository.getListState("list-b").items.length, 1);
});

test("undo/redo restores list registry operations", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-a", title: "First" });
  await repository.createList({ listId: "list-b", title: "Second" });
  await repository.renameList("list-a", "Renamed");
  await repository.reorderList("list-b", { beforeId: "list-a" });

  const orderAfter = repository.getRegistrySnapshot().map((entry) => entry.id);
  assert.deepEqual(orderAfter, ["list-b", "list-a"]);

  await repository.undo();
  await repository.undo();

  const orderBefore = repository.getRegistrySnapshot().map((entry) => entry.id);
  assert.deepEqual(orderBefore, ["list-a", "list-b"]);

  const titleBefore = repository.getRegistrySnapshot().find(
    (entry) => entry.id === "list-a"
  )?.title;
  assert.equal(titleBefore, "First");

  await repository.redo();
  await repository.redo();

  const orderRedo = repository.getRegistrySnapshot().map((entry) => entry.id);
  assert.deepEqual(orderRedo, ["list-b", "list-a"]);
  const titleRedo = repository.getRegistrySnapshot().find(
    (entry) => entry.id === "list-a"
  )?.title;
  assert.equal(titleRedo, "Renamed");
});

test("undo merges a task split into one history entry", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", {
    itemId: "item-1",
    text: "Alpha",
    done: false,
  });
  await repository.insertTask("list-1", {
    itemId: "item-2",
    text: "Beta",
    done: false,
    afterId: "item-1",
  });

  await repository.mergeTask("list-1", "item-1", "item-2", {
    mergedText: "AlphaBeta",
  });
  assert.equal(repository.getListState("list-1").items.length, 1);
  assert.equal(repository.getListState("list-1").items[0].text, "AlphaBeta");

  const undone = await repository.undo();
  assert.equal(undone, true);
  const stateAfter = repository.getListState("list-1");
  assert.equal(stateAfter.items.length, 2);
  assert.equal(stateAfter.items[0].text, "Alpha");
  assert.equal(stateAfter.items[1].text, "Beta");
});
