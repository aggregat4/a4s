import { ListsCRDT } from "../domain/crdt/lists-crdt.js";
import { TaskListCRDT } from "../domain/crdt/task-list-crdt.js";
import { ensureActorId } from "../domain/crdt/ids.js";
import { createListStorage } from "../storage/list-storage.js";
import { hydrateFromStorage } from "../storage/hydrator.js";
import type {
  ListCreateInput,
  ListId,
  ListRegistryEntry,
  ListState,
  ListReorderInput,
  Position,
  TaskInsertInput,
  TaskItem,
  TaskListState,
  TaskMoveInput,
  TaskUpdateInput,
} from "../types/domain.js";
import type { RegistryState } from "../types/domain.js";
import type { ListStorage } from "../types/storage.js";
import type { TaskListOperation, ListsOperation } from "../types/crdt.js";
import type { SyncOp } from "../types/sync.js";
import { HistoryManager } from "./history-manager.js";
import type { HistoryOp, HistoryScope } from "./history-types.js";
import { SyncEngine } from "./sync-engine.js";
import { parseExportSnapshotText } from "./export-snapshot.js";

type ListRecord = { crdt: TaskListCRDT };
type StorageOptions = Record<string, unknown>;
type StorageFactory = (options?: StorageOptions) => Promise<ListStorage>;
type ListFactory = (listId: ListId, state?: ListState | null, identityOptions?: { storageKey?: string; storage?: Storage }) => TaskListCRDT;
type RegistryListener = (snapshot: ListRegistryEntry[]) => void;
type ListListener = (state: TaskListState) => void;
type GlobalListener =
  | { type: "registry"; snapshot: ListRegistryEntry[] }
  | { type: "list"; listId: ListId; state: TaskListState };

type SyncOptions = {
  baseUrl?: string;
  pollIntervalMs?: number;
};

function defaultListFactory(_listId: ListId, state: ListState | null = null, identityOptions?: { storageKey?: string; storage?: Storage }) {
  return new TaskListCRDT({
    title: state?.title ?? "",
    titleUpdatedAt: state?.titleUpdatedAt ?? 0,
    identityOptions,
  });
}

function sanitizeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function ensureId(value: unknown, prefix: string) {
  if (typeof value === "string" && value.length) return value;
  return `${prefix}-${crypto.randomUUID()}`;
}

function toListState(record?: ListRecord | null): TaskListState {
  if (!record?.crdt) return { title: "", items: [] };
  return record.crdt.toListState();
}

export class ListRepository {
  /*
    Text edits, inserts, and undo/redo are async and can interleave. The queues
    below make ordering explicit so we don't drop keystrokes or corrupt history:
    - _pendingInserts: when a new task is inserted, early text updates wait until
      the CRDT entry exists.
    - _textUpdateQueue: text edits for a given item are serialized so each update
      applies in order.
    - _historyQueue: undo/redo operations run sequentially to avoid overlapping
      history replays.
    Coalescing groups adjacent text edits into a single undo step based on time
    gaps and word boundaries for a native editor feel.

    Sync outbox architecture:
    - Durable source of truth: IndexedDB outbox (`ListStorage.loadOutbox` /
      `persistOutbox`).
    - Fast path: when `SyncEngine` is active, repository writes local ops to the
      in-memory engine outbox; engine persists and flushes to server.
    - Fallback path: when sync is temporarily unavailable, repository appends
      local ops directly to durable outbox so no user edits are dropped.
    - Recovery: on re-enable, `SyncEngine.initialize()` reloads durable outbox
      and resumes push/pull from stored cursor state.
  */
  private _listsCrdt: ListsCRDT;
  private _createListCrdt: ListFactory;
  private _storageFactory: StorageFactory;
  private _storageOptions: StorageOptions;
  private _identityOptions: { storageKey?: string; storage?: Storage } | undefined;
  private _storage: ListStorage | null;
  private _listMap: Map<ListId, ListRecord>;
  private _registryListeners: Set<RegistryListener>;
  private _listListeners: Map<ListId, Set<ListListener>>;
  private _globalListeners: Set<(payload: GlobalListener) => void>;
  private _history: HistoryManager;
  private _historySuppressed: number;
  // Serializes undo/redo so history ops never interleave.
  private _historyQueue: Promise<void>;
  // Serializes text updates per item so keystrokes apply in order.
  private _textUpdateQueue: Map<string, Promise<void>>;
  // Tracks inserts so early text edits can wait until the item exists in CRDT.
  private _pendingInserts: Map<string, Promise<void>>;
  private _textEditSessions: Map<
    string,
    { segmentId: number; lastAt: number; lastText: string }
  >;
  private _initialized: boolean;
  private _initializing: Promise<void> | null;
  private _unsubscribeRegistry: (() => void) | null;
  private _sync: SyncEngine | null;
  private _syncOptions: SyncOptions | null;
  private _syncErrorHandler: ((error: unknown) => void) | null;
  private _outboxPersistQueue: Promise<void>;

  constructor(
    options: {
      listsCrdt?: ListsCRDT;
      listsCrdtOptions?: { actorId?: string; identityOptions?: { storageKey?: string; storage?: Storage } };
      createListCrdt?: ListFactory;
      storageFactory?: StorageFactory;
      storageOptions?: StorageOptions;
      sync?: SyncOptions | null;
    } = {}
  ) {
    this._listsCrdt =
      options.listsCrdt ?? new ListsCRDT(options.listsCrdtOptions);
    this._createListCrdt = options.createListCrdt ?? defaultListFactory;
    this._storageFactory = options.storageFactory ?? createListStorage;
    this._identityOptions = options.listsCrdtOptions?.identityOptions;
    this._storageOptions = options.storageOptions ?? {};
    this._syncOptions = options.sync ?? null;

    this._storage = null;
    this._listMap = new Map();
    this._registryListeners = new Set();
    this._listListeners = new Map();
    this._globalListeners = new Set();
    this._history = new HistoryManager();
    this._historySuppressed = 0;
    this._historyQueue = Promise.resolve();
    this._textUpdateQueue = new Map();
    this._pendingInserts = new Map();
    this._textEditSessions = new Map();
    this._initialized = false;
    this._initializing = null;
    this._unsubscribeRegistry = null;
    this._sync = null;
    this._syncErrorHandler = null;
    this._outboxPersistQueue = Promise.resolve();
  }

