import { ListRepository } from "../lib/app/list-repository.js";
import { generateListId } from "./state/list-store.js";
import { SidebarCoordinator } from "./state/sidebar-coordinator.js";
import { MoveTasksController } from "./state/move-tasks-controller.js";
import { ListRegistry } from "./state/list-registry.js";
import { RepositorySync } from "./state/repository-sync.js";
import { APP_ACTIONS, createAppStore, selectors } from "./state/app-store.js";
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

    this.repository = options.listRepository ?? new ListRepository();
    this.lastFocused = null;

    this.store = createAppStore();

    this.sidebarCoordinator = new SidebarCoordinator({
      sidebarElement: this.sidebarElement,
    });

    this.registry = new ListRegistry({
      listsContainer: this.listsContainer,
      repository: this.repository,
    });

    this.moveTasksController = new MoveTasksController({
      registry: this.registry,
      repository: this.repository,
      moveDialog: this.moveDialogElement,
      store: this.store,
      formatMatchCount: (count) =>
        this.sidebarCoordinator.formatMatchCount(count),
      formatTotalCount: (count) =>
        this.sidebarCoordinator.formatTotalCount(count),
    });

    this.repositorySync = new RepositorySync({
      repository: this.repository,
      registry: this.registry,
      store: this.store,
    });

    this.registry.setEventHandlers({
      onTaskMoveRequest: (event) =>
        this.moveTasksController.handleTaskMoveRequest(event),
      onItemCountChange: (event) => this.handleItemCountChange(event),
      onSearchResultsChange: (event) => this.handleSearchResultsChange(event),
      onListFocus: (event) => this.handleListFocus(event),
      onListTitleChange: (event) => this.handleListTitleChange(event),
      onSearchClear: () => this.handleSearchClear(),
    });

    this.sidebarCoordinator.wireHandlers({
      onSearchChange: (value) => this.handleSearchChange(value),
      onSelectList: (listId) => this.handleListSelection(listId),
      onAddList: () => this.handleAddList(),
      onDeleteList: () => this.handleDeleteList(),
      onItemDropped: (payload, targetListId) =>
        this.moveTasksController.handleSidebarDrop(payload, targetListId),
    });

    this.unsubscribeStore = this.store.subscribe(() =>
      this.handleStoreChange()
    );
    this.lastSearchQuery = this.store.getState().searchQuery;
    this.lastOrder = selectors.getListOrder(this.store.getState());
    this.lastActiveId = selectors.getActiveListId(this.store.getState());
  }

  async initialize() {
    this.sidebarElement?.init?.();
    await this.repositorySync.initialize();
    this.sidebarElement?.setSearchValue?.(this.store.getState().searchQuery);
    this.handleStoreChange();
  }

  dispose() {
    this.unsubscribeStore?.();
    this.repositorySync?.dispose?.();
  }

  handleStoreChange() {
    const state = this.store.getState();
    const searchQuery = selectors.getSearchQuery(state);
    const searchMode = selectors.isSearchMode(state);
    const order = selectors.getListOrder(state);
    const activeId = selectors.getActiveListId(state);

    if (!this.arraysEqual(order, this.lastOrder)) {
      this.registry.setListOrder(order);
      this.registry.appendWrappersInOrder();
      this.lastOrder = order;
    }

    if (activeId !== this.lastActiveId) {
      this.registry.setActiveListId(activeId);
      this.lastActiveId = activeId;
    }

    this.registry.updateListVisibility({ searchMode });

    if (searchQuery !== this.lastSearchQuery) {
      this.applySearchToLists(searchQuery);
      this.lastSearchQuery = searchQuery;
    }

    this.refreshSidebar(state);
    this.updateMainHeading(state);
    this.updateMainSearchMode(searchMode);
  }

  handleSearchChange(value) {
    const next = typeof value === "string" ? value : "";
    this.store.dispatch({
      type: APP_ACTIONS.setSearchQuery,
      payload: { query: next },
    });
  }

  handleSearchClear() {
    this.sidebarElement?.setSearchValue?.("");
    this.handleSearchChange("");
  }

  handleListSelection(listId) {
    if (!listId) return;
    this.store.dispatch({
      type: APP_ACTIONS.setActiveList,
      payload: { id: listId },
    });
  }

  handleAddList() {
    const response = window.prompt?.("Name for the new list", "New List");
    if (response == null) return;
    const trimmed = response.trim();
    if (!trimmed.length) return;
    const id = generateListId("list");
    this.store.dispatch({
      type: APP_ACTIONS.setPendingActiveList,
      payload: { id },
    });
    Promise.resolve(
      this.repository.createList({ listId: id, title: trimmed })
    ).catch(() => {
      this.store.dispatch({
        type: APP_ACTIONS.setPendingActiveList,
        payload: { id: null },
      });
    });
  }

  handleListTitleChange(event) {
    const element = event.currentTarget ?? null;
    const listId = element?.listId ?? element?.dataset?.listId ?? null;
    const detailTitle =
      typeof event.detail?.title === "string" ? event.detail.title : "";
    if (!listId) return;
    const trimmed = detailTitle.trim();
    const record = this.registry.getRecord(listId);
    if (record) {
      record.name = trimmed.length ? trimmed : "Untitled List";
    }
    this.store.dispatch({
      type: APP_ACTIONS.updateListName,
      payload: { id: listId, name: trimmed },
    });
  }

  handleDeleteList() {
    const state = this.store.getState();
    const activeListId = selectors.getActiveListId(state);
    const listOrder = selectors.getListOrder(state);
    if (!activeListId) return;
    if (listOrder.length <= 1) {
      window.alert?.("At least one list must remain.");
      return;
    }
    const record = this.registry.getRecord(activeListId);
    if (!record) return;
    const confirmed = window.confirm?.(
      `Delete "${record.name}" and all of its tasks?`
    );
    if (!confirmed) return;
    const removeId = record.id;
    const currentIndex = listOrder.indexOf(removeId);
    let fallbackId = null;
    if (currentIndex !== -1) {
      fallbackId = listOrder[currentIndex + 1] ?? null;
      if (!fallbackId) {
        fallbackId = listOrder[currentIndex - 1] ?? null;
      }
    }
    if (!fallbackId) {
      fallbackId = listOrder.find((id) => id !== removeId) ?? null;
    }
    this.store.dispatch({
      type: APP_ACTIONS.setPendingActiveList,
      payload: { id: fallbackId ?? null },
    });
    if (fallbackId) {
      this.store.dispatch({
        type: APP_ACTIONS.setActiveList,
        payload: { id: fallbackId },
      });
    }
    Promise.resolve(this.repository.removeList(removeId)).catch(() => {
      this.store.dispatch({
        type: APP_ACTIONS.setPendingActiveList,
        payload: { id: null },
      });
    });
  }

  handleItemCountChange(event) {
    const listId = event.currentTarget?.listId ?? null;
    const record = this.registry.getRecord(listId);
    if (!record) return;
    const total = Number(event.detail?.total);
    const totalCount = Number.isFinite(total)
      ? total
      : record.element.getTotalItemCount();
    this.store.dispatch({
      type: APP_ACTIONS.updateListMetrics,
      payload: { id: listId, totalCount },
    });
  }

  handleSearchResultsChange(event) {
    const listId = event.currentTarget?.listId ?? null;
    const record = this.registry.getRecord(listId);
    if (!record) return;
    const matches = Number(event.detail?.matches);
    const matchCount = Number.isFinite(matches)
      ? matches
      : record.element.getSearchMatchCount();
    this.store.dispatch({
      type: APP_ACTIONS.updateListMetrics,
      payload: { id: listId, matchCount },
    });
  }

  handleListFocus(event) {
    const detail = event.detail ?? {};
    this.lastFocused = {
      listId: detail.sourceListId ?? event.currentTarget?.listId ?? null,
      itemId: detail.itemId ?? null,
    };
  }

  applySearchToLists(query) {
    this.registry.getRecordsInOrder().forEach((record) => {
      record.element.applyFilter(query);
      const matchCount = record.element.getSearchMatchCount();
      this.store.dispatch({
        type: APP_ACTIONS.updateListMetrics,
        payload: { id: record.id, matchCount },
      });
    });
  }

  refreshSidebar(state = this.store.getState()) {
    const data = selectors.getSidebarListData(state).map((entry) => ({
      ...entry,
      countLabel: selectors.isSearchMode(state)
        ? this.sidebarCoordinator.formatMatchCount(entry.matchCount)
        : this.sidebarCoordinator.formatTotalCount(entry.totalCount),
    }));
    this.sidebarElement?.setLists?.(data, {
      activeListId: selectors.getActiveListId(state),
      searchQuery: selectors.getSearchQuery(state),
    });
  }

  updateMainHeading(state = this.store.getState()) {
    if (selectors.isSearchMode(state)) {
      const query = selectors.getSearchQuery(state).trim();
      if (query.length) {
        this.mainElement?.setTitle?.(`Search: "${query}"`);
      } else {
        this.mainElement?.setTitle?.("Search Results");
      }
      return;
    }
    const activeId = selectors.getActiveListId(state);
    const active = selectors.getList(state, activeId);
    this.mainElement?.setTitle?.(
      active ? active.name : "Task Collections"
    );
  }

  updateMainSearchMode(searchMode) {
    this.mainElement?.setSearchMode?.(searchMode);
  }

  arraysEqual(a = [], b = []) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

export default ListsApp;
