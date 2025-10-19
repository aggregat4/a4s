import {
    SERIALIZATION_VERSION,
    REGISTRY_STATE_ID,
    serializeListState,
    deserializeListState,
    serializeRegistryState,
    deserializeRegistryState,
    serializeOperation,
    deserializeOperation,
    cleanUndefinedKeys,
} from "./serde.js";

const DB_NAME = "protoLists";
const DB_VERSION = 1;

const STORE_LIST_STATES = "listStates";
const STORE_LIST_OPERATIONS = "listOperations";
const STORE_REGISTRY_STATE = "registryState";
const STORE_REGISTRY_OPERATIONS = "registryOperations";

const LOCAL_STORAGE_ROOT_KEY = "protoLists.localPersistence";

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

export async function requestPersistentStorage() {
    if (typeof navigator === "undefined" || !navigator.storage) {
        return false;
    }
    if (typeof navigator.storage.persist !== "function") {
        return false;
    }
    try {
        return Boolean(await navigator.storage.persist());
    } catch (err) {
        return false;
    }
}

function openDatabase(options = {}) {
    if (typeof indexedDB === "undefined") {
        return Promise.reject(new Error("IndexedDB is not available in this environment"));
    }
    const name = typeof options.dbName === "string" && options.dbName.length ? options.dbName : DB_NAME;
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
                db.createObjectStore(STORE_REGISTRY_OPERATIONS, { keyPath: ["clock", "actor"] });
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
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
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
        const transaction = db.transaction([STORE_LIST_STATES, STORE_LIST_OPERATIONS], "readonly");
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
        const transaction = db.transaction([STORE_LIST_STATES, STORE_LIST_OPERATIONS], "readonly");
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
                    .filter(Boolean),
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
        const transaction = db.transaction([STORE_REGISTRY_STATE, STORE_REGISTRY_OPERATIONS], "readonly");
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
                    .filter(Boolean),
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
            [STORE_LIST_STATES, STORE_LIST_OPERATIONS, STORE_REGISTRY_STATE, STORE_REGISTRY_OPERATIONS],
            "readwrite",
        );
        const completion = transactionCompleted(transaction);
        transaction.objectStore(STORE_LIST_STATES).clear();
        transaction.objectStore(STORE_LIST_OPERATIONS).clear();
        transaction.objectStore(STORE_REGISTRY_STATE).clear();
        transaction.objectStore(STORE_REGISTRY_OPERATIONS).clear();
        await completion;
    }
}

function resolveStorageOverride(storage) {
    if (storage) return storage;
    try {
        if (typeof window !== "undefined" && window.localStorage) {
            return window.localStorage;
        }
    } catch (err) {
        // Ignore, fallback to memory.
    }
    const memory = new Map();
    return {
        getItem(key) {
            return memory.has(key) ? memory.get(key) : null;
        },
        setItem(key, value) {
            memory.set(key, value);
        },
        removeItem(key) {
            memory.delete(key);
        },
    };
}

class LocalStorageListStorage {
    constructor(options = {}) {
        this.storage = resolveStorageOverride(options.storage);
        this.rootKey =
            typeof options.storageKey === "string" && options.storageKey.length
                ? options.storageKey
                : LOCAL_STORAGE_ROOT_KEY;
    }

    async ready() {
        return true;
    }

