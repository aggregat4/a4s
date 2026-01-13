import { ListsCRDT } from "../crdt/lists-crdt.js";
import { TaskListCRDT } from "../crdt/task-list-crdt.js";
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
} from "../../types/domain.js";
import type { ListStorage } from "../../types/storage.js";
import type { TaskListOperation, ListsOperation } from "../../types/crdt.js";

type ListRecord = { crdt: TaskListCRDT };
type StorageOptions = Record<string, unknown>;
type StorageFactory = (options?: StorageOptions) => Promise<ListStorage>;
type ListFactory = (listId: ListId, state?: ListState | null) => TaskListCRDT;
type RegistryListener = (snapshot: ListRegistryEntry[]) => void;
type ListListener = (state: TaskListState) => void;
type GlobalListener =
  | { type: "registry"; snapshot: ListRegistryEntry[] }
  | { type: "list"; listId: ListId; state: TaskListState };

function defaultListFactory(listId: ListId, state: ListState | null = null) {
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
    this._initialized = false;
    this._initializing = null;
    this._unsubscribeRegistry = null;
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

    return { id: listId, state: listCrdt.toListState() };
  }

  async removeList(listId: ListId) {
    await this.initialize();
    if (!this._listMap.has(listId)) return false;
    const removeResult = this._listsCrdt.generateRemove(listId);
    this._listMap.delete(listId);
    await this._persistRegistry([removeResult.op]);
    this.emitRegistryChange();
    this.emitListChange(listId);
    return true;
  }

  async renameList(listId: ListId, title: string) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const nextTitle = sanitizeText(title);
    const renameTask = record.crdt.generateRename(nextTitle);
    const renameRegistry = this._listsCrdt.generateRename(listId, nextTitle);
    await Promise.all([
      this._persistList(listId, record.crdt, [renameTask.op]),
      this._persistRegistry([renameRegistry.op]),
    ]);
    this.emitRegistryChange();
    this.emitListChange(listId);
    return record.crdt.toListState();
  }

  async reorderList(
    listId: ListId,
    { afterId = null, beforeId = null }: ListReorderInput = {}
  ) {
    await this.initialize();
    const targetId =
      typeof listId === "string" && listId.length ? listId : null;
    if (!targetId || !this._listMap.has(targetId)) return null;
    const reorder = this._listsCrdt.generateReorder({
      listId: targetId,
      afterId,
      beforeId,
    });
    await this._persistRegistry([reorder.op]);
    this.emitRegistryChange();
    return reorder.snapshot;
  }

  async insertTask(listId: ListId, options: TaskInsertInput = {}) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const itemId = ensureId(options.itemId, `${listId}-item`);
    const insert = record.crdt.generateInsert({
      itemId,
      text: sanitizeText(options.text),
      done: options.done == null ? false : Boolean(options.done),
      afterId: options.afterId,
      beforeId: options.beforeId,
      position: options.position,
    });
    await this._persistList(listId, record.crdt, [insert.op]);
    this.emitListChange(listId);
    return { id: itemId, state: record.crdt.toListState() };
  }

  async updateTask(listId: ListId, itemId: string, payload: TaskUpdateInput = {}) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    if (typeof itemId !== "string" || !itemId.length) return null;
    const result = record.crdt.generateUpdate({
      itemId,
      text: payload.text,
      done: payload.done,
    });
    await this._persistList(listId, record.crdt, [result.op]);
    this.emitListChange(listId);
    return record.crdt.toListState();
  }

  async toggleTask(listId: ListId, itemId: string, explicitState: boolean | null = null) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const result = record.crdt.generateToggle(itemId, explicitState);
    await this._persistList(listId, record.crdt, [result.op]);
    this.emitListChange(listId);
    return record.crdt.toListState();
  }

  async removeTask(listId: ListId, itemId: string) {
    await this.initialize();
    const record = this._listMap.get(listId);
    if (!record?.crdt) return null;
    const result = record.crdt.generateRemove(itemId);
    await this._persistList(listId, record.crdt, [result.op]);
    this.emitListChange(listId);
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
    const move = record.crdt.generateMove({
      itemId,
      afterId: options.afterId,
      beforeId: options.beforeId,
      position: options.position,
    });
    await this._persistList(listId, record.crdt, [move.op]);
    this.emitListChange(listId);
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

    const itemSnapshot =
      options.snapshot ??
      source.crdt.getSnapshot().find((entry) => entry.id === itemId);
    if (!itemSnapshot) return null;

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
}
