import { html, render } from "../../vendor/lit-html.js";
import { ListRepository } from "../../lib/app/list-repository.js";
import { generateListId } from "../state/list-store.js";
import { SidebarCoordinator } from "../state/sidebar-coordinator.js";
import { MoveTasksController } from "../state/move-tasks-controller.js";
import { ListRegistry } from "../state/list-registry.js";
import { RepositorySync } from "../state/repository-sync.js";
import { APP_ACTIONS, createAppStore, selectors } from "../state/app-store.js";
import "./sidebar.js";
import "./main-pane.js";
import "./move-dialog.js";
import "./a4-tasklist.js";

class ListsAppShellElement extends HTMLElement {
  [key: string]: any;

  constructor() {
    super();
    this.shellRendered = false;
    this.appInitialized = false;
    this.sidebarElement = null;
    this.mainElement = null;
    this.moveDialogElement = null;
    this.repository = null;
    this.store = null;
    this.sidebarCoordinator = null;
    this.registry = null;
    this.moveTasksController = null;
    this.repositorySync = null;
    this.unsubscribeStore = null;
    this.lastFocused = null;
    this.lastSearchQuery = "";
    this.lastOrder = [];
    this.lastActiveId = null;
    this.pendingMainRender = null;
    this.mainRenderScheduled = false;

    this.handleStoreChange = this.handleStoreChange.bind(this);
    this.handleSearchChange = this.handleSearchChange.bind(this);
    this.handleSearchClear = this.handleSearchClear.bind(this);
    this.handleListSelection = this.handleListSelection.bind(this);
    this.handleAddList = this.handleAddList.bind(this);
    this.handleDeleteList = this.handleDeleteList.bind(this);
    this.handleItemCountChange = this.handleItemCountChange.bind(this);
    this.handleSearchResultsChange = this.handleSearchResultsChange.bind(this);
    this.handleListFocus = this.handleListFocus.bind(this);
    this.handleListTitleChange = this.handleListTitleChange.bind(this);
  }

  connectedCallback() {
    this.classList.add("lists-app");
    if (!this.dataset.role) {
      this.dataset.role = "lists-app";
    }
    this.renderShell();
    this.cacheElements();
  }

  renderShell() {
    if (this.shellRendered) {
      return;
    }
    render(
      html`
        <a4-sidebar class="lists-sidebar" data-role="sidebar"></a4-sidebar>
        <a4-main-pane class="lists-main" data-role="main"></a4-main-pane>
        <a4-move-dialog
          class="move-dialog"
          data-role="move-dialog"
          hidden
        ></a4-move-dialog>
      `,
      this
    );
    this.shellRendered = true;
  }

  cacheElements() {
    this.sidebarElement = this.querySelector("[data-role='sidebar']");
    this.mainElement = this.querySelector("[data-role='main']");
    this.moveDialogElement = this.querySelector("[data-role='move-dialog']");
  }

  async initialize({ repository }: any = {}) {
    if (this.appInitialized) return;
    this.renderShell();
    await Promise.all([
      customElements.whenDefined("a4-sidebar"),
      customElements.whenDefined("a4-main-pane"),
      customElements.whenDefined("a4-move-dialog"),
    ]);
    if (typeof customElements.upgrade === "function") {
      customElements.upgrade(this);
    }
    this.cacheElements();
    this.repository = repository ?? new ListRepository();
    this.store = createAppStore();
    this.sidebarCoordinator = new SidebarCoordinator({
      sidebarElement: this.sidebarElement,
    });
    this.registry = new ListRegistry({
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
      onSearchChange: this.handleSearchChange,
      onSelectList: this.handleListSelection,
      onAddList: this.handleAddList,
      onDeleteList: this.handleDeleteList,
      onItemDropped: (payload, targetListId) =>
        this.moveTasksController.handleSidebarDrop(payload, targetListId),
    });
    this.unsubscribeStore = this.store.subscribe(this.handleStoreChange);
    this.lastSearchQuery = selectors.getSearchQuery(this.store.getState());
    this.lastOrder = selectors.getListOrder(this.store.getState());
    this.lastActiveId = selectors.getActiveListId(this.store.getState());
    await this.repositorySync.initialize();
    this.sidebarElement?.init?.();
    this.sidebarElement?.setSearchValue?.(this.store.getState().searchQuery);
    this.handleStoreChange();
    this.appInitialized = true;
  }

  dispose() {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.repositorySync?.dispose?.();
  }

