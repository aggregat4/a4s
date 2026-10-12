import { APP_ACTIONS } from "./app-store.js";
import type { AppAction } from "./app-store.js";
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

type AppStateSlice = {
  pendingActiveListId: ListId | null;
  activeListId: ListId | null;
};

type Store = {
  getState: () => AppStateSlice;
  dispatch: (action: AppAction) => void;
};

class RepositorySync {
  private repository: Repository;
  private store: Store;
  private registryUnsubscribe: (() => void) | null;

  constructor({
    repository,
    store,
  }: {
    repository: Repository;
    store: Store;
  }) {
    this.repository = repository;
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

  handleRegistryChange(snapshot: ListRegistryEntry[] = []) {
    if (!Array.isArray(snapshot)) return;
    const listMeta = snapshot.map((entry) => {
      const name = this.repository.getListState(entry.id).title.trim();
      return { id: entry.id, name: name.length ? name : "Untitled List" };
    });
    listMeta.forEach((list) =>
      this.store.dispatch({ type: APP_ACTIONS.upsertList, payload: list })
    );

    const order = snapshot.map((entry) => entry.id);
    const known = new Set(order);
    const currentState = this.store.getState();
    const pending = currentState.pendingActiveListId;
    // A list waited for becomes active once it exists.
    const activeCandidate =
      pending && known.has(pending) ? pending : currentState.activeListId;

    this.store.dispatch({
      type: APP_ACTIONS.setRegistry,
      payload: {
        lists: listMeta,
        order,
        activeListId:
          activeCandidate && known.has(activeCandidate)
            ? activeCandidate
            : currentState.activeListId,
        pendingActiveListId: pending && known.has(pending) ? null : pending ?? null,
      },
    });
  }
}

export { RepositorySync };
