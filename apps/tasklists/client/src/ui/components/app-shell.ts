import { html, render } from "lit";
import { arraysEqual } from "../../shared/array-utils.js";
import {
  formatMatchCount,
  formatTotalCount,
} from "../../shared/format-utils.js";
import { ListRepository } from "../../app/list-repository.js";
import { ensureDemoData, type SeedConfig } from "../../app/demo-seed.js";
import { generateListId } from "../state/list-store.js";
import { SidebarCoordinator } from "../state/sidebar-coordinator.js";
import { MoveTasksController } from "../state/move-tasks-controller.js";
import { ListRegistry } from "../state/list-registry.js";
import { RepositorySync } from "../state/repository-sync.js";
import { APP_ACTIONS, createAppStore, selectors } from "../state/app-store.js";
import {
  buildExportSnapshot,
  parseExportSnapshotText,
  stringifyExportSnapshot,
} from "../../app/export-snapshot.js";
import {
  matchesSearchEntry,
  tokenizeSearchQuery,
} from "../state/highlight-utils.js";
import { SHORTCUTS, matchesShortcut } from "../state/shortcuts.js";
import type { ListId, TaskItem } from "../../types/domain.js";
import "./sidebar.js";
import "./main-pane.js";
import "./move-dialog.js";
import "./a4-tasklist.js";

type SidebarElement = HTMLElement & {
  init?: () => void;
  setSearchValue?: (value: string) => void;
  setDemoSeedEnabled?: (enabled: boolean) => void;
  setLists?: (
    lists: Array<{
      id: ListId;
      name: string;
      totalCount: number;
      matchCount: number;
      countLabel?: string;
    }>,
    options: { activeListId: ListId | null; searchQuery: string }
  ) => void;
  setHandlers?: (handlers: Record<string, unknown>) => void;
};

type MainPaneElement = HTMLElement & {
  renderLists?: (
    lists: Array<{ id: ListId }>,
    options: {
      activeListId: ListId | null;
      searchMode: boolean;
      repository: ListRepository;
    }
  ) => void;
  setTitle?: (value: string) => void;
  setSearchMode?: (enabled: boolean) => void;
  getListsContainer?: () => HTMLElement | null;
};

type MoveDialogElement = HTMLElement & {
  open?: (options: {
    sourceListId: ListId;
    itemId: string;
    task: TaskItem;
    trigger: string;
    targets: Array<{ id: ListId; name: string; countLabel: string }>;
    restoreFocus: (() => void) | null;
    onConfirm: (payload: { targetListId: ListId }) => void;
    onCancel: () => void;
  }) => void;
};

