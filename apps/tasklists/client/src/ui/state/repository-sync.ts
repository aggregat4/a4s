import { APP_ACTIONS } from "./app-store.js";
import type { ListId, ListRegistryEntry, TaskListState } from "../../types/domain.js";

type Repository = {
  initialize: () => Promise<unknown>;
  subscribeRegistry: (
    handler: (snapshot: ListRegistryEntry[]) => void,
    options?: { emitCurrent?: boolean }
  ) => () => void;
  getRegistrySnapshot: () => ListRegistryEntry[];
  getListState: (listId: ListId) => TaskListState;
};

type Registry = {
  createList: (config: {
    id?: ListId;
    title?: string;
    items?: TaskListState["items"];
  }) => { id: ListId; name: string; totalCount: number; matchCount: number } | null;
  getRecordIds: () => ListId[];
  removeList: (id: ListId) => void;
  has: (id: ListId) => boolean;
  setListOrder: (order: ListId[]) => void;
};

type AppStateSlice = {
  pendingActiveListId: ListId | null;
  activeListId: ListId | null;
};

type Store = {
  getState: () => AppStateSlice;
  dispatch: (action: { type: string; payload?: unknown }) => void;
};

class RepositorySync {
  private repository: Repository;
  private registry: Registry;
  private store: Store;
  private registryUnsubscribe: (() => void) | null;

  constructor({
    repository,
    registry,
    store,
  }: {
    repository: Repository;
    registry: Registry;
    store: Store;
  }) {
    this.repository = repository;
    this.registry = registry;
    this.store = store;
    this.registryUnsubscribe = null;
  }

  async initialize() {
    await this.repository.initialize();
    if (!this.registryUnsubscribe) {
      this.registryUnsubscribe = this.repository.subscribeRegistry(
        (snapshot) => this.handleRegistryChange(snapshot),
        { emitCurrent: false }
      );
    }
    this.handleRegistryChange(this.repository.getRegistrySnapshot());
  }

  dispose() {
    if (this.registryUnsubscribe) {
      this.registryUnsubscribe();
      this.registryUnsubscribe = null;
    }
  }

  handleRegistryChange(snapshot: ListRegistryEntry[] = []) {
    if (!Array.isArray(snapshot)) return;
    const seen = new Set<ListId>();
    const listMeta: Array<{
      id: ListId;
      name: string;
      totalCount: number;
      matchCount: number;
    }> = [];
    snapshot.forEach((entry) => {
      const listId = entry?.id;
      if (!listId) return;
      const state = this.repository.getListState(listId);
      const titleCandidate = state?.title ?? entry.title ?? "";
      const record = this.registry.createList({
        id: listId,
        title: titleCandidate,
        items: state?.items ?? [],
      });
      if (record) {
        const normalized = titleCandidate?.trim?.() ?? "";
        record.name = normalized.length ? normalized : "Untitled List";
        listMeta.push({
          id: record.id,
          name: record.name,
          totalCount: record.totalCount,
          matchCount: record.matchCount,
        });
        this.store.dispatch({
          type: APP_ACTIONS.upsertList,
          payload: {
            id: record.id,
            name: record.name,
            totalCount: record.totalCount,
            matchCount: record.matchCount,
          },
        });
      }
      seen.add(listId);
    });

    this.registry.getRecordIds().forEach((id) => {
      if (!seen.has(id)) {
        this.registry.removeList(id);
      }
    });

    const order = snapshot
      .map((entry) => entry.id)
      .filter((id) => this.registry.has(id));
    this.registry.setListOrder(order);

    const currentState = this.store.getState();
    const pending = currentState.pendingActiveListId;
    const activeCandidate =
      pending && this.registry.has(pending) ? pending : currentState.activeListId;

    this.store.dispatch({
      type: APP_ACTIONS.setRegistry,
      payload: {
        lists: listMeta,
        order,
        activeListId: this.registry.has(activeCandidate)
          ? activeCandidate
          : currentState.activeListId,
        pendingActiveListId:
          pending && this.registry.has(pending) ? null : pending ?? null,
      },
    });
  }
}

export { RepositorySync };
