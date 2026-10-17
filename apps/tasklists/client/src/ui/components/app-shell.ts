import { html, render } from "lit";
import {
  formatMatchCount,
  formatTotalCount,
} from "../../shared/format-utils.js";
import { ListRepository } from "../../app/list-repository.js";
import { ensureDemoData, type SeedConfig } from "../../app/demo-seed.js";
import { generateListId } from "../state/list-store.js";

import { MoveTasksController } from "../state/move-tasks-controller.js";
import { ListsState } from "../state/lists-state.js";
import {
  pushListIdToUrl,
  pushSearchToUrl,
  readListIdFromUrl,
  readSearchFromUrl,
  replaceListIdInUrl,
  replaceSearchInUrl,
} from "../state/app-url.js";
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
import { connectionStatus } from "../state/connection-status.js";
import { listsPanel, searchRow } from "../state/lists-panel.js";
import { LISTS_PANEL_ID } from "./lists-switcher.js";
import type { ListId, TaskItem } from "../../types/domain.js";
import type { SyncStatus } from "../../types/sync.js";
import "./sidebar.js";
import "./main-pane.js";
import type { ListElement } from "./main-pane.js";
import "./move-dialog.js";
import "./shortcuts-dialog.js";
import "./mobile-toolbar.js";
import type { HistoryAvailability } from "../../app/history-manager.js";
import type { ToolbarHandlers, ToolbarState } from "./mobile-toolbar.js";
import "./a4-tasklist.js";

