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
import type { SyncStatus } from "../types/sync.js";
import { HistoryManager } from "./history-manager.js";
import type { HistoryAvailability } from "./history-manager.js";
import type { HistoryOp, HistoryScope } from "./history-types.js";
import { SyncEngine } from "./sync-engine.js";
import { Outbox } from "./outbox.js";
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

type TaskEntry = ReturnType<TaskListCRDT["getSnapshot"]>[number];

/** A task of a list, with its neighbours, if the list has it. */
function taskAt(crdt: TaskListCRDT, itemId: string) {
  const snapshot = crdt.getSnapshot();
  const index = snapshot.findIndex((entry) => entry.id === itemId);
  if (!itemId || index === -1) return null;
  return {
    item: snapshot[index],
    afterId: snapshot[index - 1]?.id ?? null,
    beforeId: snapshot[index + 1]?.id ?? null,
  };
}

/** The operation that puts a task back where and as it was. */
function reinsertTaskOp(
  listId: ListId,
  { item, afterId, beforeId }: { item: TaskEntry; afterId: string | null; beforeId: string | null }
): HistoryOp {
  return {
    type: "insertTask",
    listId,
    itemId: item.id,
    text: item.text,
    done: item.done,
    note: item.note ?? "",
    afterId,
    beforeId,
    position: item.pos ?? null,
  };
}

// Text edits to the same task less than this far apart, within a word, merge
// into one undo step.
const TEXT_EDIT_MERGE_WINDOW_MS = 1000;

export class ListRepository {
  /*
    Local changes are async: each one saves to storage before it records its
    undo step, and on a slow device saving lags behind the user (typed text is
    saved keystroke by keystroke). _changeQueue runs them one at a time, in the
    order they were requested, with undo and redo in the same queue. So every
    change sees the result of the ones before it, the undo history is in the
    order of the user's actions, and an undo applies to the last change made
    before it. Public methods queue the change; the matching *Internal methods
    do the work, and undo and redo replay history through those directly.
    Remote operations from sync and the bootstrap snapshot are merged by the
    CRDTs and record no history, so they do not use the queue.
    Coalescing groups adjacent text edits into a single undo step based on time
    gaps and word boundaries for a native editor feel.

    Local operations go to the outbox (`Outbox`), the only writer of the
    stored outbox, whether sync is on or not. While sync is on, `SyncEngine`
    sends the outbox to the server and drops what the server confirmed.
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
  /** Local changes and undo/redo, run one at a time; see the class comment. */
  private _changeQueue: Promise<void>;
  /** Per task, the last text edit, to decide whether the next one merges into its undo step. */
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
  private _syncStatusHandler: ((status: SyncStatus) => void) | null;
  /** This device's operations the sync server has not confirmed yet. */
  private _outbox: Outbox | null;
  private _now: () => number;

  constructor(
    options: {
      listsCrdt?: ListsCRDT;
      listsCrdtOptions?: { actorId?: string; identityOptions?: { storageKey?: string; storage?: Storage } };
      createListCrdt?: ListFactory;
      storageFactory?: StorageFactory;
      storageOptions?: StorageOptions;
      sync?: SyncOptions | null;
      /** Current time in ms; decides which text edits merge into one undo step. */
      now?: () => number;
    } = {}
  ) {
    this._now = options.now ?? Date.now;
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
    this._history = new HistoryManager({ windowMs: TEXT_EDIT_MERGE_WINDOW_MS });
    this._historySuppressed = 0;
    this._changeQueue = Promise.resolve();
    this._textEditSessions = new Map();
    this._initialized = false;
    this._initializing = null;
    this._unsubscribeRegistry = null;
    this._sync = null;
    this._syncErrorHandler = null;
    this._syncStatusHandler = null;
    this._outbox = null;
  }

  recordHistory({
    scope,
    forwardOps,
    inverseOps,
    label,
    actor,
    coalesceKey,
    timestamp = this._now(),
  }: {
    scope: HistoryScope;
    forwardOps: HistoryOp[];
    inverseOps: HistoryOp[];
    label?: string;
    actor?: string;
    coalesceKey?: string;
    /** When the change was made; decides which text edits merge. */
    timestamp?: number;
  }) {
    if (this._historySuppressed > 0) return;
    this._history.record({
      scope,
      forwardOps,
      inverseOps,
      label,
      actor,
      coalesceKey,
      timestamp,
    });
  }

