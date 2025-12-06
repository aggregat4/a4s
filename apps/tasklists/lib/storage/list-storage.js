import {
  SERIALIZATION_VERSION,
  REGISTRY_STATE_ID,
  serializeListState,
  deserializeListState,
  serializeRegistryState,
  deserializeRegistryState,
  serializeOperation,
  deserializeOperation,
} from "./serde.js";

const DB_NAME = "protoLists";
export const DEFAULT_DB_NAME = DB_NAME;
const DB_VERSION = 1;

const STORE_LIST_STATES = "listStates";
const STORE_LIST_OPERATIONS = "listOperations";
const STORE_REGISTRY_STATE = "registryState";
const STORE_REGISTRY_OPERATIONS = "registryOperations";

const toOperationKey = (op) =>
  [
    op.type ?? "",
    op.actor ?? "",
    op.clock ?? 0,
    op.itemId ?? "",
    op.listId ?? "",
  ].join("|");

const sortOperations = (operations) =>
  operations.sort((a, b) => {
    if (a.clock !== b.clock) return a.clock - b.clock;
    if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
    if ((a.listId ?? "") !== (b.listId ?? "")) {
      return (a.listId ?? "") < (b.listId ?? "") ? -1 : 1;
    }
    if ((a.itemId ?? "") !== (b.itemId ?? "")) {
      return (a.itemId ?? "") < (b.itemId ?? "") ? -1 : 1;
    }
    if ((a.type ?? "") !== (b.type ?? "")) {
      return (a.type ?? "") < (b.type ?? "") ? -1 : 1;
    }
    return 0;
  });

async function requestPersistentStorage() {
  const storageManager = globalThis.navigator?.storage;
  if (!storageManager || typeof storageManager.persist !== "function") {
    throw new Error(
      "navigator.storage.persist is required; provide a navigator.storage shim when running outside the browser."
    );
  }
  try {
    return Boolean(await storageManager.persist());
  } catch (err) {
    return false;
  }
}

function openDatabase(options = {}) {
  const name =
    typeof options.dbName === "string" && options.dbName.length
      ? options.dbName
      : DB_NAME;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_LIST_STATES)) {
        db.createObjectStore(STORE_LIST_STATES, { keyPath: "listId" });
      }
      if (!db.objectStoreNames.contains(STORE_LIST_OPERATIONS)) {
        const store = db.createObjectStore(STORE_LIST_OPERATIONS, {
          keyPath: ["listId", "clock", "actor"],
        });
        store.createIndex("byList", "listId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_REGISTRY_STATE)) {
        db.createObjectStore(STORE_REGISTRY_STATE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_REGISTRY_OPERATIONS)) {
        db.createObjectStore(STORE_REGISTRY_OPERATIONS, {
          keyPath: ["clock", "actor"],
        });
      }
    };
    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
  });
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompleted(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error);
  });
}

