import { ListsCRDT } from "../domain/crdt/lists-crdt.js";
import { TaskListCRDT } from "../domain/crdt/task-list-crdt.js";
import { createListStorage } from "../storage/list-storage.js";
import { hydrateFromStorage } from "../storage/hydrator.js";
import type {
  ListCreateInput,
  ListId,
  ListRegistryEntry,
  ListState,
  ListReorderInput,
  TaskInsertInput,
  TaskItem,
  TaskListState,
  TaskMoveInput,
  TaskUpdateInput,
} from "../types/domain.js";
import type { ListStorage } from "../types/storage.js";
import type { TaskListOperation, ListsOperation } from "../types/crdt.js";
import { HistoryManager } from "./history-manager.js";
import type { HistoryOp, HistoryScope } from "./history-types.js";

type ListRecord = { crdt: TaskListCRDT };
type StorageOptions = Record<string, unknown>;
type StorageFactory = (options?: StorageOptions) => Promise<ListStorage>;
type ListFactory = (listId: ListId, state?: ListState | null) => TaskListCRDT;
type RegistryListener = (snapshot: ListRegistryEntry[]) => void;
type ListListener = (state: TaskListState) => void;
type GlobalListener =
  | { type: "registry"; snapshot: ListRegistryEntry[] }
  | { type: "list"; listId: ListId; state: TaskListState };

function defaultListFactory(_listId: ListId, state: ListState | null = null) {
  return new TaskListCRDT({
    title: state?.title ?? "",
    titleUpdatedAt: state?.titleUpdatedAt ?? 0,
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
  private _listsCrdt: ListsCRDT;
  private _createListCrdt: ListFactory;
  private _storageFactory: StorageFactory;
  private _storageOptions: StorageOptions;
  private _storage: ListStorage | null;
  private _listMap: Map<ListId, ListRecord>;
  private _registryListeners: Set<RegistryListener>;
  private _listListeners: Map<ListId, Set<ListListener>>;
  private _globalListeners: Set<(payload: GlobalListener) => void>;
  private _history: HistoryManager;
  private _historySuppressed: number;
  private _initialized: boolean;
  private _initializing: Promise<void> | null;
  private _unsubscribeRegistry: (() => void) | null;

  constructor(
    options: {
      listsCrdt?: ListsCRDT;
      listsCrdtOptions?: { actorId?: string };
      createListCrdt?: ListFactory;
      storageFactory?: StorageFactory;
      storageOptions?: StorageOptions;
    } = {}
  ) {
    this._listsCrdt =
      options.listsCrdt ?? new ListsCRDT(options.listsCrdtOptions);
    this._createListCrdt = options.createListCrdt ?? defaultListFactory;
    this._storageFactory = options.storageFactory ?? createListStorage;
    this._storageOptions = options.storageOptions ?? {};

    this._storage = null;
    this._listMap = new Map();
    this._registryListeners = new Set();
    this._listListeners = new Map();
    this._globalListeners = new Set();
    this._history = new HistoryManager();
    this._historySuppressed = 0;
    this._initialized = false;
    this._initializing = null;
    this._unsubscribeRegistry = null;
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
    await this.initialize();
    const entry = this._history.undo();
    if (!entry) return false;
    await this.applyHistoryOps(entry.inverseOps);
    return true;
  }

  async redo() {
    await this.initialize();
    const entry = this._history.redo();
    if (!entry) return false;
    await this.applyHistoryOps(entry.forwardOps);
    return true;
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
  }

  dispose() {
    this._unsubscribeRegistry?.();
    this._unsubscribeRegistry = null;
    this._registryListeners.clear();
    this._listListeners.clear();
    this._globalListeners.clear();
    this._storage = null;
    this._listMap.clear();
    this._history.clear();
    this._historySuppressed = 0;
    this._initialized = false;
    this._initializing = null;
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
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const itemId = ensureId(options.itemId, `${listId}-item`);
    const text = sanitizeText(options.text);
    const done = options.done == null ? false : Boolean(options.done);
    const insert = record.crdt.generateInsert({
      itemId,
      text,
      done,
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
  }

  async updateTask(listId: ListId, itemId: string, payload: TaskUpdateInput = {}) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    if (typeof itemId !== "string" || !itemId.length) return null;
    const existing = record.crdt.getSnapshot().find((entry) => entry.id === itemId);
    if (!existing) return null;
    const result = record.crdt.generateUpdate({
      itemId,
      text: payload.text,
      done: payload.done,
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
    const shouldCoalesce =
      Object.prototype.hasOwnProperty.call(payload, "text") &&
      !Object.prototype.hasOwnProperty.call(payload, "done");
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
      coalesceKey: shouldCoalesce ? `${listId}:${itemId}:update` : undefined,
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
    return this._createListCrdt(listId, state);
  }

  _persistList(
    listId: ListId,
    crdt: TaskListCRDT,
    ops: TaskListOperation[] = []
  ) {
    if (!this._storage || !crdt) return Promise.resolve();
    const operations = Array.isArray(ops) ? ops : [];
    const snapshot = crdt.exportState();
    return Promise.resolve(
      this._storage.persistOperations(listId, operations, { snapshot })
    ).catch(() => {});
  }

  _persistRegistry(ops: ListsOperation[] = []) {
    if (!this._storage) return Promise.resolve();
    const operations = Array.isArray(ops) ? ops : [];
    const snapshot = this._listsCrdt.exportState();
    return Promise.resolve(
      this._storage.persistRegistry({ operations, snapshot })
    ).catch(() => {});
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
}