  canUndo() {
    return this._history.canUndo();
  }

  canRedo() {
    return this._history.canRedo();
  }

  /** Calls the handler now and whenever undo or redo availability changes. */
  subscribeHistory(handler: (state: HistoryAvailability) => void) {
    if (typeof handler !== "function") return () => {};
    return this._history.subscribe(handler);
  }

  async undo() {
    return this.enqueueChange(async () => {
      await this.initialize();
      const entry = this._history.undo();
      if (!entry) return false;
      await this.applyHistoryOps(entry.inverseOps);
      this._textEditSessions.clear();
      return true;
    });
  }

  async redo() {
    return this.enqueueChange(async () => {
      await this.initialize();
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
    this._outbox = new Outbox(this._storage);
    await this._outbox.load();

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
    this._syncStatusHandler = null;
    this._outbox = null;
    this._listMap.clear();
    this._history.clear();
    this._historySuppressed = 0;
    this._textEditSessions.clear();
    this._changeQueue = Promise.resolve();
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
    if (!this._storage) return null;
    this._sync = new SyncEngine({
      storage: this._storage,
      outbox: this._outbox ?? undefined,
      baseUrl: normalized,
      onRemoteOps: async (ops) => this.applyRemoteOps(ops),
      onSnapshot: async ({ snapshot }) => {
        if (!(await this.applySnapshotBlob(snapshot))) {
          throw new Error("Server snapshot could not be applied");
        }
      },
      onConnectionError: (error) => {
        this._syncErrorHandler?.(error);
        this.disableSync();
      },
      onStatusChange: (status) => {
        this._syncStatusHandler?.(status);
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

  /**
   * Register a listener for connectivity changes (connected/disconnected). The
   * closure is threaded into every SyncEngine the monitor (re)creates, so the
   * UI keeps receiving status across engine teardown/recreation.
   */
  setSyncStatusChange(handler: ((status: SyncStatus) => void) | null) {
    this._syncStatusHandler = handler;
  }

  /**
   * Force any buffered outbox ops to the server immediately, bypassing the
   * engine's debounce. Backs the Ctrl/Cmd+S "save now" shortcut.
   */
  async flushSync() {
    // Changes still queued reach the outbox only once they are saved.
    await this._changeQueue;
    if (this._sync) {
      await this._sync.flushOnce();
    }
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

  /**
   * A list's title and tasks. The registry announces a list before its own
   * state arrives, as after an import or from another device; until then the
   * list has the registry's title.
   */
  getListState(listId: ListId): TaskListState {
    const state = toListState(this._listMap.get(listId));
    if (state.title) return state;
    return { ...state, title: this._listsCrdt.getRecord(listId)?.title ?? "" };
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

  async replaceWithSnapshot(snapshot: {
    registryState: RegistryState;
    lists: Array<{ listId: ListId; state: ListState }>;
    snapshotText?: string;
    publishSnapshot?: boolean;
  }): Promise<{ published: boolean; error?: string } | null> {
    // After the changes already queued, which it replaces.
    return this.enqueueChange(() => this.replaceWithSnapshotInternal(snapshot));
  }

  private async replaceWithSnapshotInternal({
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
    if (!this._storage) return null;

    this._sync?.stop();

    const existingSync = await this._storage.loadSyncState();
    const clientId =
      existingSync.clientId && existingSync.clientId.length
        ? existingSync.clientId
        : ensureActorId();
    const datasetGenerationKey =
      typeof existingSync.datasetGenerationKey === "string"
        ? existingSync.datasetGenerationKey
        : "";

    await this._storage.clear();
    await this._storage.persistSyncState({
      clientId,
      lastServerSeq: 0,
      datasetGenerationKey,
    });
    await this._outbox?.clear();
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
    } else if (publishSnapshot) {
      publishResult = {
        published: false,
        error: "Snapshot imported on this device only. Sync is unavailable; reconnect and import again to update other devices.",
      };
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
    const listeners = this._listListeners.get(key)!;
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
              // The list's data stays; see removeListInternal.
              this.clearTextEditSessionsForList(payload.listId);
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
    return this.enqueueChange(() => this.createListInternal(options));
  }

  private async createListInternal(options: ListCreateInput = {}) {
    await this.initialize();
    const listId = ensureId(options.listId, "list");
    const title = sanitizeText(options.title);
    let afterId =
      typeof options.afterId === "string" && options.afterId.length
        ? options.afterId
        : null;
    const beforeId =
      typeof options.beforeId === "string" && options.beforeId.length
        ? options.beforeId
        : null;
    const position =
      Array.isArray(options.position) && options.position.length
        ? options.position
        : null;

    if (this._listMap.has(listId)) {
      return { id: listId, state: this.getListState(listId) };
    }

    // Without explicit neighbors a bare midpoint position collides with the
    // first list. Default to appending after the last visible list instead.
    if (!afterId && !beforeId && !position) {
      const visible = this._listsCrdt.getVisibleLists();
      afterId = visible.length ? visible[visible.length - 1].id : null;
    }

    const createResult = this._listsCrdt.generateCreate({
      listId,
      title,
      afterId,
      beforeId,
      position,
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
      let previousId: string | null = null;
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
      // Undo hides the new list and keeps its data, so redo shows it again.
      forwardOps: [
        {
          type: "restoreList",
          listId,
          title,
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
    return this.enqueueChange(() => this.removeListInternal(listId));
  }

  private async removeListInternal(listId: ListId) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return false;
    const registryRecord = this._listsCrdt.getRecord(listId);
    const listState = record.crdt.toListState();
    const registryOrder = this.getRegistrySnapshot().map((entry) => entry.id);
    const { afterId, beforeId } = this.getNeighborIds(registryOrder, listId);
    // The list's tasks and history stay: deleting only hides the list in the
    // registry, and undo shows it again with everything intact.
    const removeResult = this._listsCrdt.generateRemove(listId);
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
          type: "restoreList",
          listId,
          title: listState.title,
          afterId,
          beforeId,
          position: registryRecord?.pos ?? null,
        },
      ],
      label: "remove-list",
      actor: this._listsCrdt.actorId,
    });
    this.clearTextEditSessionsForList(listId);
    return true;
  }

  /**
   * Shows a deleted list again, at its previous place, with its tasks and
   * history as they were. Only used to undo a deletion, so it records no
   * undo step of its own.
   */
  private async restoreListInternal({
    listId,
    title,
    afterId = null,
    beforeId = null,
    position = null,
  }: {
    listId: ListId;
    title: string;
    afterId?: ListId | null;
    beforeId?: ListId | null;
    position?: Position | null;
  }) {
    await this.initialize();
    if (!this._listMap.has(listId)) return false;
    const restore = this._listsCrdt.generateCreate({
      listId,
      title,
      afterId,
      beforeId,
      position,
    });
    await this._persistRegistry([restore.op]);
    this.emitRegistryChange();
    this.emitListChange(listId);
    return true;
  }

  async renameList(listId: ListId, title: string) {
    // Renames typed live merge into one undo step; see updateTask.
    const renamedAt = this._now();
    return this.enqueueChange(() =>
      this.renameListInternal(listId, title, renamedAt)
    );
  }

  private async renameListInternal(
    listId: ListId,
    title: string,
    renamedAt = this._now()
  ) {
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
        timestamp: renamedAt,
      });
    }
    return record.crdt.toListState();
  }

  async reorderList(listId: ListId, options: ListReorderInput = {}) {
    return this.enqueueChange(() => this.reorderListInternal(listId, options));
  }

  private async reorderListInternal(
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
    return this.enqueueChange(() => this.insertTaskInternal(listId, options));
  }

  private async insertTaskInternal(
    listId: ListId,
    options: TaskInsertInput = {}
  ) {
    const itemId = ensureId(options.itemId, `${listId}-item`);
    const crdt = await this.listCrdt(listId);
    if (!crdt) return null;
    const text = sanitizeText(options.text);
    const done = options.done == null ? false : Boolean(options.done);
    const note = sanitizeText(options.note);
    const insert = crdt.generateInsert({
      itemId,
      text,
      done,
      note,
      afterId: options.afterId,
      beforeId: options.beforeId,
      position: options.position,
    });
    await this.saveListChange(listId, crdt, [insert.op], {
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
      inverseOps: [{ type: "removeTask", listId, itemId }],
      label: "insert-task",
    });
    return { id: itemId, state: crdt.toListState() };
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
    return this.enqueueChange(() =>
      this.splitTaskInternal(listId, itemId, newItemId, options)
    );
  }

  private async splitTaskInternal(
    listId: ListId,
    itemId: string,
    newItemId: string,
    options: {
      beforeText: string;
      afterText: string;
      previousText: string;
      afterId?: string | null;
      beforeId?: string | null;
      position?: Position | null;
    }
  ) {
    const crdt = await this.listCrdt(listId);
    if (!crdt || !taskAt(crdt, itemId)) return null;
    const beforeText = sanitizeText(options.beforeText);
    const afterText = sanitizeText(options.afterText);
    const previousText = sanitizeText(options.previousText);
    const update = crdt.generateUpdate({
      itemId,
      text: beforeText,
    });
    const insert = crdt.generateInsert({
      itemId: newItemId,
      text: afterText,
      done: false,
      note: "",
      afterId: options.afterId ?? null,
      beforeId: options.beforeId ?? null,
      position: options.position ?? null,
    });
    await this.saveListChange(listId, crdt, [update.op, insert.op], {
      forwardOps: [
        { type: "updateTask", listId, itemId, payload: { text: beforeText } },
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
        { type: "removeTask", listId, itemId: newItemId },
        { type: "updateTask", listId, itemId, payload: { text: previousText } },
      ],
      label: "split-task",
    });
    return { id: newItemId, state: crdt.toListState() };
  }

  async mergeTask(
    listId: ListId,
    previousItemId: string,
    currentItemId: string,
    options: { mergedText: string }
  ) {
    if (!previousItemId || !currentItemId) return null;
    if (previousItemId === currentItemId) return null;
    return this.enqueueChange(() =>
      this.mergeTaskInternal(listId, previousItemId, currentItemId, options)
    );
  }

  private async mergeTaskInternal(
    listId: ListId,
    previousItemId: string,
    currentItemId: string,
    options: { mergedText: string }
  ) {
    const crdt = await this.listCrdt(listId);
    if (!crdt) return null;
    const previous = taskAt(crdt, previousItemId);
    const current = taskAt(crdt, currentItemId);
    if (!previous || !current) return null;

    const mergedText = sanitizeText(options?.mergedText);
    const update = crdt.generateUpdate({
      itemId: previousItemId,
      text: mergedText,
    });
    const remove = crdt.generateRemove(currentItemId);

    await this.saveListChange(listId, crdt, [update.op, remove.op], {
      forwardOps: [
        { type: "updateTask", listId, itemId: previousItemId, payload: { text: mergedText } },
        { type: "removeTask", listId, itemId: currentItemId },
      ],
      inverseOps: [
        reinsertTaskOp(listId, current),
        {
          type: "updateTask",
          listId,
          itemId: previousItemId,
          payload: { text: previous.item.text },
        },
      ],
      label: "merge-task",
    });
    this._textEditSessions.delete(`${listId}:${currentItemId}`);
    return crdt.toListState();
  }

  async updateTask(listId: ListId, itemId: string, payload: TaskUpdateInput = {}) {
    // The time of the edit, not of saving it: queued edits can be saved in a
    // burst, and keystrokes a pause apart must stay separate undo steps.
    const editedAt = this._now();
    return this.enqueueChange(() =>
      this.updateTaskInternal(listId, itemId, payload, editedAt)
    );
  }

  private async updateTaskInternal(
    listId: ListId,
    itemId: string,
    payload: TaskUpdateInput = {},
    editedAt = this._now()
  ) {
    const crdt = await this.listCrdt(listId);
    const existing = crdt ? taskAt(crdt, itemId)?.item : null;
    if (!crdt || !existing) return null;
    const has = (field: keyof TaskUpdateInput) =>
      Object.prototype.hasOwnProperty.call(payload, field);
    let coalesceKey: string | undefined;
    if (has("text")) {
      const previousText = existing.text ?? "";
      const nextText =
        typeof payload.text === "string" ? payload.text : previousText;
      // Coalesce adjacent text edits for native-feeling undo (time/word boundaries).
      coalesceKey = this.getTextEditCoalesceKey({
        listId,
        itemId,
        previousText,
        nextText,
        timestamp: editedAt,
      });
    }
    const result = crdt.generateUpdate({
      itemId,
      text: payload.text,
      done: payload.done,
      note: payload.note,
    });
    const inversePayload: TaskUpdateInput = {};
    if (has("text")) inversePayload.text = existing.text;
    if (has("done")) inversePayload.done = existing.done;
    if (has("note")) inversePayload.note = existing.note ?? "";
    await this.saveListChange(listId, crdt, [result.op], {
      forwardOps: [{ type: "updateTask", listId, itemId, payload }],
      inverseOps: [{ type: "updateTask", listId, itemId, payload: inversePayload }],
      label: "update-task",
      coalesceKey: has("text") && !has("done") ? coalesceKey : undefined,
      timestamp: editedAt,
    });
    return crdt.toListState();
  }

  async toggleTask(
    listId: ListId,
    itemId: string,
    explicitState: boolean | null = null
  ) {
    return this.enqueueChange(() =>
      this.toggleTaskInternal(listId, itemId, explicitState)
    );
  }

  private async toggleTaskInternal(
    listId: ListId,
    itemId: string,
    explicitState: boolean | null = null
  ) {
    const crdt = await this.listCrdt(listId);
    const existing = crdt ? taskAt(crdt, itemId)?.item : null;
    if (!crdt || !existing) return null;
    const nextDone = explicitState == null ? !existing.done : Boolean(explicitState);
    const result = crdt.generateToggle(itemId, explicitState);
    await this.saveListChange(listId, crdt, [result.op], {
      forwardOps: [{ type: "updateTask", listId, itemId, payload: { done: nextDone } }],
      inverseOps: [{ type: "updateTask", listId, itemId, payload: { done: existing.done } }],
      label: "toggle-task",
    });
    return crdt.toListState();
  }

  async removeTask(listId: ListId, itemId: string) {
    return this.enqueueChange(() => this.removeTaskInternal(listId, itemId));
  }

  private async removeTaskInternal(listId: ListId, itemId: string) {
    const crdt = await this.listCrdt(listId);
    const existing = crdt ? taskAt(crdt, itemId) : null;
    if (!crdt || !existing) return null;
    const result = crdt.generateRemove(itemId);
    await this.saveListChange(listId, crdt, [result.op], {
      forwardOps: [{ type: "removeTask", listId, itemId }],
      inverseOps: [reinsertTaskOp(listId, existing)],
      label: "remove-task",
    });
    this._textEditSessions.delete(`${listId}:${itemId}`);
    return result;
  }

  async moveTaskWithinList(
    listId: ListId,
    itemId: string,
    options: TaskMoveInput = {}
  ) {
    return this.enqueueChange(() =>
      this.moveTaskWithinListInternal(listId, itemId, options)
    );
  }

  private async moveTaskWithinListInternal(
    listId: ListId,
    itemId: string,
    options: TaskMoveInput = {}
  ) {
    const crdt = await this.listCrdt(listId);
    const existing = crdt ? taskAt(crdt, itemId) : null;
    if (!crdt || !existing) return null;
    const move = crdt.generateMove({
      itemId,
      afterId: options.afterId,
      beforeId: options.beforeId,
      position: options.position,
    });
    await this.saveListChange(listId, crdt, [move.op], {
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
          afterId: existing.afterId,
          beforeId: existing.beforeId,
          position: existing.item.pos ?? null,
        },
      ],
      label: "move-task",
    });
    return crdt.toListState();
  }

  async moveTask(
    sourceListId: ListId,
    targetListId: ListId,
    itemId: string,
    options: TaskMoveInput & { snapshot?: TaskItem } = {}
  ) {
    if (!itemId || sourceListId === targetListId) return null;
    return this.enqueueChange(() =>
      this.moveTaskInternal(sourceListId, targetListId, itemId, options)
    );
  }

  private async moveTaskInternal(
    sourceListId: ListId,
    targetListId: ListId,
    itemId: string,
    options: TaskMoveInput & { snapshot?: TaskItem } = {}
  ) {
    await this.initialize();
    const source = this._listMap.get(sourceListId);
    const target = this._listMap.get(targetListId);
    if (!source?.crdt || !target?.crdt) return null;

    const sourceTask = taskAt(source.crdt, itemId);
    const itemSnapshot = options.snapshot ?? sourceTask?.item;
    if (!itemSnapshot || !sourceTask) return null;

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
          afterId: sourceTask.afterId,
          beforeId: sourceTask.beforeId,
          position: sourceTask.item.pos ?? null,
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

  /** A list's CRDT, once the repository is initialized, if it has the list. */
  private async listCrdt(listId: ListId) {
    await this.initialize();
    return this._listMap.get(listId)?.crdt ?? null;
  }

  /**
   * Saves operations on a list, tells the list's listeners, and records the
   * change as an undo step of this device's user.
   */
  private async saveListChange(
    listId: ListId,
    crdt: TaskListCRDT,
    ops: TaskListOperation[],
    step: {
      forwardOps: HistoryOp[];
      inverseOps: HistoryOp[];
      label: string;
      coalesceKey?: string;
      timestamp?: number;
    }
  ) {
    await this._persistList(listId, crdt, ops);
    this.emitListChange(listId);
    this.recordHistory({ scope: { type: "list", listId }, actor: crdt.actorId, ...step });
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
    );
    if (options.origin !== "remote" && operations.length > 0) {
      return persist.then(() => this.queueOpsForSync("list", listId, operations));
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
    );
    if (options.origin !== "remote" && operations.length > 0) {
      return persist.then(() =>
        this.queueOpsForSync("registry", "registry", operations)
      );
    }
    return persist;
  }

  /** Adds local operations to the outbox, and sends them soon while sync is on. */
  private queueOpsForSync(
    scope: "registry" | "list",
    resourceId: string,
    operations: (ListsOperation | TaskListOperation)[]
  ) {
    if (this._sync) return this._sync.enqueueOps(scope, resourceId, operations);
    return this._outbox?.add(scope, resourceId, operations);
  }

  /** Runs a local change after the ones already requested; see the class comment. */
  private enqueueChange<T>(change: () => Promise<T>): Promise<T> {
    const next = this._changeQueue.then(change, change);
    this._changeQueue = next.then(
      (): void => undefined,
      (): void => undefined
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

  // Runs inside the change queue (from undo/redo), so it calls the internal
  // methods: queueing would wait for the undo itself.
  private async applyHistoryOp(op: HistoryOp) {
    if (!op) return;
    switch (op.type) {
      case "createList":
        await this.createListInternal({
          listId: op.listId,
          title: op.title,
          items: op.items,
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "removeList":
        await this.removeListInternal(op.listId);
        return;
      case "restoreList":
        await this.restoreListInternal(op);
        return;
      case "renameList":
        await this.renameListInternal(op.listId, op.title);
        return;
      case "reorderList":
        await this.reorderListInternal(op.listId, {
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "insertTask":
        await this.insertTaskInternal(op.listId, {
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
        await this.removeTaskInternal(op.listId, op.itemId);
        return;
      case "updateTask":
        await this.updateTaskInternal(op.listId, op.itemId, op.payload);
        return;
      case "moveTaskWithinList":
        await this.moveTaskWithinListInternal(op.listId, op.itemId, {
          afterId: op.afterId ?? null,
          beforeId: op.beforeId ?? null,
          position: op.position ?? null,
        });
        return;
      case "moveTask":
        await this.moveTaskInternal(op.sourceListId, op.targetListId, op.itemId, {
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
    if (gapMs > TEXT_EDIT_MERGE_WINDOW_MS || boundaryChange || longEdit) {
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

}
