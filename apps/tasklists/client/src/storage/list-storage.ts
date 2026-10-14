import {
  SERIALIZATION_VERSION,
  REGISTRY_STATE_ID,
  serializeListState,
  deserializeListState,
  serializeRegistryState,
  deserializeRegistryState,
  deserializeOperation,
} from "./serde.js";
import type { ListId, ListState, RegistryState } from "../types/domain.js";
import type { ListsOperation, TaskListOperation } from "../types/crdt.js";
import type { SyncOp, SyncState } from "../types/sync.js";
import type {
  ListStorage,
  PersistedListRecord,
  PersistedRegistryRecord,
} from "../types/storage.js";

const DB_NAME = "protoLists";
export const DEFAULT_DB_NAME = DB_NAME;
const DB_VERSION = 2;

const STORE_LIST_STATES = "listStates";
const STORE_LIST_OPERATIONS = "listOperations";
const STORE_REGISTRY_STATE = "registryState";
const STORE_REGISTRY_OPERATIONS = "registryOperations";
const STORE_SYNC_STATE = "syncState";
const STORE_SYNC_OUTBOX = "syncOutbox";

const SYNC_STATE_ID = "sync";
const OUTBOX_ID = "outbox";

type StorageOptions = {
  dbName?: string;
  requestPersistence?: boolean;
};

const TASK_OPERATION_TYPES = new Set([
  "insert",
  "remove",
  "move",
  "update",
  "renameList",
]);
const REGISTRY_OPERATION_TYPES = new Set([
  "createList",
  "removeList",
  "reorderList",
  "renameList",
]);

const isTaskListOperation = (
  operation: TaskListOperation | ListsOperation | null
): operation is TaskListOperation =>
  Boolean(operation && TASK_OPERATION_TYPES.has(operation.type));

const isRegistryOperation = (
  operation: TaskListOperation | ListsOperation | null
): operation is ListsOperation =>
  Boolean(operation && REGISTRY_OPERATION_TYPES.has(operation.type));

const sortOperations = <T extends TaskListOperation | ListsOperation>(
  operations: T[]
) =>
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