    read() {
        let raw = null;
        try {
            raw = this.storage.getItem(this.rootKey);
        } catch (err) {
            raw = null;
        }
        if (!raw) {
            return {
                version: SERIALIZATION_VERSION,
                lists: {},
                registry: {
                    state: null,
                    operations: [],
                    updatedAt: null,
                },
            };
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed.lists) parsed.lists = {};
            if (!parsed.registry) {
                parsed.registry = { state: null, operations: [], updatedAt: null };
            }
            if (!parsed.registry.operations) parsed.registry.operations = [];
            return parsed;
        } catch (err) {
            return {
                version: SERIALIZATION_VERSION,
                lists: {},
                registry: { state: null, operations: [], updatedAt: null },
            };
        }
    }

    write(data) {
        try {
            this.storage.setItem(this.rootKey, JSON.stringify(data));
        } catch (err) {
            // Ignore quota errors in fallback storage.
        }
    }

    async loadAllLists() {
        const data = this.read();
        return Object.entries(data.lists).map(([listId, record]) => ({
            listId,
            state: record.state ? deserializeListState(record.state) : null,
            operations: sortOperations(
                (record.operations || []).map((entry) => deserializeOperation(entry)).filter(Boolean),
            ),
            updatedAt: record.updatedAt ?? null,
        }));
    }

    async loadList(listId) {
        const data = this.read();
        const record = data.lists[listId];
        if (!record) {
            return { listId, state: null, operations: [], updatedAt: null };
        }
        return {
            listId,
            state: record.state ? deserializeListState(record.state) : null,
            operations: sortOperations(
                (record.operations || []).map((entry) => deserializeOperation(entry)).filter(Boolean),
            ),
            updatedAt: record.updatedAt ?? null,
        };
    }

    async persistOperations(listId, operations = [], options = {}) {
        if (typeof listId !== "string" || !listId.length) {
            throw new Error("persistOperations requires a listId");
        }
        const data = this.read();
        const record = data.lists[listId] ?? {
            state: null,
            operations: [],
            updatedAt: null,
        };
        const now = Date.now();

        if (Array.isArray(operations) && operations.length) {
            const merged = [...record.operations];
            operations.forEach((operation) => {
                const serialized = serializeOperation(operation);
                if (!serialized) return;
                merged.push(cleanUndefinedKeys(serialized));
            });
            const unique = new Map();
            merged.forEach((op) => {
                unique.set(toOperationKey(op), op);
            });
            record.operations = sortOperations(
                Array.from(unique.values()).map((entry) => deserializeOperation(entry)).filter(Boolean),
            ).map((entry) => cleanUndefinedKeys(serializeOperation(entry)));
        }

        if (options.snapshot) {
            record.state = serializeListState(options.snapshot);
        }

        record.updatedAt = now;
        data.lists[listId] = record;
        this.write(data);
    }

    async pruneOperations(listId, beforeClock) {
        if (!Number.isFinite(beforeClock)) return;
        const data = this.read();
        const record = data.lists[listId];
        if (!record || !Array.isArray(record.operations)) return;
        record.operations = record.operations
            .map((entry) => deserializeOperation(entry))
            .filter((op) => op && op.clock > beforeClock)
            .map((op) => serializeOperation(op));
        this.write(data);
    }

    async loadRegistry() {
        const data = this.read();
        return {
            state: data.registry.state ? deserializeRegistryState(data.registry.state) : null,
            operations: sortOperations(
                (data.registry.operations || [])
                    .map((entry) => deserializeOperation(entry))
                    .filter(Boolean),
            ),
            updatedAt: data.registry.updatedAt ?? null,
        };
    }

    async persistRegistry({ operations = [], snapshot = null } = {}) {
        const data = this.read();
        const now = Date.now();

        if (Array.isArray(operations) && operations.length) {
            const merged = [...(data.registry.operations || [])];
            operations.forEach((operation) => {
                const serialized = serializeOperation(operation);
                if (!serialized) return;
                merged.push(cleanUndefinedKeys(serialized));
            });
            const unique = new Map();
            merged.forEach((op) => {
                unique.set(toOperationKey(op), op);
            });
            data.registry.operations = sortOperations(
                Array.from(unique.values()).map((entry) => deserializeOperation(entry)).filter(Boolean),
            ).map((entry) => cleanUndefinedKeys(serializeOperation(entry)));
        }

        if (snapshot) {
            data.registry.state = serializeRegistryState(snapshot);
        }

        data.registry.updatedAt = now;
        this.write(data);
    }

    async pruneRegistryOperations(beforeClock) {
        if (!Number.isFinite(beforeClock)) return;
        const data = this.read();
        data.registry.operations = (data.registry.operations || [])
            .map((entry) => deserializeOperation(entry))
            .filter((op) => op && op.clock > beforeClock)
            .map((op) => serializeOperation(op));
        this.write(data);
    }

    async clear() {
        this.write({
            version: SERIALIZATION_VERSION,
            lists: {},
            registry: { state: null, operations: [], updatedAt: null },
        });
    }
}

export async function createListStorage(options = {}) {
    if (options.forceFallback) {
        const fallback = new LocalStorageListStorage(options);
        await fallback.ready();
        return fallback;
    }
    if (typeof indexedDB !== "undefined" && !options.forceLocalStorage) {
        try {
            const storage = new IndexedDbListStorage(options);
            await storage.ready();
            if (options.requestPersistence !== false) {
                requestPersistentStorage().catch(() => {});
            }
            return storage;
        } catch (err) {
            // Fallback to local storage.
        }
    }
    const fallback = new LocalStorageListStorage(options);
    await fallback.ready();
    return fallback;
}

export { IndexedDbListStorage, LocalStorageListStorage };