  recordHistory({
    scope,
    forwardOps,
    inverseOps,
    label,
    actor,
    coalesceKey,
  }: {
    scope: HistoryScope;
    forwardOps: HistoryOp[];
    inverseOps: HistoryOp[];
    label?: string;
    actor?: string;
    coalesceKey?: string;
  }) {
    if (this._historySuppressed > 0) return;
    this._history.record({
      scope,
      forwardOps,
      inverseOps,
      label,
      actor,
      coalesceKey,
      timestamp: Date.now(),
    });
  }

  canUndo() {
    return this._history.canUndo();
  }

  canRedo() {
    return this._history.canRedo();
  }

  async undo() {
    return this.enqueueHistoryAction(async () => {
      await this.initialize();
      await this.flushPendingEdits();
      const entry = this._history.undo();
      if (!entry) return false;
      await this.applyHistoryOps(entry.inverseOps);
      this._textEditSessions.clear();
      return true;
    });
  }

  async redo() {
    return this.enqueueHistoryAction(async () => {
      await this.initialize();
      await this.flushPendingEdits();
      const entry = this._history.redo();
      if (!entry) return false;
      await this.applyHistoryOps(entry.forwardOps);
      this._textEditSessions.clear();
      return true;
    });
  }

  getNeighborIds(order: string[], targetId: string) {
    const index = order.indexOf(targetId);
    if (index === -1) {
      return { afterId: null, beforeId: null };
    }
    return {
      afterId: order[index - 1] ?? null,
      beforeId: order[index + 1] ?? null,
    };
  }

  async initialize(): Promise<ListRegistryEntry[]> {
    if (this._initialized) {
      return this.getRegistrySnapshot();
    }
    if (this._initializing) {
      // We only want to initialize once, so any concurrent calls should wait until the first is ready and then get the snapshot
      await this._initializing;
      return this.getRegistrySnapshot();
    }
    this._initializing = this._initializeInternal();
    await this._initializing;
    this._initialized = true;
    this._initializing = null;
    this.emitRegistryChange();
    this._listMap.forEach((_, listId) => this.emitListChange(listId));
    return this.getRegistrySnapshot();
  }

  async _initializeInternal(): Promise<void> {
    this._storage = await this._storageFactory(this._storageOptions);

    const hydration = await hydrateFromStorage({
      storage: this._storage,
      listsCrdt: this._listsCrdt,
      createListCrdt: (listId, state) =>
        this._createListInstance(listId, state),
    });

    this._listMap = (hydration.lists ?? new Map()) as Map<ListId, ListRecord>;
    if (this._unsubscribeRegistry) {
      this._unsubscribeRegistry();
      this._unsubscribeRegistry = null;
    }
    this._unsubscribeRegistry = this._listsCrdt.subscribe(() => {
      if (this._initialized) {
        // Avoid emitting during hydration; listeners only run once bootstrap finishes.
        this.emitRegistryChange();
      }
    });

    if (!this._sync && this._syncOptions?.baseUrl && this._storage) {
      await this.enableSync(this._syncOptions.baseUrl, {
        onConnectionError: this._syncErrorHandler ?? undefined,
      });
    }
  }

  dispose() {
    this._unsubscribeRegistry?.();
    this._unsubscribeRegistry = null;
    this._registryListeners.clear();
    this._listListeners.clear();
    this._globalListeners.clear();
    this._storage = null;
    this._sync?.stop();
    this._sync = null;
    this._syncOptions = null;
    this._syncErrorHandler = null;
    this._outboxPersistQueue = Promise.resolve();
    this._listMap.clear();
    this._history.clear();
    this._historySuppressed = 0;
    this._textEditSessions.clear();
    this._textUpdateQueue.clear();
    this._pendingInserts.clear();
    this._initialized = false;
    this._initializing = null;
  }

  isSyncEnabled() {
    return Boolean(this._sync);
  }

  async enableSync(
    baseUrl: string,
    options: { onConnectionError?: (error: unknown) => void } = {}
  ) {
    if (!baseUrl) return;
    await this.initialize();
    const normalized = baseUrl.replace(/\/$/, "");
    if (this._sync && this._syncOptions?.baseUrl === normalized) {
      if (options.onConnectionError) {
        this._syncErrorHandler = options.onConnectionError;
      }
      return;
    }
    this.disableSync();
    this._syncOptions = { baseUrl: normalized };
    this._syncErrorHandler = options.onConnectionError ?? null;
    if (!this._storage) return;
    this._sync = new SyncEngine({
      storage: this._storage,
      baseUrl: normalized,
      pollIntervalMs: this._syncOptions.pollIntervalMs,
      onRemoteOps: async (ops) => this.applyRemoteOps(ops),
      onSnapshot: async ({ snapshot }) => {
        await this.applySnapshotBlob(snapshot);
      },
      onConnectionError: (error) => {
        this._syncErrorHandler?.(error);
        this.disableSync();
      },
    });
    await this._sync.initialize();
    await this._sync.bootstrapIfNeeded((ops) => this.applyRemoteOpsInternal(ops));
    this._sync.start();
  }

  disableSync() {
    if (this._sync) {
      this._sync.stop();
      this._sync = null;
    }
    this._syncOptions = null;
  }

  isInitialized() {
    return this._initialized;
  }

  getRegistrySnapshot(): ListRegistryEntry[] {
    return this._listsCrdt.getVisibleLists();
  }

  getListIds(): ListId[] {
    return this.getRegistrySnapshot().map((entry) => entry.id);
  }