function openDatabase(options: StorageOptions = {}) {
  const name =
    typeof options.dbName === "string" && options.dbName.length
      ? options.dbName
      : DB_NAME;
  return new Promise<IDBDatabase>((resolve, reject) => {
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
      if (!db.objectStoreNames.contains(STORE_SYNC_STATE)) {
        db.createObjectStore(STORE_SYNC_STATE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_OUTBOX)) {
        db.createObjectStore(STORE_SYNC_OUTBOX, { keyPath: "id" });
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

function promisifyRequest<T = unknown>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompleted(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error);
  });
}

function iterateCursor(
  request: IDBRequest,
  handler: (cursor: IDBCursorWithValue) => boolean | void
) {
  return new Promise<void>((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest)?.result as IDBCursorWithValue;
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

class IndexedDbListStorage implements ListStorage {
  private dbPromise: Promise<IDBDatabase>;

  constructor(options: StorageOptions = {}) {
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

    const operationsByList = new Map<string, TaskListOperation[]>();
    (operationRecords || []).forEach((record) => {
      const listId = record.listId;
      if (!operationsByList.has(listId)) {
        operationsByList.set(listId, []);
      }
      const op = deserializeOperation(record.operation);
      if (isTaskListOperation(op)) {
        operationsByList.get(listId)!.push(op);
      }
    });

    const response: PersistedListRecord[] = [];
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

  async loadList(listId: ListId): Promise<PersistedListRecord> {
    if (typeof listId !== "string" || !listId.length) {
      return { listId, state: null, operations: [], updatedAt: null };
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

    const operations = sortOperations(
      (opRecords || [])
        .map((record) => deserializeOperation(record.operation))
        .filter(isTaskListOperation)
    ) as TaskListOperation[];

    return {
      listId,
      state: stateRecord ? deserializeListState(stateRecord.state) : null,
      operations,
      updatedAt: stateRecord?.updatedAt ?? null,
    };
  }

  /**
   * Saves a list's state. Its operations are in the state, so none are
   * stored; any an older version stored are removed with it.
   */
  async persistList(listId: ListId, state: ListState) {
    if (typeof listId !== "string" || !listId.length) {
      throw new Error("persistList requires a listId");
    }
    const db = await this.ready();
    const transaction = db.transaction(
      [STORE_LIST_STATES, STORE_LIST_OPERATIONS],
      "readwrite"
    );
    const completion = transactionCompleted(transaction);
    const index = transaction.objectStore(STORE_LIST_OPERATIONS).index("byList");
    await iterateCursor(index.openCursor(listId), (cursor) => {
      cursor.delete();
    });
    transaction.objectStore(STORE_LIST_STATES).put({
      listId,
      state: serializeListState(state),
      updatedAt: Date.now(),
      version: SERIALIZATION_VERSION,
    });
    await completion;
  }

  async loadRegistry(): Promise<PersistedRegistryRecord> {
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
    const operations = sortOperations(
      (opRecords || [])
        .map((record) => deserializeOperation(record.operation))
        .filter(isRegistryOperation)
    ) as ListsOperation[];

    return {
      state: stateRecord ? deserializeRegistryState(stateRecord.state) : null,
      operations,
      updatedAt: stateRecord?.updatedAt ?? null,
    };
  }

  async loadSyncState(): Promise<SyncState> {
    const db = await this.ready();
    const transaction = db.transaction([STORE_SYNC_STATE], "readonly");
    const completion = transactionCompleted(transaction);
    const store = transaction.objectStore(STORE_SYNC_STATE);
    const record = await promisifyRequest(store.get(SYNC_STATE_ID));
    await completion;
    return {
      clientId: record?.clientId ?? "",
      lastServerSeq: Number.isFinite(record?.lastServerSeq)
        ? Math.max(0, Math.floor(record.lastServerSeq))
        : 0,
      datasetGenerationKey: typeof record?.datasetGenerationKey === "string" ? record.datasetGenerationKey : "",
    };
  }

  async persistSyncState(state: SyncState) {
    const db = await this.ready();
    const transaction = db.transaction([STORE_SYNC_STATE], "readwrite");
    const completion = transactionCompleted(transaction);
    const store = transaction.objectStore(STORE_SYNC_STATE);
    store.put({
      id: SYNC_STATE_ID,
      clientId: state.clientId ?? "",
      lastServerSeq: Number.isFinite(state.lastServerSeq)
        ? Math.max(0, Math.floor(state.lastServerSeq))
        : 0,
      datasetGenerationKey: typeof state.datasetGenerationKey === "string" ? state.datasetGenerationKey : "",
    });
    await completion;
  }

  async loadOutbox(): Promise<SyncOp[]> {
    const db = await this.ready();
    const transaction = db.transaction([STORE_SYNC_OUTBOX], "readonly");
    const completion = transactionCompleted(transaction);
    const store = transaction.objectStore(STORE_SYNC_OUTBOX);
    const record = await promisifyRequest(store.get(OUTBOX_ID));
    await completion;
    return Array.isArray(record?.ops) ? record.ops : [];
  }

  async persistOutbox(ops: SyncOp[]) {
    const db = await this.ready();
    const transaction = db.transaction([STORE_SYNC_OUTBOX], "readwrite");
    const completion = transactionCompleted(transaction);
    const store = transaction.objectStore(STORE_SYNC_OUTBOX);
    store.put({ id: OUTBOX_ID, ops: Array.isArray(ops) ? ops : [] });
    await completion;
  }

  /** Saves the registry's state; see `persistList`. */
  async persistRegistry(state: RegistryState) {
    const db = await this.ready();
    const transaction = db.transaction(
      [STORE_REGISTRY_STATE, STORE_REGISTRY_OPERATIONS],
      "readwrite"
    );
    const completion = transactionCompleted(transaction);
    transaction.objectStore(STORE_REGISTRY_OPERATIONS).clear();
    transaction.objectStore(STORE_REGISTRY_STATE).put({
      id: REGISTRY_STATE_ID,
      state: serializeRegistryState(state),
      updatedAt: Date.now(),
      version: SERIALIZATION_VERSION,
    });
    await completion;
  }

  async pruneRegistryOperations(beforeClock: number) {
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
        STORE_SYNC_STATE,
        STORE_SYNC_OUTBOX,
      ],
      "readwrite"
    );
    const completion = transactionCompleted(transaction);
    transaction.objectStore(STORE_LIST_STATES).clear();
    transaction.objectStore(STORE_LIST_OPERATIONS).clear();
    transaction.objectStore(STORE_REGISTRY_STATE).clear();
    transaction.objectStore(STORE_REGISTRY_OPERATIONS).clear();
    transaction.objectStore(STORE_SYNC_STATE).clear();
    transaction.objectStore(STORE_SYNC_OUTBOX).clear();
    await completion;
  }
}

export async function createListStorage(
  options: StorageOptions = {}
): Promise<ListStorage> {
  const storage = new IndexedDbListStorage(options);
  await storage.ready();
  if (options.requestPersistence !== false) {
    requestPersistentStorage().catch(() => {});
  }
  return storage;
}
