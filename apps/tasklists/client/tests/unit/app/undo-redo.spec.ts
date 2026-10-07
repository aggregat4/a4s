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
  loadSyncState: async () => ({
    clientId: "",
    lastServerSeq: 0,
    datasetGenerationKey: "",
  }),
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

test("subscribeHistory reports when undo and redo become available", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });
  await repository.initialize();
  const states: Array<{ canUndo: boolean; canRedo: boolean }> = [];
  const unsubscribe = repository.subscribeHistory((state) => states.push(state));
  assert.deepEqual(states, [{ canUndo: false, canRedo: false }]);

  await repository.createList({ listId: "list-1", title: "List One" });
  assert.deepEqual(states[states.length - 1], { canUndo: true, canRedo: false });

  await repository.undo();
  assert.deepEqual(states[states.length - 1], { canUndo: false, canRedo: true });

  await repository.redo();
  assert.deepEqual(states[states.length - 1], { canUndo: true, canRedo: false });

  const count = states.length;
  unsubscribe();
  await repository.undo();
  assert.equal(states.length, count);
});

// Storage whose saves take a while, as on a slow device.
const createSlowStorage = (delayMs: number): ListStorage => {
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return {
    ...createMemoryStorage(),
    persistOperations: async () => wait(),
    persistRegistry: async () => wait(),
  };
};

const createSlowRepository = () =>
  new ListRepository({
    storageFactory: async () => createSlowStorage(20),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });

test("undo requested while a change is still saving undoes that change", async () => {
  const repository = createSlowRepository();
  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", { itemId: "a", text: "A" });
  await repository.insertTask("list-1", { itemId: "b", text: "B" });

  // Not awaited: the undo is requested while the toggle is still saving.
  const toggle = repository.toggleTask("list-1", "b", true);
  const undo = repository.undo();
  await Promise.all([toggle, undo]);

  const items = repository.getListState("list-1").items;
  assert.deepEqual(
    items.map((item) => [item.id, item.done]),
    [
      ["a", false],
      ["b", false],
    ]
  );
});

test("changes requested while others are saving apply in request order", async () => {
  const repository = createSlowRepository();
  await repository.createList({ listId: "list-1", title: "Tasks" });
  const insert = repository.insertTask("list-1", { itemId: "a", text: "" });
  const typing = ["S", "Sp", "Split", "SplitMe"].map((text) =>
    repository.updateTask("list-1", "a", { text })
  );
  const split = repository.splitTask("list-1", "a", {
    beforeText: "Split",
    afterText: "Me",
    previousText: "SplitMe",
    newItemId: "b",
    afterId: "a",
  });
  const remove = repository.removeTask("list-1", "b");
  await Promise.all([insert, ...typing, split, remove]);

  assert.deepEqual(
    repository.getListState("list-1").items.map((item) => item.text),
    ["Split"]
  );
  await repository.undo();
  assert.deepEqual(
    repository.getListState("list-1").items.map((item) => item.text),
    ["Split", "Me"]
  );
});

test("undoing a delete restores the task's note", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });
  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", { itemId: "a", text: "Call Ada" });
  await repository.updateTask("list-1", "a", { note: "Number is on the card" });
  await repository.removeTask("list-1", "a");

  await repository.undo();

  const [task] = repository.getListState("list-1").items;
  assert.equal(task?.text, "Call Ada");
  assert.equal(task?.note, "Number is on the card");
});

test("undo keeps working after undoing the deletion of a list", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
    listsCrdtOptions: { identityOptions: { storage: createMockStorage() } },
  });
  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", { itemId: "a", text: "A" });
  await repository.insertTask("list-1", { itemId: "b", text: "B", beforeId: "a" });
  await repository.moveTaskWithinList("list-1", "a", { beforeId: "b" });
  await repository.removeList("list-1");

  await repository.undo(); // restores the list
  assert.deepEqual(repository.getListState("list-1").items.map((i) => i.id), ["a", "b"]);
  await repository.undo(); // reverts the move
  assert.deepEqual(repository.getListState("list-1").items.map((i) => i.id), ["b", "a"]);
});