  getListState(listId: ListId): TaskListState {
    const record = this._listMap.get(listId);
    return toListState(record);
  }

  getListSnapshot(listId: ListId) {
    const record = this._listMap.get(listId);
    if (!record?.crdt) return [];
    return record.crdt.getSnapshot();
  }

  async exportSnapshotData(): Promise<{
    registryState: RegistryState;
    lists: Array<{ listId: ListId; state: ListState }>;
  }> {
    await this.initialize();
    const registryState = this._listsCrdt.exportState();
    const lists: Array<{ listId: ListId; state: ListState }> = [];
    this.getRegistrySnapshot().forEach((entry) => {
      const record = this._listMap.get(entry.id);
      if (!record?.crdt) return;
      lists.push({ listId: entry.id, state: record.crdt.exportState() });
    });
    return { registryState, lists };
  }

  async replaceWithSnapshot({
    registryState,
    lists,
    snapshotText,
    publishSnapshot = false,
  }: {
    registryState: RegistryState;
    lists: Array<{ listId: ListId; state: ListState }>;
    snapshotText?: string;
    publishSnapshot?: boolean;
  }): Promise<{ published: boolean; error?: string } | null> {
    await this.initialize();
    await this.flushPendingEdits();
    if (!this._storage) return;

    this._sync?.stop();

    const existingSync = await this._storage.loadSyncState();
    const clientId =
      existingSync.clientId && existingSync.clientId.length
        ? existingSync.clientId
        : ensureActorId();

    await this._storage.clear();
    await this._storage.persistSyncState({
      clientId,
      lastServerSeq: 0,
    });
    await this._storage.persistOutbox([]);
    await this._storage.persistRegistry({
      operations: [],
      snapshot: registryState,
    });
    const listEntries = Array.isArray(lists) ? lists : [];
    for (const entry of listEntries) {
      if (!entry?.listId) continue;
      await this._storage.persistOperations(entry.listId, [], {
        snapshot: entry.state,
      });
    }

    const hydration = await hydrateFromStorage({
      storage: this._storage,
      listsCrdt: this._listsCrdt,
      createListCrdt: (listId, state) => this._createListInstance(listId, state),
    });
    this._listMap = (hydration.lists ?? new Map()) as Map<ListId, ListRecord>;
    this._history.clear();
    this._historySuppressed = 0;
    this._textEditSessions.clear();
    this._textUpdateQueue.clear();
    this._pendingInserts.clear();
    this.emitRegistryChange();
    this._listMap.forEach((_record, listId) => this.emitListChange(listId));

    let publishResult: { published: boolean; error?: string } | null = null;
    if (this._sync) {
      await this._sync.initialize();
      if (publishSnapshot && typeof snapshotText === "string") {
        const result = await this._sync.resetWithSnapshot(snapshotText);
        publishResult = result.ok
          ? { published: true }
          : { published: false, error: result.error };
      }
      this._sync.start();
    }
    return publishResult;
  }

  async applySnapshotBlob(snapshotText: string) {
    const parsed = parseExportSnapshotText(snapshotText);
    if (parsed.ok === false) {
      return false;
    }
    await this.replaceWithSnapshot({
      registryState: parsed.value.registryState,
      lists: parsed.value.lists,
      publishSnapshot: false,
    });
    return true;
  }

  subscribe(handler: (payload: GlobalListener) => void) {
    if (typeof handler !== "function") return () => {};
    this._globalListeners.add(handler);
    return () => {
      this._globalListeners.delete(handler);
    };
  }

  subscribeRegistry(
    handler: RegistryListener,
    { emitCurrent = true }: { emitCurrent?: boolean } = {}
  ) {
    if (typeof handler !== "function") return () => {};
    this._registryListeners.add(handler);
    if (emitCurrent && this._initialized) {
      handler(this.getRegistrySnapshot());
    }
    return () => {
      this._registryListeners.delete(handler);
    };
  }

  subscribeList(
    listId: ListId,
    handler: ListListener,
    { emitCurrent = true }: { emitCurrent?: boolean } = {}
  ) {
    if (typeof handler !== "function") return () => {};
    const key = listId ?? "";
    if (!this._listListeners.has(key)) {
      this._listListeners.set(key, new Set());
    }
    const listeners = this._listListeners.get(key);
    listeners.add(handler);
    if (emitCurrent && this._initialized && this._listMap.has(listId)) {
      handler(this.getListState(listId));
    }
    return () => {
      const bucket = this._listListeners.get(key);
      bucket?.delete(handler);
      if (bucket && bucket.size === 0) {
        this._listListeners.delete(key);
      }
    };
  }

  emitRegistryChange() {
    const snapshot = this.getRegistrySnapshot();
    this._registryListeners.forEach((handler) => {
      try {
        handler(snapshot);
      } catch (err) {
        // ignore listener errors
      }
    });
    this._globalListeners.forEach((handler) => {
      try {
        handler({ type: "registry", snapshot });
      } catch (err) {
        // ignore listener errors
      }
    });
  }

  emitListChange(listId: ListId) {
    const state = this.getListState(listId);
    const listeners = this._listListeners.get(listId);
    listeners?.forEach((handler) => {
      try {
        handler(state);
      } catch (err) {
        // ignore listener errors
      }
    });
    this._globalListeners.forEach((handler) => {
      try {
        handler({ type: "list", listId, state });
      } catch (err) {
        // ignore listener errors
      }
    });
  }