type SidebarElement = HTMLElement & {
  setSearchValue?: (value: string) => void;
  setDemoSeedEnabled?: (enabled: boolean) => void;
  setHistoryState?: (state: HistoryAvailability) => void;
  setLists?: (
    lists: Array<{
      id: ListId;
      name: string;
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
  listElement?: (listId: ListId) => ListElement | null;
  listElements?: () => ListElement[];
  flashList?: (listId: ListId) => void;
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

type ShortcutsDialogElement = HTMLElement & {
  toggle?: () => void;
};

type MobileToolbarElement = HTMLElement & {
  setState?: (state: Partial<ToolbarState>) => void;
  setHandlers?: (handlers: ToolbarHandlers) => void;
};

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Narrow screens fold the sidebar behind the list title; see styles.css. */
const NARROW_SCREEN = "(width <= 640px)";
class ListsAppShellElement extends HTMLElement {
  private shellRendered: boolean;
  private appInitialized: boolean;
  private sidebarElement: SidebarElement | null;
  private mainElement: MainPaneElement | null;
  private moveDialogElement: MoveDialogElement | null;
  private shortcutsDialogElement: ShortcutsDialogElement | null;
  private mobileToolbarElement: MobileToolbarElement | null;
  private repository: ListRepository | null;
  private moveTasksController: MoveTasksController | null;
  /** The lists as the user sees them. */
  private lists: ListsState | null;
  /** The list the user is on. */
  private activeListId: ListId | null;
  /** A list to make active once it exists: one named in the URL, or one being created. */
  private wantedListId: ListId | null;
  private searchQuery: string;
  private seedConfigs: SeedConfig[] | undefined;
  private demoSeedEnabled: boolean;
  private importInput: HTMLInputElement | null;
  private lastActiveId: ListId | null;
  // A list the user navigates to before it exists (a list being created). It
  // gets its own history entry once it becomes active.
  private listIdToPushToUrl: ListId | null;
  private pendingMainRender: {
    activeId: ListId | null;
    searchMode: boolean;
    searchQuery: string;
  } | null;
  private mainRenderScheduled: boolean;
  /** Aborted when the element is disconnected, removing its listeners. */
  private connection: AbortController | null;

  constructor() {
    super();
    this.shellRendered = false;
    this.appInitialized = false;
    this.sidebarElement = null;
    this.mainElement = null;
    this.moveDialogElement = null;
    this.shortcutsDialogElement = null;
    this.mobileToolbarElement = null;
    this.repository = null;
    this.moveTasksController = null;
    this.lists = null;
    this.activeListId = null;
    this.wantedListId = null;
    this.searchQuery = "";
    this.seedConfigs = undefined;
    this.demoSeedEnabled = false;
    this.importInput = null;
    this.lastActiveId = null;
    this.listIdToPushToUrl = null;
    this.pendingMainRender = null;
    this.mainRenderScheduled = false;
    this.connection = null;
  }

  connectedCallback() {
    this.classList.add("lists-app");
    if (!this.dataset.role) {
      this.dataset.role = "lists-app";
    }
    this.renderShell();
    this.cacheElements();
    this.connection = new AbortController();
    const { signal } = this.connection;
    document.addEventListener("keydown", (event) => this.onGlobalKeyDown(event), {
      capture: true,
      signal,
    });
    window.addEventListener("popstate", () => this.onPopState(), { signal });
    this.connectListsPanel(signal);
    this.connectSearchRow(signal);
    this.addEventListener("tokensearch", (event) => this.handleTokenSearch(event), { signal });
    // Events of the list elements, which bubble.
    this.addEventListener(
      "task-move-request",
      (event) => this.moveTasksController?.handleTaskMoveRequest(event),
      { signal }
    );
    this.addEventListener("itemcountchange", () => this.refreshSidebar(), { signal });
    this.addEventListener("searchresultschange", () => this.refreshSidebar(), { signal });
    this.addEventListener("listrename", (event) => this.handleListRename(event), { signal });
    this.addEventListener("clearsearch", () => this.handleSearchClear(), { signal });
    this.addEventListener(
      "showdonechange",
      () => {
        this.refreshSidebar();
        this.refreshMobileToolbar();
      },
      { signal }
    );
  }

  disconnectedCallback() {
    this.connection?.abort();
    this.connection = null;
  }

  renderShell() {
    if (this.shellRendered) {
      return;
    }
    render(
      html`
        <a4-sidebar
          class="lists-sidebar"
          id=${LISTS_PANEL_ID}
          data-role="sidebar"
        ></a4-sidebar>
        <div
          class="lists-panel-backdrop"
          data-role="lists-panel-backdrop"
          @click=${() => this.closeListsPanel({ restoreFocus: true })}
        ></div>
        <a4-main-pane class="lists-main" data-role="main"></a4-main-pane>
        <a4-move-dialog
          class="move-dialog"
          data-role="move-dialog"
          hidden
        ></a4-move-dialog>
        <a4-shortcuts-dialog
          class="shortcuts-dialog"
          data-role="shortcuts-dialog"
          hidden
        ></a4-shortcuts-dialog>
        <a4-mobile-toolbar
          class="mobile-toolbar"
          data-role="mobile-toolbar"
        ></a4-mobile-toolbar>
        <input
          type="file"
          accept="application/json"
          data-role="import-snapshot-input"
          hidden
          @change=${this.handleImportInputChange}
        />
      `,
      this,
      { host: this }
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
    this.shortcutsDialogElement = this.querySelector(
      "[data-role='shortcuts-dialog']"
    ) as ShortcutsDialogElement | null;
    this.mobileToolbarElement = this.querySelector(
      "[data-role='mobile-toolbar']"
    ) as MobileToolbarElement | null;
    this.importInput = this.querySelector(
      "[data-role='import-snapshot-input']"
    ) as HTMLInputElement | null;
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
      customElements.whenDefined("a4-shortcuts-dialog"),
      customElements.whenDefined("a4-mobile-toolbar"),
    ]);
    if (typeof customElements.upgrade === "function") {
      customElements.upgrade(this);
    }
    this.cacheElements();
    this.repository = repository ?? new ListRepository();
    this.repository.setSyncStatusChange((status) => this.handleSyncStatus(status));
    this.seedConfigs = seedConfigs;
    this.demoSeedEnabled = Boolean(enableDemoSeed);
    this.moveTasksController = new MoveTasksController({
      lists: {
        entries: () => this.listEntries(),
        isSearchMode: () => this.isSearchMode(),
        listElement: (listId) => this.listElement(listId),
        flashList: (listId) => this.mainElement?.flashList?.(listId),
      },
      repository: this.repository,
      moveDialog: this.moveDialogElement,
    });
    const moveTasksController = this.moveTasksController;
    this.lists = new ListsState(() => this.listsChanged());
    this.sidebarElement?.setHandlers?.({
      onSearchChange: (value: string) => this.handleSearchChange(value),
      onSearchSubmit: () => this.closeListsPanel(),
      onSelectList: (listId: ListId) => this.handleListSelection(listId),
      onAddList: () => this.handleAddList(),
      onDeleteList: () => this.handleDeleteList(),
      onExportSnapshot: () => this.handleExportSnapshot(),
      onImportSnapshot: () => this.handleImportSnapshot(),
      onSeedDemo: () => this.handleSeedDemo(),
      onUndo: () => void this.repository?.undo(),
      onRedo: () => void this.repository?.redo(),
      onItemDropped: (
        payload: { sourceListId?: ListId; itemId?: string; item?: TaskItem },
        targetListId: ListId
      ) => moveTasksController.handleSidebarDrop(payload, targetListId),
      onReorderList: (move: { id: ListId; afterId: ListId | null; beforeId: ListId | null }) =>
        this.handleSidebarReorder(move),
    });
    this.mobileToolbarElement?.setHandlers?.({
      onUndo: () => void this.repository?.undo(),
      onRedo: () => void this.repository?.redo(),
      onAddTask: () => this.getActiveListElement()?.addTask?.(),
      onShowDoneChange: (showDone) =>
        this.getActiveListElement()?.setShowDone?.(showDone),
    });
    this.repository.subscribeHistory((state) => {
      this.sidebarElement?.setHistoryState?.(state);
      this.mobileToolbarElement?.setState?.(state);
    });
    // The list may not be loaded (or synced) yet, so it becomes active once the
    // repository has it.
    this.wantedListId = readListIdFromUrl();
    await this.lists.connect(this.repository);
    this.sidebarElement?.setDemoSeedEnabled?.(this.demoSeedEnabled);
    const urlSearch = readSearchFromUrl();
    if (urlSearch) {
      this.handleSearchChange(urlSearch);
    }
    this.sidebarElement?.setSearchValue?.(this.searchQuery);
    this.render();
    this.appInitialized = true;

  }

  onGlobalKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && listsPanel.isOpen() && !this.isSearchBeingCleared(event)) {
      event.preventDefault();
      this.closeListsPanel({ restoreFocus: true });
      return;
    }
    if (event.key === "Escape" && this.isSearchRowField(event.target)) {
      event.preventDefault();
      this.closeSearchRow({ restoreFocus: true });
      return;
    }
    // The cheat sheet is useful everywhere, including while editing a task,
    // so it is handled before the editable-target bail used by undo/redo.
    if (matchesShortcut(event, SHORTCUTS.help)) {
      if (event.isComposing || event.repeat) return;
      event.preventDefault();
      // Stop the inline editor / note input from receiving the "?" keystroke.
      event.stopPropagation();
      this.shortcutsDialogElement?.toggle?.();
      return;
    }
    // Ctrl/Cmd+S has no meaning in a CRDT-backed app, but the reflex is strong:
    // intercept it to suppress the browser "Save Page" dialog and instead flush
    // any buffered changes to the server immediately. Bound before the
    // editable-target bail so it works while editing a task or note.
    if (matchesShortcut(event, SHORTCUTS.save)) {
      if (event.isComposing || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      void this.repository?.flushSync?.();
      return;
    }
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

  // Whether the browser handles undo and typing for this element itself: text
  // fields and contenteditable text. Checkboxes, buttons and the like are not,
  // so Ctrl+Z right after ticking a task off undoes the tick.
  isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      return !NON_TEXT_INPUT_TYPES.has(target.type);
    }
    return Boolean(target.closest("[contenteditable='true']"));
  }

  handleSyncStatus(status: SyncStatus) {
    connectionStatus.setSyncStatus(status);
  }

  /**
   * On narrow screens the sidebar drops down from the list title. It closes
   * when a list is picked, on Escape, on a tap outside it, and when the screen
   * becomes wide, where the sidebar is always shown.
   */
  connectListsPanel(signal: AbortSignal) {
    const reposition = () => this.positionListsPanel();
    const unsubscribe = listsPanel.subscribe((open) => {
      this.classList.toggle("is-lists-panel-open", open);
      if (open) this.positionListsPanel();
    });
    signal.addEventListener("abort", () => {
      unsubscribe();
      listsPanel.setOpen(false);
    });
    window.addEventListener("scroll", reposition, { passive: true, signal });
    window.addEventListener("resize", reposition, { signal });
    window
      .matchMedia(NARROW_SCREEN)
      .addEventListener("change", () => this.closeListsPanel(), { signal });
  }

  /**
   * On narrow screens the search field is a row under the header, opened with
   * the search button and focused then. A query keeps it open, so closing it
   * clears the search.
   */
  connectSearchRow(signal: AbortSignal) {
    const unsubscribeRow = searchRow.subscribe((open) => {
      this.classList.toggle("is-search-row-open", open);
      if (open) {
        this.positionListsPanel();
        if (!this.isSearchMode()) this.searchField()?.focus();
      } else if (this.isSearchMode()) {
        this.setSearch("");
      }
    });
    // The header grows with the status line, and the row hangs below it.
    const unsubscribeStatus = connectionStatus.subscribe(() =>
      requestAnimationFrame(() => this.positionListsPanel())
    );
    signal.addEventListener("abort", () => {
      unsubscribeRow();
      unsubscribeStatus();
      searchRow.setOpen(false);
    });
  }

  searchField() {
    return this.querySelector<HTMLInputElement>("[data-role='global-search']");
  }

  /** The search field, while it is the search row of a narrow screen. */
  isSearchRowField(target: EventTarget | null) {
    return (
      searchRow.isOpen() &&
      target === this.searchField() &&
      window.matchMedia(NARROW_SCREEN).matches
    );
  }

  closeSearchRow({ restoreFocus = false } = {}) {
    if (!searchRow.isOpen()) return;
    searchRow.setOpen(false);
    if (restoreFocus) this.visibleButton("search-toggle")?.focus();
  }

  /** The panel and the search row hang below the header with the switcher. */
  positionListsPanel() {
    if (!listsPanel.isOpen() && !searchRow.isOpen()) return;
    const header = this.visibleListsSwitcher()?.closest(
      ".tasklist-header, .lists-main-header"
    );
    const bottom = header?.getBoundingClientRect().bottom ?? 0;
    this.style.setProperty("--lists-panel-top", `${Math.max(0, Math.round(bottom))}px`);
  }

  visibleListsSwitcher() {
    return this.visibleButton("lists-switcher");
  }

  /** The button with this role in the header shown; each header has one. */
  visibleButton(role: string) {
    return (
      Array.from(this.querySelectorAll<HTMLElement>(`[data-role='${role}']`)).find(
        (button) => button.getClientRects().length > 0
      ) ?? null
    );
  }

  closeListsPanel({ restoreFocus = false } = {}) {
    if (!listsPanel.isOpen()) return;
    listsPanel.setOpen(false);
    if (restoreFocus) this.visibleListsSwitcher()?.focus();
  }

  /** Escape in a search field with text clears the search, not the panel. */
  isSearchBeingCleared(event: KeyboardEvent) {
    const target = event.target;
    return (
      target instanceof HTMLInputElement &&
      target.dataset.role === "global-search" &&
      target.value.length > 0
    );
  }

  /** The lists as shown, with their names. */
  listEntries() {
    return (this.lists?.shown ?? []).map(({ id, title }) => ({
      id,
      name: title.trim() || "Untitled List",
    }));
  }

  hasList(listId: ListId) {
    return (this.lists?.shown ?? []).some((list) => list.id === listId);
  }

  isSearchMode() {
    return this.searchQuery.trim().length > 0;
  }

  /**
   * The lists changed: a list waited for becomes active once it exists, and
   * the first list once the active one is gone.
   */
  listsChanged() {
    const ids = (this.lists?.shown ?? []).map((list) => list.id);
    if (this.wantedListId && ids.includes(this.wantedListId)) {
      this.activeListId = this.wantedListId;
      this.wantedListId = null;
    }
    if (!this.activeListId || !ids.includes(this.activeListId)) {
      this.activeListId = ids[0] ?? null;
    }
    this.render();
  }

  /** Makes a list that exists the active one. */
  showList(listId: ListId) {
    if (!this.hasList(listId) || this.activeListId === listId) return;
    this.activeListId = listId;
    this.render();
  }

  /** Shows the lists, the active one and the search. */
  render() {
    if (!this.lists) return;
    const searchQuery = this.searchQuery;
    const searchMode = this.isSearchMode();
    const activeId = this.activeListId;

    if (activeId !== this.lastActiveId) {
      this.lastActiveId = activeId;
      if (activeId && activeId === this.listIdToPushToUrl) {
        this.listIdToPushToUrl = null;
        pushListIdToUrl(activeId);
      } else if (activeId) {
        replaceListIdInUrl(activeId);
      }
    }

    this.renderMainLists({ activeId, searchMode, searchQuery });
    // The switcher moves between headers as the search starts or ends.
    requestAnimationFrame(() => this.positionListsPanel());

    this.refreshSidebar();
    this.updateMainHeading();
    this.updateMainSearchMode(searchMode);
    this.refreshMobileToolbar();
  }

  /** The element showing a list, once rendered. */
  listElement(listId: ListId) {
    return this.mainElement?.listElement?.(listId) ?? null;
  }

  getActiveListElement() {
    return this.activeListId ? this.listElement(this.activeListId) : null;
  }

  refreshMobileToolbar() {
    if (!this.lists) return;
    this.mobileToolbarElement?.setState?.({
      showDone: Boolean(this.getActiveListElement()?.showDone),
      searchMode: this.isSearchMode(),
    });
  }

  handleSearchChange(value: string) {
    if (!this.lists) return;
    const next = typeof value === "string" ? value : "";
    if (next !== this.searchQuery) {
      this.searchQuery = next;
      if (this.isSearchMode()) searchRow.setOpen(true);
      this.render();
    }
    replaceSearchInUrl(next);
    this.applySearchToLists(next);
  }

  /** Shows the query in the search field and searches for it. */
  setSearch(query: string) {
    this.sidebarElement?.setSearchValue?.(query);
    this.handleSearchChange(query);
  }

  /**
   * A tag or context in a task was clicked: toggle it in the search. Adding it
   * narrows the results, as each word must match; clicking it again removes it.
   */
  handleTokenSearch(event: Event) {
    if (!this.lists) return;
    const token = (event as CustomEvent<{ token?: string }>).detail?.token;
    if (!token) return;
    const words = this.searchQuery.trim().split(/\s+/).filter(Boolean);
    const isToken = (word: string) => word.toLowerCase() === token.toLowerCase();
    const next = words.some(isToken)
      ? words.filter((word) => !isToken(word)).join(" ")
      : [...words, token].join(" ");
    pushSearchToUrl(next);
    this.setSearch(next);
  }

  handleSearchClear() {
    this.sidebarElement?.setSearchValue?.("");
    this.handleSearchChange("");
  }

  handleListSelection(listId: ListId) {
    if (!listId || !this.hasList(listId)) return;
    this.listIdToPushToUrl = null;
    this.wantedListId = null;
    pushListIdToUrl(listId);
    this.showList(listId);
    this.closeListsPanel();
  }

  onPopState() {
    if (!this.lists) return;
    const search = readSearchFromUrl();
    if (search !== this.searchQuery) {
      this.setSearch(search);
    }
    const listId = readListIdFromUrl();
    this.listIdToPushToUrl = null;
    this.wantedListId = null;
    if (listId && this.hasList(listId)) {
      this.showList(listId);
      return;
    }
    // The entry points at a list that no longer exists: keep the current list.
    if (this.activeListId) {
      replaceListIdInUrl(this.activeListId);
    }
  }

  handleAddList() {
    if (!this.lists || !this.repository) return;
    const response = window.prompt?.("Name for the new list");
    if (response == null) return;
    const trimmed = response.trim();
    if (!trimmed.length) return;
    this.closeListsPanel();
    const id = generateListId("list");
    this.listIdToPushToUrl = id;
    this.wantedListId = id;
    Promise.resolve(
      this.repository.createList({ listId: id, title: trimmed })
    ).catch(() => {
      if (this.listIdToPushToUrl === id) {
        this.listIdToPushToUrl = null;
      }
      if (this.wantedListId === id) {
        this.wantedListId = null;
      }
    });
  }

  /** A list renamed itself: its new name shows here too until it is saved. */
  handleListRename(event: Event) {
    const { listId, title, saved } = (
      event as CustomEvent<{ listId: ListId | null; title: string; saved: Promise<unknown> | null }>
    ).detail;
    if (listId) this.lists?.rename(listId, title, saved);
  }

  handleDeleteList() {
    if (!this.lists) return;
    const entries = this.listEntries();
    const activeListId = this.activeListId;
    const listOrder = entries.map((entry) => entry.id);
    if (!activeListId) return;
    if (listOrder.length <= 1) {
      window.alert?.("At least one list must remain.");
      return;
    }
    const listName = entries.find((entry) => entry.id === activeListId)?.name ?? "Untitled List";
    const confirmed = window.confirm?.(
      `Delete "${listName}" and all of its tasks?`
    );
    if (!confirmed) return;
    const removeId = activeListId;
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
    this.wantedListId = fallbackId;
    if (fallbackId) {
      this.showList(fallbackId);
    }
    this.lists.remove(removeId);
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

  /** A list was dragged in the sidebar, between two others. */
  handleSidebarReorder({
    id,
    afterId,
    beforeId,
  }: {
    id: ListId;
    afterId: ListId | null;
    beforeId: ListId | null;
  }) {
    this.lists?.move(id, afterId, beforeId);
  }

  applySearchToLists(query: string) {
    this.mainElement?.listElements?.().forEach((element) => element.applyFilter?.(query));
  }

  getSearchMatchCountForList(listId: ListId, tokens: string[]) {
    // Query the list element directly for its current match count, since the
    // element updates optimistically and may be ahead of the repository
    const element = this.listElement(listId);
    if (element && typeof element.getSearchMatchCountForQuery === "function") {
      return element.getSearchMatchCountForQuery(tokens.join(" "));
    }
    // Fallback to repository if element not available
    if (!this.repository) return 0;
    const state = this.repository.getListState(listId);
    const items = Array.isArray(state?.items) ? state.items : [];
    const showDone = false;
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

  getListTotalCount(listId: ListId) {
    // Query the list element directly for its current count, since the element
    // updates optimistically and may be ahead of the repository
    const element = this.listElement(listId);
    if (element) {
      return element.getTotalItemCount();
    }
    // Fallback to repository if element not available
    if (!this.repository) return 0;
    const state = this.repository.getListState(listId);
    return (state?.items ?? []).filter((item) => !item?.done).length;
  }

  refreshSidebar() {
    if (!this.lists) return;
    const searchMode = this.isSearchMode();
    const tokens = searchMode ? tokenizeSearchQuery(this.searchQuery) : [];
    const data = this.listEntries().map((entry) => {
      const totalCount = this.getListTotalCount(entry.id);
      const matchCount = searchMode
        ? this.getSearchMatchCountForList(entry.id, tokens)
        : totalCount;
      return {
        ...entry,
        countLabel: searchMode
          ? formatMatchCount(matchCount)
          : formatTotalCount(totalCount),
      };
    });
    this.sidebarElement?.setLists?.(data, {
      activeListId: this.activeListId,
      searchQuery: this.searchQuery,
    });
  }

  updateMainHeading() {
    if (!this.lists) return;
    if (this.isSearchMode()) {
      const query = this.searchQuery.trim();
      if (query.length) {
        this.mainElement?.setTitle?.(`Search: "${query}"`);
      } else {
        this.mainElement?.setTitle?.("Search Results");
      }
      return;
    }
    const active = this.listEntries().find((entry) => entry.id === this.activeListId);
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
    if (!this.lists || !this.repository) return;
    const lists = this.lists.shown.map(({ id }) => ({ id }));
    this.mainElement.renderLists?.(lists, {
      activeListId: activeId,
      searchMode,
      repository: this.repository,
    });
    const query =
      typeof searchQuery === "string" ? searchQuery.trim() : "";
    if (query.length) {
      const needsSync = this.mainElement
        .listElements?.()
        .some((element) => element.searchQuery !== query);
      if (needsSync) {
        this.applySearchToLists(query);
      }
    }
  }
}

customElements.define("a4-lists-app", ListsAppShellElement);