  handleStoreChange() {
    if (!this.store) return;
    const state = this.store.getState();
    const searchQuery = selectors.getSearchQuery(state);
    const searchMode = selectors.isSearchMode(state);
    const order = selectors.getListOrder(state);
    const activeId = selectors.getActiveListId(state);

    if (!this.arraysEqual(order, this.lastOrder)) {
      this.registry.setListOrder(order);
      this.lastOrder = order;
    }

    if (activeId !== this.lastActiveId) {
      this.registry.setActiveListId(activeId);
      this.lastActiveId = activeId;
    }

    this.renderMainLists({ activeId, searchMode, searchQuery });

    if (searchQuery !== this.lastSearchQuery) {
      this.applySearchToLists(searchQuery);
      this.lastSearchQuery = searchQuery;
    }

    this.refreshSidebar(state);
    this.updateMainHeading(state);
    this.updateMainSearchMode(searchMode);
  }

  handleSearchChange(value) {
    if (!this.store) return;
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
    if (!listId || !this.store) return;
    this.store.dispatch({
      type: APP_ACTIONS.setActiveList,
      payload: { id: listId },
    });
  }

  handleAddList() {
    if (!this.store) return;
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
    if (!this.store) return;
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
    if (!this.store) return;
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
    if (!this.store) return;
    const listId = event.currentTarget?.listId ?? null;
    const record = this.registry.getRecord(listId);
    if (!record) return;
    const total = Number(event.detail?.total);
    const totalCount = Number.isFinite(total)
      ? total
      : record.element?.getTotalItemCount?.() ?? 0;
    this.store.dispatch({
      type: APP_ACTIONS.updateListMetrics,
      payload: { id: listId, totalCount },
    });
  }

  handleSearchResultsChange(event) {
    if (!this.store) return;
    const listId = event.currentTarget?.listId ?? null;
    const record = this.registry.getRecord(listId);
    if (!record) return;
    const matches = Number(event.detail?.matches);
    const matchCount = Number.isFinite(matches)
      ? matches
      : record.element?.getSearchMatchCount?.() ?? 0;
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
    const records = this.registry.getRecordsInOrder();
    records.forEach((record) => {
      if (!record.element) return;
      record.element.applyFilter(query);
      const matchCount = record.element.getSearchMatchCount();
      this.store.dispatch({
        type: APP_ACTIONS.updateListMetrics,
        payload: { id: record.id, matchCount },
      });
    });
  }

  refreshSidebar(state = this.store?.getState?.()) {
    if (!state) return;
    const searchMode = selectors.isSearchMode(state);
    const countsById = new Map();
    if (searchMode) {
      const container = this.mainElement?.getListsContainer?.();
      if (container) {
        Array.from(
          container.querySelectorAll("section.list-section")
        ).forEach((section) => {
          const element = section as HTMLElement;
          const listId = element.dataset?.listId ?? null;
          if (!listId) return;
          const matchCount = element.querySelectorAll(
            "ol.tasklist li:not(.placeholder):not([hidden])"
          ).length;
          countsById.set(listId, matchCount);
        });
      }
    }
    const data = selectors.getSidebarListData(state).map((entry) => {
      const matchCount = countsById.has(entry.id)
        ? countsById.get(entry.id)
        : entry.matchCount;
      return {
        ...entry,
        countLabel: searchMode
          ? this.sidebarCoordinator.formatMatchCount(matchCount)
          : this.sidebarCoordinator.formatTotalCount(entry.totalCount),
      };
    });
    this.sidebarElement?.setLists?.(data, {
      activeListId: selectors.getActiveListId(state),
      searchQuery: selectors.getSearchQuery(state),
    });
  }

  updateMainHeading(state = this.store?.getState?.()) {
    if (!state) return;
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
    this.mainElement?.setTitle?.(active ? active.name : "Task Collections");
  }

  updateMainSearchMode(searchMode) {
    this.mainElement?.setSearchMode?.(searchMode);
  }

  renderMainLists({ activeId, searchMode, searchQuery }) {
    if (!this.mainElement || typeof this.mainElement.renderLists !== "function") {
      this.pendingMainRender = { activeId, searchMode, searchQuery };
      if (!this.mainRenderScheduled) {
        this.mainRenderScheduled = true;
        requestAnimationFrame(() => {
          this.mainRenderScheduled = false;
          if (this.pendingMainRender) {
            const pending = this.pendingMainRender;
            this.pendingMainRender = null;
            this.renderMainLists(pending);
          }
        });
      }
      return;
    }
    const records = this.registry.getRecordsInOrder();
    this.mainElement.renderLists?.(records, {
      activeListId: activeId,
      searchMode,
      repository: this.repository,
    });
    this.registry.attachRenderedLists?.(
      this.mainElement.getListsContainer?.()
    );
    const query =
      typeof searchQuery === "string" ? searchQuery.trim() : "";
    if (query.length) {
      const needsSync = records.some(
        (record) => record.element && record.element.searchQuery !== query
      );
      if (needsSync) {
        this.applySearchToLists(query);
      }
    }
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

customElements.define("a4-lists-app", ListsAppShellElement);
