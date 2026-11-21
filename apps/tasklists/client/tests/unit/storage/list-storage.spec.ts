import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createListStorage } from "../../../src/storage/list-storage.js";
import {
  REGISTRY_STATE_ID,
  serializeListState,
  serializeRegistryState,
} from "../../../src/storage/serde.js";
import { TaskListCRDT } from "../../../src/domain/crdt/task-list-crdt.js";
import { ListsCRDT } from "../../../src/domain/crdt/lists-crdt.js";
import { hydrateFromStorage } from "../../../src/storage/hydrator.js";

let databases = 0;

async function open() {
  const dbName = `list-storage-${databases++}`;
  const storage = await createListStorage({ dbName, requestPersistence: false });
  return { dbName, storage };
}

function storeNames(dbName: string) {
  return new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const names = Array.from(db.objectStoreNames).sort();
      db.close();
      resolve(names);
    };
  });
}

/**
 * Creates a database as version 2 of the schema (tasklists up to 1.9.2)
 * left it: states, the operations they already held, and sync data.
 */
function createVersion2Database(
  dbName: string,
  records: Record<string, Record<string, unknown>[]>
) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, 2);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("listStates", { keyPath: "listId" });
      db.createObjectStore("listOperations", {
        keyPath: ["listId", "clock", "actor"],
      }).createIndex("byList", "listId", { unique: false });
      db.createObjectStore("registryState", { keyPath: "id" });
      db.createObjectStore("registryOperations", { keyPath: ["clock", "actor"] });
      db.createObjectStore("syncState", { keyPath: "id" });
      db.createObjectStore("syncOutbox", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(Object.keys(records), "readwrite");
      Object.entries(records).forEach(([store, values]) => {
        values.forEach((value) => transaction.objectStore(store).put(value));
      });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

test("a saved list loads with its state", async () => {
  const { storage } = await open();
  const list = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });
  list.generateInsert({ itemId: "task-1", text: "Milk" });
  await storage.persistList("list-1", list.exportState());

  const loaded = await storage.loadList("list-1");
  assert.deepEqual(
    loaded.state?.entries.map((entry) => entry.id),
    ["task-1"]
  );
});

test("a new database has only the state and sync stores", async () => {
  const { dbName } = await open();
  assert.deepEqual(await storeNames(dbName), [
    "listStates",
    "registryState",
    "syncOutbox",
    "syncState",
  ]);
});

test("upgrading a version 2 database drops its operations and keeps its data", async () => {
  const dbName = `list-storage-${databases++}`;
  const registry = new ListsCRDT({ actorId: "actor-1" });
  const create = registry.generateCreate({ listId: "list-1", title: "Inbox" });
  const list = new TaskListCRDT({ actorId: "actor-1", title: "Inbox" });
  list.generateInsert({ itemId: "task-1", text: "Milk" });
  const remove = list.generateRemove("task-1");
  list.generateInsert({ itemId: "task-2", text: "Eggs" });
  const unsent = { clientOpId: "op-1", scope: "list", resourceId: "list-1" };
  await createVersion2Database(dbName, {
    listStates: [
      {
        listId: "list-1",
        state: serializeListState(list.exportState()),
        updatedAt: 1,
        version: 1,
      },
    ],
    listOperations: [
      {
        listId: "list-1",
        clock: remove.op.clock,
        actor: remove.op.actor,
        operation: { ...remove.op },
        createdAt: 1,
      },
    ],
    registryState: [
      {
        id: REGISTRY_STATE_ID,
        state: serializeRegistryState(registry.exportState()),
        updatedAt: 1,
        version: 1,
      },
    ],
    registryOperations: [
      {
        clock: create.op.clock,
        actor: create.op.actor,
        operation: { ...create.op },
        createdAt: 1,
      },
    ],
    syncState: [
      { id: "sync", clientId: "client-1", lastServerSeq: 7, datasetGenerationKey: "gen-1" },
    ],
    syncOutbox: [{ id: "outbox", ops: [unsent] }],
  });

  const storage = await createListStorage({ dbName, requestPersistence: false });

  assert.deepEqual(await storeNames(dbName), [
    "listStates",
    "registryState",
    "syncOutbox",
    "syncState",
  ]);
  const listsCrdt = new ListsCRDT({ actorId: "actor-2" });
  const hydrated = await hydrateFromStorage({
    storage,
    listsCrdt,
    createListCrdt: () => new TaskListCRDT({ actorId: "actor-2" }),
  });
  assert.deepEqual(
    listsCrdt.getVisibleLists().map((entry) => entry.id),
    ["list-1"]
  );
  assert.deepEqual(
    (hydrated.lists.get("list-1")?.crdt as TaskListCRDT)
      .getSnapshot()
      .map((entry) => entry.text),
    ["Eggs"]
  );
  assert.deepEqual(await storage.loadSyncState(), {
    clientId: "client-1",
    lastServerSeq: 7,
    datasetGenerationKey: "gen-1",
  });
  assert.deepEqual(await storage.loadOutbox(), [unsent]);
});