  async applyRemoteOps(ops: SyncOp[]) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    await this.initialize();
    await this.applyRemoteOpsInternal(ops);
  }

  private async applyRemoteOpsInternal(ops: SyncOp[]) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    const registryOps: ListsOperation[] = [];
    const listOps = new Map<ListId, TaskListOperation[]>();
    const changedLists = new Set<ListId>();
    let registryChanged = false;

    this._historySuppressed += 1;
    try {
      for (const entry of ops) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.scope === "registry") {
          const payload = entry.payload as ListsOperation;
          if (!payload || typeof payload !== "object") continue;
          const applied = this._listsCrdt.applyOperation(payload);
          if (applied) {
            registryChanged = true;
            registryOps.push(payload);
            if (payload.type === "createList" && payload.listId) {
              if (!this._listMap.has(payload.listId)) {
                const listCrdt = this._createListInstance(payload.listId, null);
                this._listMap.set(payload.listId, { crdt: listCrdt });
              }
            }
            if (payload.type === "removeList" && payload.listId) {
              this._listMap.delete(payload.listId);
              this.clearTextEditSessionsForList(payload.listId);
              this.clearTextUpdateQueueForList(payload.listId);
              this.clearPendingInsertsForList(payload.listId);
            }
          }
          continue;
        }
        if (entry.scope === "list") {
          const listId = entry.resourceId as ListId;
          if (!listId) continue;
          const payload = entry.payload as TaskListOperation;
          if (!payload || typeof payload !== "object") continue;
          let record = this._listMap.get(listId);
          if (!record) {
            record = { crdt: this._createListInstance(listId, null) };
            this._listMap.set(listId, record);
          }
          const applied = record.crdt.applyOperation(payload);
          if (applied) {
            changedLists.add(listId);
            if (!listOps.has(listId)) {
              listOps.set(listId, []);
            }
            listOps.get(listId)?.push(payload);
          }
        }
      }
    } finally {
      this._historySuppressed = Math.max(0, this._historySuppressed - 1);
    }

    if (registryOps.length > 0) {
      await this._persistRegistry(registryOps, { origin: "remote" });
    }
    for (const [listId, opsForList] of listOps.entries()) {
      const record = this._listMap.get(listId);
      if (!record?.crdt) continue;
      await this._persistList(listId, record.crdt, opsForList, {
        origin: "remote",
      });
    }

    if (registryChanged) {
      this.emitRegistryChange();
    }
    changedLists.forEach((listId) => this.emitListChange(listId));
  }

  async createList(options: ListCreateInput = {}) {
    await this.initialize();
    const listId = ensureId(options.listId, "list");
    const title = sanitizeText(options.title);
    const afterId =
      typeof options.afterId === "string" && options.afterId.length
        ? options.afterId
        : null;
    const beforeId =
      typeof options.beforeId === "string" && options.beforeId.length
        ? options.beforeId
        : null;

    if (this._listMap.has(listId)) {
      return { id: listId, state: this.getListState(listId) };
    }

    const createResult = this._listsCrdt.generateCreate({
      listId,
      title,
      afterId,
      beforeId,
      position: options.position ?? null,
    });

    const listCrdt = this._createListInstance(listId, null);
    listCrdt.resetFromState({
      title,
      titleUpdatedAt: listCrdt.titleUpdatedAt,
      clock: listCrdt.clock.value(),
      entries: [],
    });

    const ops = [];
    if (title.length) {
      const rename = listCrdt.generateRename(title);
      ops.push(rename.op);
    }
    if (Array.isArray(options.items)) {
      let previousId = null;
      options.items.forEach((item: TaskItem) => {
        const itemId = ensureId(item?.id, `${listId}-item`);
        const insert = listCrdt.generateInsert({
          itemId,
          text: sanitizeText(item?.text),
          done: Boolean(item?.done),
          note: sanitizeText(item?.note),
          afterId: previousId,
        });
        ops.push(insert.op);
        previousId = itemId;
      });
    }

    this._listMap.set(listId, {
      crdt: listCrdt,
    });

    await this._persistRegistry([createResult.op]);
    await this._persistList(listId, listCrdt, ops.length ? ops : []);

    this.emitRegistryChange();
    this.emitListChange(listId);

    const createdRecord = this._listsCrdt.getRecord(listId);
    this.recordHistory({
      scope: { type: "registry" },
      forwardOps: [
        {
          type: "createList",
          listId,
          title,
          items: listCrdt.toListState().items,
          afterId,
          beforeId,
          position: createdRecord?.pos ?? null,
        },
      ],
      inverseOps: [
        {
          type: "removeList",
          listId,
        },
      ],
      label: "create-list",
      actor: this._listsCrdt.actorId,
    });

    return { id: listId, state: listCrdt.toListState() };
  }

  async removeList(listId: ListId) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return false;
    const registryRecord = this._listsCrdt.getRecord(listId);
    const listState = record.crdt.toListState();
    const registryOrder = this.getRegistrySnapshot().map((entry) => entry.id);
    const { afterId, beforeId } = this.getNeighborIds(registryOrder, listId);
    const removeResult = this._listsCrdt.generateRemove(listId);
    this._listMap.delete(listId);
    await this._persistRegistry([removeResult.op]);
    this.emitRegistryChange();
    this.emitListChange(listId);
    this.recordHistory({
      scope: { type: "registry" },
      forwardOps: [
        {
          type: "removeList",
          listId,
        },
      ],
      inverseOps: [
        {
          type: "createList",
          listId,
          title: listState.title,
          items: listState.items,
          afterId,
          beforeId,
          position: registryRecord?.pos ?? null,
        },
      ],
      label: "remove-list",
      actor: this._listsCrdt.actorId,
    });
    this.clearTextEditSessionsForList(listId);
    this.clearTextUpdateQueueForList(listId);
    this.clearPendingInsertsForList(listId);
    return true;
  }

  async renameList(listId: ListId, title: string) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const previousTitle = record.crdt.title;
    const nextTitle = sanitizeText(title);
    const renameTask = record.crdt.generateRename(nextTitle);
    const renameRegistry = this._listsCrdt.generateRename(listId, nextTitle);
    await Promise.all([
      this._persistList(listId, record.crdt, [renameTask.op]),
      this._persistRegistry([renameRegistry.op]),
    ]);
    this.emitRegistryChange();
    this.emitListChange(listId);
    if (previousTitle !== nextTitle) {
      this.recordHistory({
        scope: { type: "registry" },
        forwardOps: [
          {
            type: "renameList",
            listId,
            title: nextTitle,
          },
        ],
        inverseOps: [
          {
            type: "renameList",
            listId,
            title: previousTitle,
          },
        ],
        label: "rename-list",
        actor: record.crdt.actorId,
        coalesceKey: `${listId}:rename`,
      });
    }
    return record.crdt.toListState();
  }

  async reorderList(
    listId: ListId,
    { afterId = null, beforeId = null, position = null }: ListReorderInput = {}
  ) {
    await this.initialize();
    const targetId =
      typeof listId === "string" && listId.length ? listId : null;
    if (!targetId || !this._listMap.has(targetId)) return null;
    const registryOrder = this.getRegistrySnapshot().map((entry) => entry.id);
    const previousNeighbors = this.getNeighborIds(registryOrder, targetId);
    const registryRecord = this._listsCrdt.getRecord(targetId);
    const reorder = this._listsCrdt.generateReorder({
      listId: targetId,
      afterId,
      beforeId,
      position,
    });
    const nextRecord = this._listsCrdt.getRecord(targetId);
    await this._persistRegistry([reorder.op]);
    this.emitRegistryChange();
    this.recordHistory({
      scope: { type: "registry" },
      forwardOps: [
        {
          type: "reorderList",
          listId: targetId,
          afterId,
          beforeId,
          position: nextRecord?.pos ?? null,
        },
      ],
      inverseOps: [
        {
          type: "reorderList",
          listId: targetId,
          afterId: previousNeighbors.afterId,
          beforeId: previousNeighbors.beforeId,
          position: registryRecord?.pos ?? null,
        },
      ],
      label: "reorder-list",
      actor: this._listsCrdt.actorId,
    });
    return reorder.snapshot;
  }

  async insertTask(listId: ListId, options: TaskInsertInput = {}) {
    // Mark the insert as pending so updateTask can wait for the CRDT entry.
    const itemId = ensureId(options.itemId, `${listId}-item`);
    const pendingKey = `${listId}:${itemId}`;
    let resolvePending: (() => void) | null = null;
    const pendingPromise = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    this._pendingInserts.set(pendingKey, pendingPromise);
    await this.initialize();
    try {
      const record = this._listMap.get(listId);
      if (!record?.crdt) return null;
      const text = sanitizeText(options.text);
      const done = options.done == null ? false : Boolean(options.done);
      const note = sanitizeText(options.note);
      const insert = record.crdt.generateInsert({
        itemId,
        text,
        done,
        note,
        afterId: options.afterId,
        beforeId: options.beforeId,
        position: options.position,
      });
      await this._persistList(listId, record.crdt, [insert.op]);
      this.emitListChange(listId);
      this.recordHistory({
        scope: { type: "list", listId },
        forwardOps: [
          {
            type: "insertTask",
            listId,
            itemId,
            text,
            done,
            note,
            afterId: options.afterId ?? null,
            beforeId: options.beforeId ?? null,
            position: options.position ?? null,
          },
        ],
        inverseOps: [
          {
            type: "removeTask",
            listId,
            itemId,
          },
        ],
        label: "insert-task",
        actor: record.crdt.actorId,
      });
      return { id: itemId, state: record.crdt.toListState() };
    } finally {
      resolvePending?.();
      this._pendingInserts.delete(pendingKey);
    }
  }

  async splitTask(
    listId: ListId,
    itemId: string,
    options: {
      beforeText: string;
      afterText: string;
      previousText: string;
      newItemId?: string;
      afterId?: string | null;
      beforeId?: string | null;
      position?: Position | null;
    }
  ) {
    const newItemId = ensureId(options.newItemId, `${listId}-item`);
    const pendingKey = `${listId}:${newItemId}`;
    let resolvePending: (() => void) | null = null;
    const pendingPromise = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    this._pendingInserts.set(pendingKey, pendingPromise);
    await this.initialize();
    try {
      const record = this._listMap.get(listId);
      if (!record?.crdt) return null;
      if (typeof itemId !== "string" || !itemId.length) return null;
      const existing = record.crdt
        .getSnapshot()
        .find((entry) => entry.id === itemId);
      if (!existing) return null;
      const beforeText = sanitizeText(options.beforeText);
      const afterText = sanitizeText(options.afterText);
      const previousText = sanitizeText(options.previousText);
      const update = record.crdt.generateUpdate({
        itemId,
        text: beforeText,
      });
      const insert = record.crdt.generateInsert({
        itemId: newItemId,
        text: afterText,
        done: false,
        note: "",
        afterId: options.afterId ?? null,
        beforeId: options.beforeId ?? null,
        position: options.position ?? null,
      });
      await this._persistList(listId, record.crdt, [update.op, insert.op]);
      this.emitListChange(listId);
      this.recordHistory({
        scope: { type: "list", listId },
        forwardOps: [
          {
            type: "updateTask",
            listId,
            itemId,
            payload: { text: beforeText },
          },
          {
            type: "insertTask",
            listId,
            itemId: newItemId,
            text: afterText,
            done: false,
            note: "",
            afterId: options.afterId ?? null,
            beforeId: options.beforeId ?? null,
            position: options.position ?? null,
          },
        ],
        inverseOps: [
          {
            type: "removeTask",
            listId,
            itemId: newItemId,
          },
          {
            type: "updateTask",
            listId,
            itemId,
            payload: { text: previousText },
          },
        ],
        label: "split-task",
        actor: record.crdt.actorId,
      });
      return { id: newItemId, state: record.crdt.toListState() };
    } finally {
      resolvePending?.();
      this._pendingInserts.delete(pendingKey);
    }
  }

  async mergeTask(
    listId: ListId,
    previousItemId: string,
    currentItemId: string,
    options: { mergedText: string }
  ) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    if (!previousItemId || !currentItemId) return null;
    if (previousItemId === currentItemId) return null;

    const snapshot = record.crdt.getSnapshot();
    const previousItem = snapshot.find((entry) => entry.id === previousItemId);
    const currentItem = snapshot.find((entry) => entry.id === currentItemId);
    if (!previousItem || !currentItem) return null;

    const order = snapshot.map((entry) => entry.id);
    const neighbors = this.getNeighborIds(order, currentItemId);
    const mergedText = sanitizeText(options?.mergedText);
    const update = record.crdt.generateUpdate({
      itemId: previousItemId,
      text: mergedText,
    });
    const remove = record.crdt.generateRemove(currentItemId);

    await this._persistList(listId, record.crdt, [update.op, remove.op]);
    this.emitListChange(listId);
    this.recordHistory({
      scope: { type: "list", listId },
      forwardOps: [
        {
          type: "updateTask",
          listId,
          itemId: previousItemId,
          payload: { text: mergedText },
        },
        {
          type: "removeTask",
          listId,
          itemId: currentItemId,
        },
      ],
      inverseOps: [
        {
          type: "insertTask",
          listId,
          itemId: currentItemId,
          text: currentItem.text,
          done: currentItem.done,
          note: currentItem.note ?? "",
          afterId: neighbors.afterId,
          beforeId: neighbors.beforeId,
          position: currentItem.pos ?? null,
        },
        {
          type: "updateTask",
          listId,
          itemId: previousItemId,
          payload: { text: previousItem.text },
        },
      ],
      label: "merge-task",
      actor: record.crdt.actorId,
    });
    this._textEditSessions.delete(`${listId}:${currentItemId}`);
    this._textUpdateQueue.delete(`${listId}:${currentItemId}`);
    return record.crdt.toListState();
  }

  async updateTask(listId: ListId, itemId: string, payload: TaskUpdateInput = {}) {
    await this.initialize();
    if (Object.prototype.hasOwnProperty.call(payload, "text")) {
      // Keep text updates ordered for this item.
      return this.enqueueTextUpdate(listId, itemId, () =>
        this.updateTaskInternal(listId, itemId, payload)
      );
    }
    return this.updateTaskInternal(listId, itemId, payload);
  }

  private async updateTaskInternal(
    listId: ListId,
    itemId: string,
    payload: TaskUpdateInput = {}
  ) {
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    if (typeof itemId !== "string" || !itemId.length) return null;
    let existing = record.crdt.getSnapshot().find((entry) => entry.id === itemId);
    if (!existing) {
      // If the task was just inserted, wait so we don't drop early edits.
      const pending = this._pendingInserts.get(`${listId}:${itemId}`);
      if (pending) {
        await pending;
        const refreshed = this._listMap.get(listId);
        existing = refreshed?.crdt
          ?.getSnapshot()
          .find((entry) => entry.id === itemId);
      }
    }
    if (!existing) return null;
    const now = Date.now();
    let coalesceKey: string | undefined;
    if (Object.prototype.hasOwnProperty.call(payload, "text")) {
      const previousText = existing.text ?? "";
      const nextText =
        typeof payload.text === "string" ? payload.text : previousText;
      // Coalesce adjacent text edits for native-feeling undo (time/word boundaries).
      coalesceKey = this.getTextEditCoalesceKey({
        listId,
        itemId,
        previousText,
        nextText,
        timestamp: now,
      });
    }
    const result = record.crdt.generateUpdate({
      itemId,
      text: payload.text,
      done: payload.done,
      note: payload.note,
    });
    await this._persistList(listId, record.crdt, [result.op]);
    this.emitListChange(listId);
    const inversePayload: TaskUpdateInput = {};
    if (Object.prototype.hasOwnProperty.call(payload, "text")) {
      inversePayload.text = existing.text;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "done")) {
      inversePayload.done = existing.done;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "note")) {
      inversePayload.note = existing.note ?? "";
    }
    const shouldCoalesce =
      Object.prototype.hasOwnProperty.call(payload, "text") &&
      !Object.prototype.hasOwnProperty.call(payload, "done") &&
      Boolean(coalesceKey);
    this.recordHistory({
      scope: { type: "list", listId },
      forwardOps: [
        {
          type: "updateTask",
          listId,
          itemId,
          payload,
        },
      ],
      inverseOps: [
        {
          type: "updateTask",
          listId,
          itemId,
          payload: inversePayload,
        },
      ],
      label: "update-task",
      actor: record.crdt.actorId,
      coalesceKey: shouldCoalesce ? coalesceKey : undefined,
    });
    return record.crdt.toListState();
  }

  async toggleTask(listId: ListId, itemId: string, explicitState: boolean | null = null) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const existing = record.crdt.getSnapshot().find((entry) => entry.id === itemId);
    if (!existing) return null;
    const nextDone = explicitState == null ? !existing.done : Boolean(explicitState);
    const result = record.crdt.generateToggle(itemId, explicitState);
    await this._persistList(listId, record.crdt, [result.op]);
    this.emitListChange(listId);
    this.recordHistory({
      scope: { type: "list", listId },
      forwardOps: [
        {
          type: "updateTask",
          listId,
          itemId,
          payload: { done: nextDone },
        },
      ],
      inverseOps: [
        {
          type: "updateTask",
          listId,
          itemId,
          payload: { done: existing.done },
        },
      ],
      label: "toggle-task",
      actor: record.crdt.actorId,
    });
    return record.crdt.toListState();
  }

  async removeTask(listId: ListId, itemId: string) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const snapshot = record.crdt.getSnapshot();
    const existing = snapshot.find((entry) => entry.id === itemId);
    if (!existing) return null;
    const order = snapshot.map((entry) => entry.id);
    const neighbors = this.getNeighborIds(order, itemId);
    const result = record.crdt.generateRemove(itemId);
    await this._persistList(listId, record.crdt, [result.op]);
    this.emitListChange(listId);
    this.recordHistory({
      scope: { type: "list", listId },
      forwardOps: [
        {
          type: "removeTask",
          listId,
          itemId,
        },
      ],
      inverseOps: [
        {
          type: "insertTask",
          listId,
          itemId,
          text: existing.text,
          done: existing.done,
          afterId: neighbors.afterId,
          beforeId: neighbors.beforeId,
          position: existing.pos ?? null,
        },
      ],
      label: "remove-task",
      actor: record.crdt.actorId,
    });
    this._textEditSessions.delete(`${listId}:${itemId}`);
    this._textUpdateQueue.delete(`${listId}:${itemId}`);
    return result;
  }

  async moveTaskWithinList(
    listId: ListId,
    itemId: string,
    options: TaskMoveInput = {}
  ) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const snapshot = record.crdt.getSnapshot();
    const existing = snapshot.find((entry) => entry.id === itemId);
    if (!existing) return null;
    const order = snapshot.map((entry) => entry.id);
    const previousNeighbors = this.getNeighborIds(order, itemId);
    const move = record.crdt.generateMove({
      itemId,
      afterId: options.afterId,
      beforeId: options.beforeId,
      position: options.position,
    });
    await this._persistList(listId, record.crdt, [move.op]);
    this.emitListChange(listId);
    this.recordHistory({
      scope: { type: "list", listId },
      forwardOps: [
        {
          type: "moveTaskWithinList",
          listId,
          itemId,
          afterId: options.afterId ?? null,
          beforeId: options.beforeId ?? null,
          position: options.position ?? null,
        },
      ],
      inverseOps: [
        {
          type: "moveTaskWithinList",
          listId,
          itemId,
          afterId: previousNeighbors.afterId,
          beforeId: previousNeighbors.beforeId,
          position: existing.pos ?? null,
        },
      ],
      label: "move-task",
      actor: record.crdt.actorId,
    });
    return record.crdt.toListState();
  }

  async moveTask(
    sourceListId: ListId,
    targetListId: ListId,
    itemId: string,
    options: TaskMoveInput & { snapshot?: TaskItem } = {}
  ) {
    await this.initialize();
    if (!itemId || sourceListId === targetListId) return null;
    const source = this._listMap.get(sourceListId);
    const target = this._listMap.get(targetListId);
    if (!source?.crdt || !target?.crdt) return null;

    const sourceSnapshot = source.crdt.getSnapshot();
    const sourceEntry = sourceSnapshot.find((entry) => entry.id === itemId);
    const itemSnapshot = options.snapshot ?? sourceEntry;
    if (!itemSnapshot || !sourceEntry) return null;
    const sourceOrder = sourceSnapshot.map((entry) => entry.id);
    const sourceNeighbors = this.getNeighborIds(sourceOrder, itemId);

    const remove = source.crdt.generateRemove(itemId);
    const insert = target.crdt.generateInsert({
      itemId,
      text: sanitizeText(itemSnapshot.text),
      done: Boolean(itemSnapshot.done),
      note: sanitizeText(itemSnapshot.note),
      afterId: options.afterId,
      beforeId: options.beforeId,
      position: options.position,
    });

    await Promise.all([
      this._persistList(sourceListId, source.crdt, [remove.op]),
      this._persistList(targetListId, target.crdt, [insert.op]),
    ]);

    this.emitListChange(sourceListId);
    this.emitListChange(targetListId);

    this.recordHistory({
      scope: { type: "list", listId: sourceListId },
      forwardOps: [
        {
          type: "moveTask",
          sourceListId,
          targetListId,
          itemId,
          snapshot: {
            id: itemSnapshot.id,
            text: itemSnapshot.text,
            done: Boolean(itemSnapshot.done),
            note: itemSnapshot.note ?? "",
          },
          afterId: options.afterId ?? null,
          beforeId: options.beforeId ?? null,
          position: options.position ?? null,
        },
      ],
      inverseOps: [
        {
          type: "moveTask",
          sourceListId: targetListId,
          targetListId: sourceListId,
          itemId,
          snapshot: {
            id: itemSnapshot.id,
            text: itemSnapshot.text,
            done: Boolean(itemSnapshot.done),
            note: itemSnapshot.note ?? "",
          },
          afterId: sourceNeighbors.afterId,
          beforeId: sourceNeighbors.beforeId,
          position: sourceEntry.pos ?? null,
        },
      ],
      label: "move-task-between",
      actor: source.crdt.actorId,
    });

    return {
      sourceState: source.crdt.toListState(),
      targetState: target.crdt.toListState(),
    };
  }

  async getTaskSnapshot(listId: ListId, itemId: string) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const snapshot = record.crdt.getSnapshot();
    return snapshot.find((item) => item.id === itemId) ?? null;
  }

  _createListInstance(listId: ListId, state: ListState | null = null) {
    return this._createListCrdt(listId, state, this._identityOptions);
  }

  _persistList(
    listId: ListId,
    crdt: TaskListCRDT,
    ops: TaskListOperation[] = [],
    options: { origin?: "local" | "remote" } = {}
  ) {
    if (!this._storage || !crdt) return Promise.resolve();
    const operations = Array.isArray(ops) ? ops : [];
    const snapshot = crdt.exportState();
    const persist = Promise.resolve(
      this._storage.persistOperations(listId, operations, { snapshot })
    ).catch(() => {});
    if (options.origin !== "remote" && operations.length > 0) {
      persist.then(() => this.queueOpsForSync("list", listId, operations));
    }
    return persist;
  }

  _persistRegistry(
    ops: ListsOperation[] = [],
    options: { origin?: "local" | "remote" } = {}
  ) {
    if (!this._storage) return Promise.resolve();
    const operations = Array.isArray(ops) ? ops : [];
    const snapshot = this._listsCrdt.exportState();
    const persist = Promise.resolve(
      this._storage.persistRegistry({ operations, snapshot })
    ).catch(() => {});
    if (options.origin !== "remote" && operations.length > 0) {
      persist.then(() =>
        this.queueOpsForSync("registry", "registry", operations)
      );
    }
    return persist;
  }

  private queueOpsForSync(
    scope: "registry" | "list",
    resourceId: string,
    operations: (ListsOperation | TaskListOperation)[]
  ) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return;
    }
    if (this._sync) {
      this._sync.enqueueOps(
        scope,
        resourceId,
        operations as (ListsOperation | TaskListOperation)[]
      );
      return;
    }
    if (!this._storage) {
      return;
    }
    // Sync engine can be disabled during transient outages; append operations
    // directly to the durable outbox so they survive and flush on reconnect.
    const pendingOps: SyncOp[] = operations
      .map((op) => ({
        scope,
        resourceId,
        actor: op.actor,
        clock: op.clock,
        payload: op,
      }))
      .filter(
        (op) =>
          typeof op.actor === "string" &&
          op.actor.length > 0 &&
          Number.isFinite(op.clock) &&
          op.clock > 0
      );
    if (pendingOps.length === 0) {
      return;
    }
    this._outboxPersistQueue = this._outboxPersistQueue
      .then(async () => {
        if (!this._storage) {
          return;
        }
        const existing = await this._storage.loadOutbox().catch(() => []);
        const outbox = Array.isArray(existing) ? existing : [];
        await this._storage
          .persistOutbox([...outbox, ...pendingOps])
          .catch(() => {});
      })
      .catch(() => {});
  }

  private enqueueHistoryAction<T>(action: () => Promise<T>) {
    const next = this._historyQueue.then(action, action);
    this._historyQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async flushPendingEdits() {
    const pending = [
      ...this._textUpdateQueue.values(),
      ...this._pendingInserts.values(),
    ];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  private enqueueTextUpdate<T>(
    listId: ListId,
    itemId: string,
    action: () => Promise<T>
  ) {
    const key = `${listId}:${itemId}`;
    const chain = this._textUpdateQueue.get(key) ?? Promise.resolve();
    const next = chain.then(action, action);
    this._textUpdateQueue.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  private async applyHistoryOps(ops: HistoryOp[]) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    this._historySuppressed += 1;
    try {
      for (const op of ops) {
        await this.applyHistoryOp(op);
      }
    } finally {
      this._historySuppressed = Math.max(0, this._historySuppressed - 1);
    }
  }

  private async applyHistoryOp(op: HistoryOp) {
    if (!op) return;
    switch (op.type) {
      case "createList":
        await this.createList({
          listId: op.listId,
          title: op.title,
          items: op.items,
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "removeList":
        await this.removeList(op.listId);
        return;
      case "renameList":
        await this.renameList(op.listId, op.title);
        return;
      case "reorderList":
        await this.reorderList(op.listId, {
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "insertTask":
        await this.insertTask(op.listId, {
          itemId: op.itemId,
          text: op.text,
          done: op.done,
          note: op.note,
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "removeTask":
        await this.removeTask(op.listId, op.itemId);
        return;
      case "updateTask":
        await this.updateTask(op.listId, op.itemId, op.payload);
        return;
      case "moveTaskWithinList":
        await this.moveTaskWithinList(op.listId, op.itemId, {
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "moveTask":
        await this.moveTask(op.sourceListId, op.targetListId, op.itemId, {
          snapshot: op.snapshot,
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      default:
        return;
    }
  }

  private getTextEditCoalesceKey({
    listId,
    itemId,
    previousText,
    nextText,
    timestamp,
  }: {
    listId: ListId;
    itemId: string;
    previousText: string;
    nextText: string;
    timestamp: number;
  }) {
    const key = `${listId}:${itemId}`;
    const session =
      this._textEditSessions.get(key) ?? {
        segmentId: 0,
        lastAt: 0,
        lastText: previousText,
      };
    const gapMs = timestamp - session.lastAt;
    const { inserted, removed } = this.getTextEditDelta(
      session.lastText ?? previousText,
      nextText
    );
    const boundaryPattern = /[\s.,;:!?]/;
    const boundaryChange =
      boundaryPattern.test(inserted) || boundaryPattern.test(removed);
    const longEdit = inserted.length > 1 || removed.length > 1;
    if (gapMs > 1000 || boundaryChange || longEdit) {
      session.segmentId += 1;
    }
    session.lastAt = timestamp;
    session.lastText = nextText;
    this._textEditSessions.set(key, session);
    return `${key}:text:${session.segmentId}`;
  }

  private getTextEditDelta(previous: string, next: string) {
    const prevText = typeof previous === "string" ? previous : "";
    const nextText = typeof next === "string" ? next : "";
    let start = 0;
    while (
      start < prevText.length &&
      start < nextText.length &&
      prevText[start] === nextText[start]
    ) {
      start += 1;
    }
    let endPrev = prevText.length - 1;
    let endNext = nextText.length - 1;
    while (
      endPrev >= start &&
      endNext >= start &&
      prevText[endPrev] === nextText[endNext]
    ) {
      endPrev -= 1;
      endNext -= 1;
    }
    const removed =
      endPrev >= start ? prevText.slice(start, endPrev + 1) : "";
    const inserted =
      endNext >= start ? nextText.slice(start, endNext + 1) : "";
    return { inserted, removed };
  }

  private clearTextEditSessionsForList(listId: ListId) {
    const prefix = `${listId}:`;
    for (const key of this._textEditSessions.keys()) {
      if (key.startsWith(prefix)) {
        this._textEditSessions.delete(key);
      }
    }
  }

  private clearTextUpdateQueueForList(listId: ListId) {
    const prefix = `${listId}:`;
    for (const key of this._textUpdateQueue.keys()) {
      if (key.startsWith(prefix)) {
        this._textUpdateQueue.delete(key);
      }
    }
  }

  private clearPendingInsertsForList(listId: ListId) {
    const prefix = `${listId}:`;
    for (const key of this._pendingInserts.keys()) {
      if (key.startsWith(prefix)) {
        this._pendingInserts.delete(key);
      }
    }
  }
}
