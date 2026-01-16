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
  persistOperations: async () => {},
  persistRegistry: async () => {},
});

test("undo/redo restores list creation", async () => {
  const repository = new ListRepository({
    storageFactory: async () => createMemoryStorage(),
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
  });

  await repository.createList({ listId: "list-1", title: "Tasks" });
  await repository.insertTask("list-1", {
    itemId: "item-1",
    text: "First",
    done: false,
  });

  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    await repository.updateTask("list-1", "item-1", { text: "Second" });
    now += 200;
    await repository.updateTask("list-1", "item-1", { text: "Third" });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(repository.getListState("list-1").items[0].text, "Third");
  await repository.undo();
  assert.equal(repository.getListState("list-1").items[0].text, "First");
  await repository.redo();
  assert.equal(repository.getListState("list-1").items[0].text, "Third");
});
