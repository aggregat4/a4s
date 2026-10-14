import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createListStorage } from "../../../src/storage/list-storage.js";
import { serializeOperation } from "../../../src/storage/serde.js";
import { TaskListCRDT } from "../../../src/domain/crdt/task-list-crdt.js";
import { ListsCRDT } from "../../../src/domain/crdt/lists-crdt.js";
import { hydrateFromStorage } from "../../../src/storage/hydrator.js";

let databases = 0;

async function open() {
  const dbName = `list-storage-${databases++}`;
  const storage = await createListStorage({ dbName, requestPersistence: false });
  return { dbName, storage };
}

/** Writes an operation as an older version stored it, next to the state. */
function storeOldOperation(dbName: string, store: string, record: Record<string, unknown>) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).put(record);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

test("a saved list keeps its state and no operations", async () => {
  const { storage } = await open();
  const list = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });
  list.generateInsert({ itemId: "task-1", text: "Milk" });
  await storage.persistList("list-1", list.exportState());

  const loaded = await storage.loadList("list-1");
  assert.deepEqual(loaded.operations, []);
  assert.deepEqual(
    loaded.state?.entries.map((entry) => entry.id),
    ["task-1"]
  );
});

test("operations an older version stored load, until the list is saved again", async () => {
  const { dbName, storage } = await open();
  const list = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });
  const insert = list.generateInsert({ itemId: "task-1", text: "Milk" });
  await storage.persistList("list-1", list.exportState());
  const operation = serializeOperation(insert.op)!;
  await storeOldOperation(dbName, "listOperations", {
    listId: "list-1",
    clock: operation.clock,
    actor: operation.actor,
    operation,
    createdAt: 0,
  });
  assert.equal((await storage.loadList("list-1")).operations.length, 1);

  await storage.persistList("list-1", list.exportState());
  assert.deepEqual((await storage.loadList("list-1")).operations, []);
});

test("registry operations an older version stored load, until it is saved again", async () => {
  const { dbName, storage } = await open();
  const registry = new ListsCRDT({ actorId: "actor-1" });
  const create = registry.generateCreate({ listId: "list-1", title: "Inbox" });
  await storage.persistRegistry(registry.exportState());
  const operation = serializeOperation(create.op)!;
  await storeOldOperation(dbName, "registryOperations", {
    clock: operation.clock,
    actor: operation.actor,
    operation,
    createdAt: 0,
  });
  assert.equal((await storage.loadRegistry()).operations.length, 1);

  await storage.persistRegistry(registry.exportState());
  assert.deepEqual((await storage.loadRegistry()).operations, []);
});

test("a list an older version saved loads as it was", async () => {
  const { dbName, storage } = await open();
  const registry = new ListsCRDT({ actorId: "actor-1" });
  registry.generateCreate({ listId: "list-1", title: "Inbox" });
  await storage.persistRegistry(registry.exportState());
  const list = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });
  list.generateInsert({ itemId: "task-1", text: "Milk" });
  const removed = list.generateRemove("task-1");
  list.generateInsert({ itemId: "task-2", text: "Eggs" });
  await storage.persistList("list-1", list.exportState());
  // An older version kept the last change's operations next to the state
  // that already holds them.
  const operation = serializeOperation(removed.op)!;
  await storeOldOperation(dbName, "listOperations", {
    listId: "list-1",
    clock: operation.clock,
    actor: operation.actor,
    operation,
    createdAt: 0,
  });

  const hydrated = await hydrateFromStorage({
    storage,
    listsCrdt: new ListsCRDT({ actorId: "actor-2" }),
    createListCrdt: () => new TaskListCRDT({ actorId: "actor-2" }),
  });
  assert.deepEqual(
    (hydrated.lists.get("list-1")?.crdt as TaskListCRDT).getSnapshot().map((entry) => entry.text),
    ["Eggs"]
  );
});