function iterateCursor(request, handler) {
  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve();
        return;
      }
      const shouldContinue = handler(cursor);
      if (shouldContinue === false) {
        resolve();
        return;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

class IndexedDbListStorage {
  constructor(options = {}) {
    this.dbPromise = openDatabase(options);
  }

  async ready() {
    return this.dbPromise;
  }

  async loadAllLists() {
    const db = await this.ready();
    const transaction = db.transaction(
      [STORE_LIST_STATES, STORE_LIST_OPERATIONS],
      "readonly"
    );
    const completion = transactionCompleted(transaction);
    const stateStore = transaction.objectStore(STORE_LIST_STATES);
    const operationsStore = transaction.objectStore(STORE_LIST_OPERATIONS);
    const [stateRecords, operationRecords] = await Promise.all([
      promisifyRequest(stateStore.getAll()),
      promisifyRequest(operationsStore.getAll()),
    ]);
    await completion;

    const operationsByList = new Map();
    (operationRecords || []).forEach((record) => {
      const listId = record.listId;
      if (!operationsByList.has(listId)) {
        operationsByList.set(listId, []);
      }
      const op = deserializeOperation(record.operation);
      if (op) {
        operationsByList.get(listId).push(op);
      }
    });

    const response = [];
    (stateRecords || []).forEach((record) => {
      const listId = record.listId;
      const decodedState = deserializeListState(record.state);
      const operations = sortOperations(operationsByList.get(listId) || []);
      operationsByList.delete(listId);
      response.push({
        listId,
        state: decodedState,
        operations,
        updatedAt: record.updatedAt ?? null,
      });
    });

    operationsByList.forEach((operations, listId) => {
      response.push({
        listId,
        state: null,
        operations: sortOperations(operations),
        updatedAt: null,
      });
    });

    return response;
  }

  async loadList(listId) {
    if (typeof listId !== "string" || !listId.length) {
      return { listId, state: null, operations: [] };
    }
    const db = await this.ready();
    const transaction = db.transaction(
      [STORE_LIST_STATES, STORE_LIST_OPERATIONS],
      "readonly"
    );
    const completion = transactionCompleted(transaction);
    const stateStore = transaction.objectStore(STORE_LIST_STATES);
    const operationsStore = transaction.objectStore(STORE_LIST_OPERATIONS);
    const stateRequest = stateStore.get(listId);
    const opsIndex = operationsStore.index("byList");
    const opsRequest = opsIndex.getAll(listId);
    const [stateRecord, opRecords] = await Promise.all([
      promisifyRequest(stateRequest),
      promisifyRequest(opsRequest),
    ]);
    await completion;

    return {
      listId,
      state: stateRecord ? deserializeListState(stateRecord.state) : null,
      operations: sortOperations(
        (opRecords || [])
          .map((record) => deserializeOperation(record.operation))
          .filter(Boolean)
      ),
      updatedAt: stateRecord?.updatedAt ?? null,
    };
  }

  async persistOperations(listId, operations = [], options = {}) {
    if (typeof listId !== "string" || !listId.length) {
      throw new Error("persistOperations requires a listId");
    }
    const db = await this.ready();
    const stores = [STORE_LIST_OPERATIONS];
    if (options.snapshot) {
      stores.push(STORE_LIST_STATES);
    }
    const transaction = db.transaction(stores, "readwrite");
    const completion = transactionCompleted(transaction);
    const operationsStore = transaction.objectStore(STORE_LIST_OPERATIONS);
    const snapshotStore = options.snapshot
      ? transaction.objectStore(STORE_LIST_STATES)
      : null;
    const now = Date.now();

    if (snapshotStore && options.snapshot) {
      const index = operationsStore.index("byList");
      const cursorRequest = index.openCursor(listId);
      await iterateCursor(cursorRequest, (cursor) => {
        cursor.delete();
      });
    }

    if (Array.isArray(operations)) {
      operations.forEach((operation) => {
        const serialized = serializeOperation(operation);
        if (!serialized) return;
        operationsStore.put({
          listId,
          clock: serialized.clock,
          actor: serialized.actor,
          operation: serialized,
          createdAt: now,
        });
      });
    }

    if (snapshotStore && options.snapshot) {
      snapshotStore.put({
        listId,
        state: serializeListState(options.snapshot),
        updatedAt: now,
        version: SERIALIZATION_VERSION,
      });
    }

    await completion;
  }

  async pruneOperations(listId, beforeClock) {
    if (!Number.isFinite(beforeClock)) return;
    const db = await this.ready();
    const transaction = db.transaction(STORE_LIST_OPERATIONS, "readwrite");
    const completion = transactionCompleted(transaction);
    const operationsStore = transaction.objectStore(STORE_LIST_OPERATIONS);
    const index = operationsStore.index("byList");
    const cursorRequest = index.openCursor(listId);
    await iterateCursor(cursorRequest, (cursor) => {
      const record = cursor.value;
      if (record.clock <= beforeClock) {
        cursor.delete();
      }
    });
    await completion;
  }

  async loadRegistry() {
    const db = await this.ready();
    const transaction = db.transaction(
      [STORE_REGISTRY_STATE, STORE_REGISTRY_OPERATIONS],
      "readonly"
    );
    const completion = transactionCompleted(transaction);
    const stateStore = transaction.objectStore(STORE_REGISTRY_STATE);
    const operationsStore = transaction.objectStore(STORE_REGISTRY_OPERATIONS);
    const stateRequest = stateStore.get(REGISTRY_STATE_ID);
    const opsRequest = operationsStore.getAll();
    const [stateRecord, opRecords] = await Promise.all([
      promisifyRequest(stateRequest),
      promisifyRequest(opsRequest),
    ]);
    await completion;
    return {
      state: stateRecord ? deserializeRegistryState(stateRecord.state) : null,
      operations: sortOperations(
        (opRecords || [])
          .map((record) => deserializeOperation(record.operation))
          .filter(Boolean)
      ),
      updatedAt: stateRecord?.updatedAt ?? null,
    };
  }

  async persistRegistry({ operations = [], snapshot = null } = {}) {
    const db = await this.ready();
    const stores = [STORE_REGISTRY_OPERATIONS];
    if (snapshot) {
      stores.push(STORE_REGISTRY_STATE);
    }
    const transaction = db.transaction(stores, "readwrite");
    const completion = transactionCompleted(transaction);
    const operationsStore = transaction.objectStore(STORE_REGISTRY_OPERATIONS);
    const snapshotStore = snapshot
      ? transaction.objectStore(STORE_REGISTRY_STATE)
      : null;
    const now = Date.now();

    if (snapshotStore && snapshot) {
      operationsStore.clear();
    }

    if (Array.isArray(operations)) {
      operations.forEach((operation) => {
        const serialized = serializeOperation(operation);
        if (!serialized) return;
        operationsStore.put({
          clock: serialized.clock,
          actor: serialized.actor,
          operation: serialized,
          createdAt: now,
        });
      });
    }

    if (snapshotStore && snapshot) {
      snapshotStore.put({
        id: REGISTRY_STATE_ID,
        state: serializeRegistryState(snapshot),
        updatedAt: now,
        version: SERIALIZATION_VERSION,
      });
    }

    await completion;
  }

  async pruneRegistryOperations(beforeClock) {
    if (!Number.isFinite(beforeClock)) return;
    const db = await this.ready();
    const transaction = db.transaction(STORE_REGISTRY_OPERATIONS, "readwrite");
    const completion = transactionCompleted(transaction);
    const operationsStore = transaction.objectStore(STORE_REGISTRY_OPERATIONS);
    const cursorRequest = operationsStore.openCursor();
    await iterateCursor(cursorRequest, (cursor) => {
      const record = cursor.value;
      if (record.clock <= beforeClock) {
        cursor.delete();
      }
    });
    await completion;
  }

  async clear() {
    const db = await this.ready();
    const transaction = db.transaction(
      [
        STORE_LIST_STATES,
        STORE_LIST_OPERATIONS,
        STORE_REGISTRY_STATE,
        STORE_REGISTRY_OPERATIONS,
      ],
      "readwrite"
    );
    const completion = transactionCompleted(transaction);
    transaction.objectStore(STORE_LIST_STATES).clear();
    transaction.objectStore(STORE_LIST_OPERATIONS).clear();
    transaction.objectStore(STORE_REGISTRY_STATE).clear();
    transaction.objectStore(STORE_REGISTRY_OPERATIONS).clear();
    await completion;
  }
}

export async function createListStorage(options = {}) {
  const storage = new IndexedDbListStorage(options);
  await storage.ready();
  if (options.requestPersistence !== false) {
    requestPersistentStorage().catch(() => {});
  }
  return storage;
}