type Store = ReturnType<typeof createAppStore>;
class ListsAppShellElement extends HTMLElement {
  private shellRendered: boolean;
  private appInitialized: boolean;
  private sidebarElement: SidebarElement | null;
  private mainElement: MainPaneElement | null;
  private moveDialogElement: MoveDialogElement | null;
  private repository: ListRepository | null;
  private store: Store | null;
  private sidebarCoordinator: SidebarCoordinator | null;
  private registry: ListRegistry | null;
  private moveTasksController: MoveTasksController | null;
  private repositorySync: RepositorySync | null;
  private seedConfigs: SeedConfig[] | undefined;
  private demoSeedEnabled: boolean;
  private importInput: HTMLInputElement | null;
  private unsubscribeStore: (() => void) | null;
  private lastOrder: ListId[];
  private lastActiveId: ListId | null;
  private pendingMainRender: {
    activeId: ListId | null;
    searchMode: boolean;
    searchQuery: string;
  } | null;
  private mainRenderScheduled: boolean;
  private handleGlobalKeyDown: (event: KeyboardEvent) => void;

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
    this.seedConfigs = undefined;
    this.demoSeedEnabled = false;
    this.importInput = null;
    this.unsubscribeStore = null;
    this.lastOrder = [];
    this.lastActiveId = null;
    this.pendingMainRender = null;
    this.mainRenderScheduled = false;
    this.handleGlobalKeyDown = this.onGlobalKeyDown.bind(this);

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
    this.handleShowDoneChange = this.handleShowDoneChange.bind(this);
    this.handleSidebarReorder = this.handleSidebarReorder.bind(this);
    this.handleSeedDemo = this.handleSeedDemo.bind(this);
    this.handleExportSnapshot = this.handleExportSnapshot.bind(this);
    this.handleImportSnapshot = this.handleImportSnapshot.bind(this);
    this.handleImportInputChange = this.handleImportInputChange.bind(this);
  }

  connectedCallback() {
    this.classList.add("lists-app");
    if (!this.dataset.role) {
      this.dataset.role = "lists-app";
    }
    this.renderShell();
    this.cacheElements();
    document.addEventListener("keydown", this.handleGlobalKeyDown, true);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.handleGlobalKeyDown, true);
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
        <input
          type="file"
          accept="application/json"
          data-role="import-snapshot-input"
          hidden
        />
      `,
      this
    );
    this.shellRendered = true;
  }

  cacheElements() {
    this.sidebarElement = this.querySelector(
      "[data-role='sidebar']"
    ) as SidebarElement | null;
    this.mainElement = this.querySelector(
      "[data-role='main']"
    ) as MainPaneElement | null;
    this.moveDialogElement = this.querySelector(
      "[data-role='move-dialog']"
    ) as MoveDialogElement | null;
    this.importInput = this.querySelector(
      "[data-role='import-snapshot-input']"
    ) as HTMLInputElement | null;
    if (this.importInput) {
      this.importInput.removeEventListener(
        "change",
        this.handleImportInputChange
      );
      this.importInput.addEventListener(
        "change",
        this.handleImportInputChange
      );
    }
  }

  async initialize({
    repository,
    seedConfigs,
    enableDemoSeed,
  }: {
    repository?: ListRepository;
    seedConfigs?: SeedConfig[];
    enableDemoSeed?: boolean;
  } = {}) {
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
    this.seedConfigs = seedConfigs;
    this.demoSeedEnabled = Boolean(enableDemoSeed);
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
      onShowDoneChange: (event) => this.handleShowDoneChange(event),
    });
    this.sidebarCoordinator.wireHandlers({
      onSearchChange: this.handleSearchChange,
      onSelectList: this.handleListSelection,
      onAddList: this.handleAddList,
      onDeleteList: this.handleDeleteList,
      onExportSnapshot: this.handleExportSnapshot,
      onImportSnapshot: this.handleImportSnapshot,
      onSeedDemo: this.handleSeedDemo,
      onItemDropped: (payload, targetListId) =>
        this.moveTasksController.handleSidebarDrop(payload, targetListId),
      onReorderList: this.handleSidebarReorder,
    });
    this.unsubscribeStore = this.store.subscribe(this.handleStoreChange);
    this.lastOrder = selectors.getListOrder(this.store.getState());
    this.lastActiveId = selectors.getActiveListId(this.store.getState());
    await this.repositorySync.initialize();
    this.sidebarElement?.init?.();
    this.sidebarElement?.setDemoSeedEnabled?.(this.demoSeedEnabled);
    this.sidebarElement?.setSearchValue?.(this.store.getState().searchQuery);
    this.handleStoreChange();
    this.appInitialized = true;
  }

  onGlobalKeyDown(event: KeyboardEvent) {
    if (!this.repository) return;
    if (this.isEditableTarget(event.target)) return;
    const isUndo = matchesShortcut(event, SHORTCUTS.undo);
    const isRedo =
      matchesShortcut(event, SHORTCUTS.redo) ||
      matchesShortcut(event, SHORTCUTS.redoAlt);
    if (!isUndo && !isRedo) return;
    event.preventDefault();
    if (isUndo) {
      void this.repository.undo();
      return;
    }
    if (isRedo) {
      void this.repository.redo();
    }
  }

  isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }
    return Boolean(target.closest("[contenteditable='true']"));
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

    if (!arraysEqual(order, this.lastOrder)) {
      this.registry.setListOrder(order);
      this.lastOrder = order;
    }

    if (activeId !== this.lastActiveId) {
      this.registry.setActiveListId(activeId);
      this.lastActiveId = activeId;
    }

    this.renderMainLists({ activeId, searchMode, searchQuery });

    this.refreshSidebar(state);
    this.updateMainHeading(state);
    this.updateMainSearchMode(searchMode);
  }

  handleSearchChange(value: string) {
    if (!this.store) return;
    const next = typeof value === "string" ? value : "";
    this.store.dispatch({
      type: APP_ACTIONS.setSearchQuery,
      payload: { query: next },
    });
    this.applySearchToLists(next);
  }

  handleSearchClear() {
    this.sidebarElement?.setSearchValue?.("");
    this.handleSearchChange("");
  }

  handleShowDoneChange(event: Event) {
    if (!this.store) return;
    const listId = (event.currentTarget as { listId?: ListId } | null)?.listId ?? null;
    if (!listId) return;
    const query = selectors.getSearchQuery(this.store.getState());
    this.updateSearchMetrics(query, { listId });
  }

  handleListSelection(listId: ListId) {
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

  handleListTitleChange(event: Event) {
    if (!this.store) return;
    const customEvent = event as CustomEvent<{ title?: string }>;
    const element = event.currentTarget ?? null;
    const listId =
      (element as { listId?: ListId } | null)?.listId ??
      (element as HTMLElement | null)?.dataset?.listId ??
      null;
    const detailTitle =
      typeof customEvent.detail?.title === "string"
        ? customEvent.detail.title
        : "";
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

  async handleSeedDemo() {
    if (!this.repository) return;
    await ensureDemoData(this.repository, this.seedConfigs);
  }

  async handleExportSnapshot() {
    if (!this.repository) return;
    try {
      const snapshot = await this.repository.exportSnapshotData();
      const envelope = buildExportSnapshot({
        registryState: snapshot.registryState,
        lists: snapshot.lists,
      });
      const content = stringifyExportSnapshot(envelope);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `net-aggregat4-tasklist-${timestamp}.json`;
      anchor.rel = "noopener";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      window.alert("Export failed. Please try again.");
    }
  }

  handleImportSnapshot() {
    if (!this.importInput) return;
    this.importInput.value = "";
    this.importInput.click();
  }

  async handleImportInputChange(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0] ?? null;
    if (!file || !this.repository) return;
    let text = "";
    try {
      text = await file.text();
    } catch (err) {
      window.alert("Could not read the snapshot file.");
      return;
    }
    const parsed = parseExportSnapshotText(text);
    if (parsed.ok === false) {
      window.alert(parsed.error);
      return;
    }
    const confirmImport = window.confirm(
      "Importing a snapshot replaces all current lists. Continue?"
    );
    if (!confirmImport) return;
    const publishResult = await this.repository.replaceWithSnapshot({
      registryState: parsed.value.registryState,
      lists: parsed.value.lists,
      snapshotText: text,
      publishSnapshot: true,
    });
    if (publishResult && !publishResult.published) {
      window.alert(
        publishResult.error ||
          "Snapshot imported locally but failed to publish to the server."
      );
    }
  }

  handleSidebarReorder({
    movedId,
    order,
  }: {
    movedId: ListId;
    order: ListId[];
  }) {
    if (!this.store || !this.repository) return;
    const previousOrder = selectors.getListOrder(this.store.getState());
    if (!Array.isArray(previousOrder) || previousOrder.length <= 1) return;
    if (!Array.isArray(order) || order.length <= 1) return;
    if (!movedId || !order.includes(movedId)) return;
    if (order.every((id, idx) => id === previousOrder[idx])) return;

    const movedIndex = order.indexOf(movedId);
    const beforeId = order[movedIndex + 1] ?? null;
    const afterId = order[movedIndex - 1] ?? null;
    this.store.dispatch({
      type: APP_ACTIONS.setOrder,
      payload: { order },
    });

    Promise.resolve(
      this.repository.reorderList(movedId, { afterId, beforeId })
    ).catch(() => {
      this.store.dispatch({
        type: APP_ACTIONS.setOrder,
        payload: { order: previousOrder },
      });
    });
  }

  handleItemCountChange(event: Event) {
    if (!this.store) return;
    const customEvent = event as CustomEvent<{ total?: number }>;
    const listId = (event.currentTarget as { listId?: ListId } | null)?.listId ?? null;
    const record = this.registry.getRecord(listId);
    if (!record) return;
    const total = Number(customEvent.detail?.total);
    const totalCount = Number.isFinite(total)
      ? total
      : record.element?.getTotalItemCount?.() ?? 0;
    this.store.dispatch({
      type: APP_ACTIONS.updateListMetrics,
      payload: { id: listId, totalCount },
    });
  }

  handleSearchResultsChange(event: Event) {
    if (!this.store) return;
    const customEvent = event as CustomEvent<{ matches?: number }>;
    const listId = (event.currentTarget as { listId?: ListId } | null)?.listId ?? null;
    const record = this.registry.getRecord(listId);
    if (!record) return;
    const matches = Number(customEvent.detail?.matches);
    const matchCount = Number.isFinite(matches)
      ? matches
      : record.element?.getSearchMatchCount?.() ?? 0;
    this.store.dispatch({
      type: APP_ACTIONS.updateListMetrics,
      payload: { id: listId, matchCount },
    });
  }

  handleListFocus(_event: Event) {
    // No-op; hook reserved for future focus restoration.
  }

  applySearchToLists(query: string) {
    if (!this.registry) return;
    const records = this.registry.getRecordsInOrder();
    records.forEach((record) => {
      if (!record.element) return;
      record.element.applyFilter(query);
    });
    this.updateSearchMetrics(query);
  }

  updateSearchMetrics(
    query: string,
    { listId = null }: { listId?: ListId | null } = {}
  ) {
    if (!this.store || !this.repository || !this.registry) return;
    const tokens = tokenizeSearchQuery(query);
    const records = this.registry.getRecordsInOrder();
    records.forEach((record) => {
      if (listId && record.id !== listId) return;
      const matchCount = this.getSearchMatchCountForList(record.id, tokens);
      this.store.dispatch({
        type: APP_ACTIONS.updateListMetrics,
        payload: { id: record.id, matchCount },
      });
    });
  }

  getSearchMatchCountForList(listId: ListId, tokens: string[]) {
    if (!this.repository) return 0;
    const state = this.repository.getListState(listId);
    const items = Array.isArray(state?.items) ? state.items : [];
    const record = this.registry?.getRecord(listId);
    const showDone = record?.element?.showDone === true;
    let matchCount = 0;
    items.forEach((item) => {
      const text = typeof item?.text === "string" ? item.text : "";
      const note = typeof item?.note === "string" ? item.note : "";
      const isDone = Boolean(item?.done);
      if (
        matchesSearchEntry({
          originalText: text,
          noteText: note,
          tokens,
          showDone,
          isDone,
        })
      ) {
        matchCount += 1;
      }
    });
    return matchCount;
  }

  refreshSidebar(state: ReturnType<Store["getState"]> | null = this.store?.getState?.() ?? null) {
    if (!state) return;
    const searchMode = selectors.isSearchMode(state);
    const tokens = searchMode
      ? tokenizeSearchQuery(selectors.getSearchQuery(state))
      : [];
    const data = selectors.getSidebarListData(state).map((entry) => {
      const matchCount = searchMode
        ? this.getSearchMatchCountForList(entry.id, tokens)
        : entry.matchCount;
      return {
        ...entry,
        countLabel: searchMode
          ? formatMatchCount(matchCount)
          : formatTotalCount(entry.totalCount),
      };
    });
    this.sidebarElement?.setLists?.(data, {
      activeListId: selectors.getActiveListId(state),
      searchQuery: selectors.getSearchQuery(state),
    });
  }

  updateMainHeading(state: ReturnType<Store["getState"]> | null = this.store?.getState?.() ?? null) {
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

  updateMainSearchMode(searchMode: boolean) {
    this.mainElement?.setSearchMode?.(searchMode);
  }

  renderMainLists({
    activeId,
    searchMode,
    searchQuery,
  }: {
    activeId: ListId | null;
    searchMode: boolean;
    searchQuery: string;
  }) {
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
    if (!this.registry || !this.repository) return;
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

}

customElements.define("a4-lists-app", ListsAppShellElement);
