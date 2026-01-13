import { APP_ACTIONS } from "./app-store.js";

class RepositorySync {
  [key: string]: any;

  constructor({ repository, registry, store }: any = {}) {
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

  handleRegistryChange(snapshot = []) {
    if (!Array.isArray(snapshot)) return;
    const seen = new Set();
    const listMeta = [];
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
      (pending && this.registry.has(pending)) || currentState.activeListId;

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
