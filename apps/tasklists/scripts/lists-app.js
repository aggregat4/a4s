import { html, render } from "../vendor/lit-html.js";
import { ListRepository } from "../lib/app/list-repository.js";
import { generateListId } from "./state/list-store.js";
import "./components/sidebar.js";
import "./components/move-dialog.js";
import "./components/a4-tasklist.js";

class ListsApp {
  constructor(options = {}) {
    this.sidebarElement = options.sidebarElement ?? null;
    this.mainElement = options.mainElement ?? null;
    this.listsContainer = options.listsContainer ?? null;
    this.mainTitleEl = options.mainTitleElement ?? null;
    this.moveDialogElement = options.moveDialogElement ?? null;

    this.listRegistry = new Map();
    this.listOrder = [];
    this.activeListId = null;
    this.searchQuery = "";
    this.isApplyingSearch = false;
    this.lastFocused = null;
    this.pendingActiveListId = null;

    this.repository = options.listRepository ?? new ListRepository();
    this.registryUnsubscribe = null;

    this.handleSearchChange = this.handleSearchChange.bind(this);
    this.handleListSelection = this.handleListSelection.bind(this);
    this.handleAddList = this.handleAddList.bind(this);
    this.handleDeleteList = this.handleDeleteList.bind(this);
    this.handleSidebarDrop = this.handleSidebarDrop.bind(this);
    this.handleTaskMoveRequest = this.handleTaskMoveRequest.bind(this);
    this.handleItemCountChange = this.handleItemCountChange.bind(this);
    this.handleSearchResultsChange = this.handleSearchResultsChange.bind(this);
    this.handleListFocus = this.handleListFocus.bind(this);
    this.handleListTitleChange = this.handleListTitleChange.bind(this);
    this.handleRepositoryRegistryChange =
      this.handleRepositoryRegistryChange.bind(this);

    this.sidebar = this.sidebarElement;
    if (this.sidebar?.setHandlers) {
      this.sidebar.setHandlers({
        onSearchChange: this.handleSearchChange,
        onSelectList: this.handleListSelection,
        onAddList: this.handleAddList,
        onDeleteList: this.handleDeleteList,
        onItemDropped: this.handleSidebarDrop,
      });
    }

    this.moveDialog = this.moveDialogElement;
  }

  async initialize() {
    this.sidebar?.init?.();
    await this.repository.initialize();
    if (!this.registryUnsubscribe) {
      this.registryUnsubscribe = this.repository.subscribeRegistry(
        this.handleRepositoryRegistryChange,
        { emitCurrent: false }
      );
    }
    this.handleRepositoryRegistryChange(this.repository.getRegistrySnapshot());
    this.sidebar?.setSearchValue?.(this.searchQuery);
  }

  createList(config, { makeActive = false } = {}) {
    if (!this.listsContainer) return null;
    const id = config.id ?? generateListId("list");
    const state = {
      title:
        typeof config.title === "string" && config.title.length
          ? config.title
          : "",
      items: Array.isArray(config.items) ? config.items : [],
    };
    const displayName = state.title.length ? state.title : "Untitled List";
    const existing = this.listRegistry.get(id);
    if (existing) {
      existing.name = displayName;
      existing.element.listRepository = this.repository;
      existing.element.initialState = state;
      if (makeActive) {
        this.setActiveList(id);
      }
      return existing;
    }

    const wrapper = document.createElement("section");
    wrapper.className = "list-section";
    wrapper.dataset.listId = id;

    const items = Array.isArray(config.items)
      ? config.items.map((item) => ({ ...item }))
      : [];

    render(html` <a4-tasklist name=${name}></a4-tasklist> `, wrapper);
    this.listsContainer.appendChild(wrapper);

    const listElement = wrapper.querySelector("a4-tasklist");
    if (!listElement) {
      wrapper.remove();
      return null;
    }
    listElement.listId = id;
    listElement.listRepository = this.repository;
    listElement.initialState = {
      title: state.title,
      items,
    };

    const record = {
      id,
      name: displayName,
      element: listElement,
      wrapper,
      totalCount: listElement.getTotalItemCount(),
      matchCount: listElement.getSearchMatchCount(),
      flashTimer: null,
    };

    this.listRegistry.set(id, record);
    this.registerListEvents(record);

    if (makeActive || !this.activeListId) {
      this.activeListId = id;
    }
    this.updateListVisibility();
    return record;
  }

