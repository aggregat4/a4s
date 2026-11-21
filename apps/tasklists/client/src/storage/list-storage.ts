import {
  SERIALIZATION_VERSION,
  REGISTRY_STATE_ID,
  serializeListState,
  deserializeListState,
  serializeRegistryState,
  deserializeRegistryState,
} from "./serde.js";
import type { ListId, ListState, RegistryState } from "../types/domain.js";
import type { SyncOp, SyncState } from "../types/sync.js";
import type {
  ListStorage,
  PersistedListRecord,
  PersistedRegistryRecord,
} from "../types/storage.js";

const DB_NAME = "protoLists";
export const DEFAULT_DB_NAME = DB_NAME;
const DB_VERSION = 3;

const STORE_LIST_STATES = "listStates";
const STORE_REGISTRY_STATE = "registryState";
const STORE_SYNC_STATE = "syncState";
const STORE_SYNC_OUTBOX = "syncOutbox";

/**
 * Stores of operations that versions before 1.8.0 saved next to a state that
 * already held them. Version 3 of the database drops them.
 */
const REMOVED_STORES = ["listOperations", "registryOperations"];

const SYNC_STATE_ID = "sync";
const OUTBOX_ID = "outbox";

type StorageOptions = {
  dbName?: string;
  requestPersistence?: boolean;
};

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
      if (!db.objectStoreNames.contains(STORE_REGISTRY_STATE)) {
        db.createObjectStore(STORE_REGISTRY_STATE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_STATE)) {
        db.createObjectStore(STORE_SYNC_STATE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_OUTBOX)) {
        db.createObjectStore(STORE_SYNC_OUTBOX, { keyPath: "id" });
      }
      REMOVED_STORES.forEach((name) => {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
        }
      });
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

class IndexedDbListStorage implements ListStorage {
  private dbPromise: Promise<IDBDatabase>;

  constructor(options: StorageOptions = {}) {
    this.dbPromise = openDatabase(options);
  }

  async ready() {
    return this.dbPromise;
  }

  async loadAllLists(): Promise<PersistedListRecord[]> {
    const db = await this.ready();
    const transaction = db.transaction(STORE_LIST_STATES, "readonly");
    const completion = transactionCompleted(transaction);
    const records = await promisifyRequest(
      transaction.objectStore(STORE_LIST_STATES).getAll()
    );
    await completion;
    return (records || []).map((record) => ({
      listId: record.listId,
      state: deserializeListState(record.state),
      updatedAt: record.updatedAt ?? null,
    }));
  }

  async loadList(listId: ListId): Promise<PersistedListRecord> {
    if (typeof listId !== "string" || !listId.length) {
      return { listId, state: null, updatedAt: null };
    }
    const db = await this.ready();
    const transaction = db.transaction(STORE_LIST_STATES, "readonly");
    const completion = transactionCompleted(transaction);
    const record = await promisifyRequest(
      transaction.objectStore(STORE_LIST_STATES).get(listId)
    );
    await completion;
    return {
      listId,
      state: record ? deserializeListState(record.state) : null,
      updatedAt: record?.updatedAt ?? null,
    };
  }

  async persistList(listId: ListId, state: ListState) {
    if (typeof listId !== "string" || !listId.length) {
      throw new Error("persistList requires a listId");
    }
    const db = await this.ready();
    const transaction = db.transaction(STORE_LIST_STATES, "readwrite");
    const completion = transactionCompleted(transaction);
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
    const transaction = db.transaction(STORE_REGISTRY_STATE, "readonly");
    const completion = transactionCompleted(transaction);
    const record = await promisifyRequest(
      transaction.objectStore(STORE_REGISTRY_STATE).get(REGISTRY_STATE_ID)
    );
    await completion;
    return {
      state: record ? deserializeRegistryState(record.state) : null,
      updatedAt: record?.updatedAt ?? null,
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

  async persistRegistry(state: RegistryState) {
    const db = await this.ready();
    const transaction = db.transaction(STORE_REGISTRY_STATE, "readwrite");
    const completion = transactionCompleted(transaction);
    transaction.objectStore(STORE_REGISTRY_STATE).put({
      id: REGISTRY_STATE_ID,
      state: serializeRegistryState(state),
      updatedAt: Date.now(),
      version: SERIALIZATION_VERSION,
    });
    await completion;
  }

  async clear() {
    const db = await this.ready();
    const stores = [
      STORE_LIST_STATES,
      STORE_REGISTRY_STATE,
      STORE_SYNC_STATE,
      STORE_SYNC_OUTBOX,
    ];
    const transaction = db.transaction(stores, "readwrite");
    const completion = transactionCompleted(transaction);
    stores.forEach((name) => transaction.objectStore(name).clear());
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