  registerListEvents(record) {
    const element = record.element;
    element.addEventListener("taskMoveRequest", this.handleTaskMoveRequest);
    element.addEventListener("itemcountchange", this.handleItemCountChange);
    element.addEventListener(
      "searchresultschange",
      this.handleSearchResultsChange
    );
    element.addEventListener("taskFocus", this.handleListFocus);
    element.addEventListener("titlechange", this.handleListTitleChange);
  }

  removeList(listId) {
    const record = this.listRegistry.get(listId);
    if (!record) return;
    const element = record.element;
    element?.dispose?.();
    element.removeEventListener("taskMoveRequest", this.handleTaskMoveRequest);
    element.removeEventListener("itemcountchange", this.handleItemCountChange);
    element.removeEventListener(
      "searchresultschange",
      this.handleSearchResultsChange
    );
    element.removeEventListener("taskFocus", this.handleListFocus);
    element.removeEventListener("titlechange", this.handleListTitleChange);
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
      record.flashTimer = null;
    }
    record.wrapper.remove();
    this.listRegistry.delete(listId);
    this.listOrder = this.listOrder.filter((id) => id !== listId);
  }

  handleSearchChange(value) {
    const next = typeof value === "string" ? value : "";
    if (next === this.searchQuery) return;
    this.searchQuery = next;
    this.applySearchToLists();
    this.refreshSidebar();
    this.updateMainHeading();
  }

  handleListSelection(listId) {
    if (!listId) return;
    this.setActiveList(listId);
  }

  handleAddList() {
    const response = window.prompt?.("Name for the new list", "New List");
    if (response == null) return;
    const trimmed = response.trim();
    if (!trimmed.length) return;
    const id = generateListId("list");
    this.pendingActiveListId = id;
    Promise.resolve(this.repository.createList({ listId: id, title: trimmed }))
      .then(() => {
        this.setActiveList(id);
      })
      .catch(() => {});
  }

  handleListTitleChange(event) {
    const element = event.currentTarget ?? null;
    const listId = element?.listId ?? element?.dataset?.listId ?? null;
    const detailTitle =
      typeof event.detail?.title === "string" ? event.detail.title : "";
    if (!listId) return;
    const trimmed = detailTitle.trim();
    const nextName = trimmed.length ? trimmed : "Untitled List";
    const record = this.listRegistry.get(listId);
    if (!record || record.name === nextName) return;
    record.name = nextName;
    this.refreshSidebar();
    if (this.activeListId === listId) {
      this.updateMainHeading();
    }
  }

  handleRepositoryRegistryChange(snapshot = []) {
    if (!Array.isArray(snapshot)) return;
    const seen = new Set();
    snapshot.forEach((entry, index) => {
      const listId = entry?.id;
      if (!listId) return;
      const state = this.repository.getListState(listId);
      const titleCandidate = state?.title ?? entry.title ?? "";
      const record = this.createList(
        {
          id: listId,
          title: titleCandidate,
          items: state?.items ?? [],
        },
        { makeActive: !this.activeListId && index === 0 }
      );
      if (record) {
        const normalized = titleCandidate?.trim?.() ?? "";
        record.name = normalized.length ? normalized : "Untitled List";
        record.totalCount = record.element.getTotalItemCount();
        record.matchCount = record.element.getSearchMatchCount();
      }
      seen.add(listId);
    });

    Array.from(this.listRegistry.keys()).forEach((id) => {
      if (!seen.has(id)) {
        this.removeList(id);
      }
    });

    this.listOrder = snapshot
      .map((entry) => entry.id)
      .filter((id) => this.listRegistry.has(id));

    if (this.listsContainer) {
      this.listOrder.forEach((id) => {
        const record = this.listRegistry.get(id);
        if (record) {
          this.listsContainer.appendChild(record.wrapper);
        }
      });
    }

    if (this.activeListId && !this.listRegistry.has(this.activeListId)) {
      this.activeListId = null;
    }
    if (!this.activeListId && this.listOrder.length) {
      this.activeListId = this.listOrder[0];
    }

    if (
      this.pendingActiveListId &&
      this.listRegistry.has(this.pendingActiveListId)
    ) {
      this.setActiveList(this.pendingActiveListId);
      this.pendingActiveListId = null;
    }

    this.applySearchToLists();
    this.refreshSidebar();
    this.updateMainHeading();
  }

  handleDeleteList() {
    if (!this.activeListId) return;
    if (this.listOrder.length <= 1) {
      window.alert?.("At least one list must remain.");
      return;
    }
    const record = this.listRegistry.get(this.activeListId);
    if (!record) return;
    const confirmed = window.confirm?.(
      `Delete "${record.name}" and all of its tasks?`
    );
    if (!confirmed) return;
    const removeId = record.id;
    const currentIndex = this.listOrder.indexOf(removeId);
    let fallbackId = null;
    if (currentIndex !== -1) {
      fallbackId = this.listOrder[currentIndex + 1] ?? null;
      if (!fallbackId) {
        fallbackId = this.listOrder[currentIndex - 1] ?? null;
      }
    }
    if (!fallbackId) {
      fallbackId = this.listOrder.find((id) => id !== removeId) ?? null;
    }
    if (fallbackId) {
      this.pendingActiveListId = fallbackId;
    } else {
      this.pendingActiveListId = null;
    }
    Promise.resolve(this.repository.removeList(removeId)).catch(() => {
      if (this.pendingActiveListId === fallbackId) {
        this.pendingActiveListId = null;
      }
    });
  }

  handleSidebarDrop(payload, targetListId) {
    const sourceListId = payload?.sourceListId;
    const itemId = payload?.itemId;
    const item = payload?.item ?? null;
    if (!sourceListId || !targetListId || !itemId) return;
    if (sourceListId === targetListId) return;
    this.moveTask(sourceListId, targetListId, itemId, {
      snapshot: item,
      focus: false,
    });
  }

  handleTaskMoveRequest(event) {
    const detail = event.detail ?? {};
    const sourceListId =
      detail.sourceListId ?? event.currentTarget?.listId ?? null;
    const itemId = detail.itemId ?? null;
    if (!sourceListId || !itemId) return;
    const record = this.listRegistry.get(sourceListId);
    if (!record) return;
    const snapshot = detail.item ?? record.element.getItemSnapshot(itemId);
    if (!snapshot) return;
    const searchActive = this.isSearchMode();
    const targets = this.listOrder
      .map((id) => this.listRegistry.get(id))
      .filter((rec) => rec && rec.id !== sourceListId)
      .map((rec) => ({
        id: rec.id,
        name: rec.name,
        countLabel: searchActive
          ? this.formatMatchCount(
              rec.matchCount ?? rec.element.getSearchMatchCount()
            )
          : this.formatTotalCount(
              rec.totalCount ?? rec.element.getTotalItemCount()
            ),
      }));
    if (!targets.length) return;
    const restoreFocus = () => {
      record.element.focusItem(itemId);
    };
    this.moveDialog.open({
      sourceListId,
      itemId,
      task: snapshot,
      trigger: detail.trigger ?? "button",
      targets,
      restoreFocus: detail.trigger === "shortcut" ? restoreFocus : null,
      onConfirm: ({ targetListId }) => {
        this.moveTask(sourceListId, targetListId, itemId, {
          snapshot,
          focus: detail.trigger === "shortcut",
        });
      },
      onCancel: () => {
        if (detail.trigger === "shortcut") {
          restoreFocus();
        }
      },
    });
  }

  handleItemCountChange(event) {
    const listId = event.currentTarget?.listId ?? null;
    const record = this.listRegistry.get(listId);
    if (!record) return;
    const total = Number(event.detail?.total);
    if (Number.isFinite(total)) {
      record.totalCount = total;
    } else {
      record.totalCount = record.element.getTotalItemCount();
    }
    if (!this.isApplyingSearch) {
      this.refreshSidebar();
    }
  }

  handleSearchResultsChange(event) {
    const listId = event.currentTarget?.listId ?? null;
    const record = this.listRegistry.get(listId);
    if (!record) return;
    const matches = Number(event.detail?.matches);
    if (Number.isFinite(matches)) {
      record.matchCount = matches;
    } else {
      record.matchCount = record.element.getSearchMatchCount();
    }
    const detailQuery =
      typeof event.detail?.query === "string" ? event.detail.query : null;
    const searchActive = this.searchQuery.trim().length > 0;
    if (
      !this.isApplyingSearch &&
      searchActive &&
      (detailQuery == null || detailQuery.trim().length === 0)
    ) {
      this.handleSearchChange("");
      return;
    }
    if (!this.isApplyingSearch) {
      this.refreshSidebar();
    }
  }

  handleListFocus(event) {
    const detail = event.detail ?? {};
    this.lastFocused = {
      listId: detail.sourceListId ?? event.currentTarget?.listId ?? null,
      itemId: detail.itemId ?? null,
    };
  }

  setActiveList(listId) {
    if (!listId || !this.listRegistry.has(listId)) return;
    if (this.activeListId === listId && !this.isSearchMode()) {
      return;
    }
    this.activeListId = listId;
    this.updateListVisibility();
    this.refreshSidebar();
    this.updateMainHeading();
  }

  applySearchToLists() {
    this.isApplyingSearch = true;
    this.listOrder.forEach((id) => {
      const record = this.listRegistry.get(id);
      if (!record) return;
      record.element.applyFilter(this.searchQuery);
      record.matchCount = record.element.getSearchMatchCount();
    });
    this.isApplyingSearch = false;
    this.updateSearchMode();
  }

  moveTask(sourceListId, targetListId, itemId, options = {}) {
    if (!itemId || sourceListId === targetListId) return;
    const sourceRecord = this.listRegistry.get(sourceListId);
    const targetRecord = this.listRegistry.get(targetListId);
    if (!sourceRecord || !targetRecord) return;
    const snapshot =
      options.snapshot ?? sourceRecord.element.getItemSnapshot(itemId);
    if (!snapshot) return;
    sourceRecord.element.cancelActiveDrag?.();
    const targetStateBefore = targetRecord.element.store?.getState?.();
    const fallbackBeforeId = Array.isArray(targetStateBefore?.items)
      ? targetStateBefore.items[0]?.id ?? undefined
      : undefined;
    const removed = sourceRecord.element.removeItemById(itemId);
    if (!removed) return;
    targetRecord.element.prependItem(snapshot);
    this.refreshMetrics(sourceRecord);
    this.refreshMetrics(targetRecord);
    if (options.focus) {
      targetRecord.element.focusItem(itemId);
    }
    this.flashList(targetListId);
    this.refreshSidebar();

    if (this.repository) {
      const beforeId = options.beforeId ?? fallbackBeforeId;
      const promise = this.repository.moveTask(
        sourceListId,
        targetListId,
        itemId,
        {
          snapshot,
          beforeId,
          afterId: options.afterId,
        }
      );
      this.runRepositoryOperation(promise);
    }
  }

  refreshMetrics(record) {
    if (!record) return;
    record.totalCount = record.element.getTotalItemCount();
    record.matchCount = record.element.getSearchMatchCount();
  }

  refreshSidebar() {
    const data = this.getSidebarListData();
    this.sidebar.setLists(data, {
      activeListId: this.activeListId,
      searchQuery: this.searchQuery,
    });
  }

  getSidebarListData() {
    const searchActive = this.isSearchMode();
    return this.listOrder
      .map((id) => {
        const record = this.listRegistry.get(id);
        if (!record) return null;
        return {
          id: record.id,
          name: record.name,
          totalCount: record.totalCount,
          matchCount: record.matchCount,
          countLabel: searchActive
            ? this.formatMatchCount(record.matchCount)
            : this.formatTotalCount(record.totalCount),
        };
      })
      .filter(Boolean);
  }

  updateSearchMode() {
    const searchMode = this.isSearchMode();
    if (this.mainElement) {
      this.mainElement.classList.toggle("search-mode", searchMode);
    }
    this.updateListVisibility();
  }

  updateListVisibility() {
    const searchMode = this.isSearchMode();
    this.listOrder.forEach((id) => {
      const record = this.listRegistry.get(id);
      if (!record) return;
      const isActive = id === this.activeListId;
      const shouldShow = searchMode || isActive;
      record.wrapper.classList.toggle("is-visible", shouldShow);
      record.wrapper.classList.toggle("is-active", isActive);
    });
  }

  updateMainHeading() {
    if (!this.mainTitleEl) return;
    if (this.isSearchMode()) {
      if (this.searchQuery.trim().length) {
        this.mainTitleEl.textContent = `Search: "${this.searchQuery}"`;
      } else {
        this.mainTitleEl.textContent = "Search Results";
      }
      return;
    }
    const active = this.listRegistry.get(this.activeListId);
    this.mainTitleEl.textContent = active ? active.name : "Task Collections";
  }

  flashList(listId) {
    const record = this.listRegistry.get(listId);
    if (!record) return;
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
    }
    record.wrapper.classList.add("list-section--flash");
    record.flashTimer = setTimeout(() => {
      record.wrapper.classList.remove("list-section--flash");
      record.flashTimer = null;
    }, 600);
  }

  isSearchMode() {
    return this.searchQuery.trim().length > 0;
  }

  formatMatchCount(count) {
    if (!count) return "No matches";
    return count === 1 ? "1 match" : `${count} matches`;
  }

  formatTotalCount(count) {
    if (!count) return "Empty";
    return count === 1 ? "1" : `${count}`;
  }
}

export { ListsApp };
export default ListsApp;
