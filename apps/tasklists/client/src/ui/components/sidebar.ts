import { html, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import DraggableBehavior, { FlipAnimator } from "../../shared/drag-behavior.js";
import { APP_VERSION, fetchServerVersion } from "../../app/version.js";
import type { ListId, TaskItem } from "../../types/domain.js";
import type { SyncStatus } from "../../types/sync.js";
import type { HistoryAvailability } from "../../app/history-manager.js";
import { SHORTCUTS, formatShortcutParts } from "../state/shortcuts.js";
import { redoIcon, undoIcon } from "./history-icons.js";

type SidebarListEntry = {
  id: ListId;
  name: string;
  countLabel?: string;
};

type TaskDragPayload = {
  sourceListId: ListId;
  itemId: string;
  item?: TaskItem;
};

type SidebarHandlers = Partial<{
  onAddList: () => void;
  onDeleteList: () => void;
  onExportSnapshot: () => void;
  onImportSnapshot: () => void;
  onSeedDemo: () => void;
  onSelectList: (listId: ListId) => void;
  onSearchChange: (value: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onItemDropped: (payload: TaskDragPayload, targetListId: ListId) => void;
  /** A list was dragged between two others. */
  onReorderList: (move: ListMove) => void;
}>;

/** Where a dragged list was dropped: between two lists. */
type ListMove = { id: ListId; afterId: ListId | null; beforeId: ListId | null };

const listIdOf = (element: Element | null) =>
  (element as HTMLElement | null)?.dataset.itemId ?? null;

class SidebarElement extends HTMLElement {
  private handlers: SidebarHandlers;
  private searchDebounceId: ReturnType<typeof setTimeout> | null;
  private currentLists: SidebarListEntry[];
  private activeListId: ListId | null;
  private currentSearch: string;
  private dropTargetDepth: Map<HTMLElement, number>;
  private searchSeq: number;
  private dragCoordinator: DraggableBehavior | null;
  private isListDragging: boolean;
  /** A render asked for during a drag, done once the drag is over. */
  private pendingRender: boolean;
  /** A drop to save once the drag is over. */
  private dragMove: ListMove | null;
  private showDemoSeed: boolean;
  private actionsOpen: boolean;
  private isOnline: boolean;
  private syncStatus: SyncStatus | null;
  private historyState: HistoryAvailability;
  private serverVersion: string | null;
  private serverVersionLoading: boolean;
  /** Aborted when the element is disconnected, removing its listeners. */
  private connection: AbortController | null;

  private static readonly TASK_MIME = "application/x-a4-task";

  constructor() {
    super();
    this.handlers = {};
    this.searchDebounceId = null;
    this.currentLists = [];
    this.activeListId = null;
    this.currentSearch = "";
    this.dropTargetDepth = new Map<HTMLElement, number>();
    this.searchSeq = 0;
    this.dragCoordinator = null;
    this.isListDragging = false;
    this.pendingRender = false;
    this.dragMove = null;
    this.showDemoSeed = false;
    this.actionsOpen = false;
    this.isOnline = true;
    this.syncStatus = null;
    this.historyState = { canUndo: false, canRedo: false };
    this.serverVersion = null;
    this.serverVersionLoading = false;
    this.connection = null;
  }

  connectedCallback() {
    this.classList.add("lists-sidebar");
    if (!this.dataset.role) {
      this.dataset.role = "sidebar";
    }
    this.connection = new AbortController();
    const { signal } = this.connection;
    this.isOnline = navigator.onLine !== false;
    window.addEventListener("online", () => this.handleOnlineChange(), { signal });
    window.addEventListener("offline", () => this.handleOnlineChange(), { signal });
    document.addEventListener("dragend", () => this.handleGlobalDragEnd(), { signal });
    this.renderView();
  }

  disconnectedCallback() {
    this.connection?.abort();
    this.connection = null;
    clearTimeout(this.searchDebounceId ?? undefined);
    this.dragCoordinator?.destroy();
    this.dragCoordinator = null;
    this.isListDragging = false;
    this.pendingRender = false;
    this.dragMove = null;
  }

  setHandlers(handlers: SidebarHandlers = {}) {
    this.handlers = handlers ?? {};
  }

  setDemoSeedEnabled(enabled: boolean) {
    this.showDemoSeed = Boolean(enabled);
    this.requestRender();
  }

  setHistoryState(state: HistoryAvailability) {
    if (
      this.historyState.canUndo === state.canUndo &&
      this.historyState.canRedo === state.canRedo
    ) {
      return;
    }
    this.historyState = { ...state };
    this.requestRender();
  }

  setSyncStatus(status: SyncStatus) {
    if (this.syncStatus === status) return;
    this.syncStatus = status;
    this.requestRender();
  }

  /**
   * Browser connectivity drives the indicator first — it stays correct even
   * when the sync engine has been torn down on a connection error — refined
   * by the engine's own signal so a server that's unreachable while still
   * online reads as disconnected.
   */
  private derivedSyncStatus(): SyncStatus {
    return this.isOnline && this.syncStatus !== "disconnected"
      ? "connected"
      : "disconnected";
  }

  handleOnlineChange() {
    const next = navigator.onLine !== false;
    if (next === this.isOnline) return;
    this.isOnline = next;
    // Optimistically clear a stale "disconnected" the moment connectivity
    // returns; a still-unreachable server re-asserts it on the next failed
    // flush.
    if (next) this.syncStatus = "connected";
    this.renderView();
  }

  setSearchValue(value: string) {
    const next = value ?? "";
    clearTimeout(this.searchDebounceId ?? undefined);
    this.searchDebounceId = null;
    this.searchSeq += 1;
    this.currentSearch = next;
    this.requestRender();
    const input = this.querySelector(
      "[data-role='global-search']"
    ) as HTMLInputElement | null;
    if (input && input.value !== next) {
      input.value = next;
    }
  }

  setLists(
    lists: SidebarListEntry[],
    { activeListId, searchQuery }: { activeListId?: ListId | null; searchQuery?: string } = {}
  ) {
    const nextLists = Array.isArray(lists) ? lists : [];
    const nextActiveId = activeListId ?? null;
    const nextSearch =
      typeof searchQuery === "string" ? searchQuery : this.currentSearch;
    const searchChanged = nextSearch !== this.currentSearch;
    this.currentLists = nextLists;
    this.activeListId = nextActiveId;
    if (searchChanged) {
      this.setSearchValue(nextSearch);
      return;
    }
    this.requestRender();
  }

  /** Renders now, or once a drag is over: a render would move what is dragged. */
  requestRender() {
    if (this.isListDragging) this.pendingRender = true;
    else this.renderView();
  }

  renderView() {
    const deleteDisabled =
      this.currentLists.length <= 1 || !this.activeListId;
    const syncStatus = this.derivedSyncStatus();
    const syncLabel =
      syncStatus === "connected" ? "Connected" : "Disconnected";
    const syncSymbol = syncStatus === "connected" ? "●" : "×";
    render(
      html`
        <div class="sidebar-content">
          <div class="sidebar-topbar">
            <div class="sidebar-title-row">
              <h1 class="sidebar-title sr-only">Lists</h1>
              <div class="sidebar-history" role="group" aria-label="History">
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Undo"
                  title=${`Undo (${formatShortcutParts(SHORTCUTS.undo).join("+")})`}
                  ?disabled=${!this.historyState.canUndo}
                  @click=${() => this.handlers.onUndo?.()}
                >
                  ${undoIcon}
                </button>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Redo"
                  title=${`Redo (${formatShortcutParts(SHORTCUTS.redo).join("+")})`}
                  ?disabled=${!this.historyState.canRedo}
                  @click=${() => this.handlers.onRedo?.()}
                >
                  ${redoIcon}
                </button>
              </div>
            </div>
            <div class="sidebar-search-row">
              <label class="sidebar-field sidebar-field-inline">
                <input
                  type="search"
                  class="sidebar-search-input"
                  placeholder="Search across all lists…"
                  aria-label="Global search"
                  data-role="global-search"
                  .value=${this.currentSearch}
                  @input=${this.handleSearchInput}
                  @keydown=${this.handleSearchKeyDown}
                />
              </label>
            </div>
          </div>
          <div class="sidebar-sections" id="sidebar-sections">
            <nav class="sidebar-section sidebar-lists" aria-label="Available lists">
              <ul class="sidebar-list" data-role="sidebar-list"></ul>
            </nav>
            <details
              class="sidebar-actions-disclosure"
              ?open=${this.actionsOpen}
              @toggle=${this.handleActionsToggle}
            >
              <summary class="sidebar-actions-toggle">
                <span class="sidebar-actions-toggle-label">Options</span>
                <span class="sidebar-status">
                  <span
                    class="sidebar-sync-indicator is-${syncStatus}"
                    role="status"
                    aria-live="polite"
                    aria-label=${syncLabel}
                    title=${syncLabel}
                    >${syncSymbol}</span
                  >
                </span>
              </summary>
              <div class="sidebar-actions-panel">
                <div class="sidebar-section sidebar-actions">
                  <button
                    type="button"
                    data-role="add-list"
                    @click=${() => this.handlers.onAddList?.()}
                  >
                    Add list
                  </button>
                  ${this.showDemoSeed
                    ? html`
                        <button
                          type="button"
                          data-role="seed-demo"
                          @click=${() => this.handlers.onSeedDemo?.()}
                        >
                          Load demo data
                        </button>
                      `
                    : null}
                  <button
                    type="button"
                    class="danger"
                    data-role="delete-list"
                    ?disabled=${deleteDisabled}
                    @click=${() => this.handlers.onDeleteList?.()}
                  >
                    Delete list
                  </button>
                </div>
                <div class="sidebar-section sidebar-actions sidebar-actions-secondary">
                  <button
                    type="button"
                    data-role="export-snapshot"
                    @click=${() => this.handlers.onExportSnapshot?.()}
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    data-role="import-snapshot"
                    @click=${() => this.handlers.onImportSnapshot?.()}
                  >
                    Import
                  </button>
                </div>
                <dl class="sidebar-version" data-role="app-versions">
                  <dt>Service</dt>
                  <dd>${this.serverVersion ?? "unknown"}</dd>
                  <dt>Client</dt>
                  <dd>${APP_VERSION}</dd>
                </dl>
              </div>
            </details>
          </div>
        </div>
      `,
      this,
      { host: this }
    );
    this.renderRows();
    this.ensureDragBehavior();
  }

  /** The lists, in their own render root so a drag can be followed by a fresh one. */
  renderRows() {
    const listEl = this.querySelector<HTMLElement>("[data-role='sidebar-list']");
    if (!listEl) return;
    render(
      repeat(
        this.currentLists,
        (list) => list.id,
        (list) => {
          const isActive = list.id === this.activeListId;
          const buttonClass = isActive
            ? "sidebar-list-button is-active"
            : "sidebar-list-button";
          return html`
            <li
              data-item-id=${list.id}
              class=${isActive ? "is-active" : ""}
            >
              <button
                type="button"
                class=${buttonClass}
                data-list-id=${list.id}
                aria-current=${isActive ? "true" : undefined}
                @click=${this.handleSidebarButtonClick}
                @dragenter=${this.handleListDragEnter}
                @dragover=${this.handleListDragOver}
                @dragleave=${this.handleListDragLeave}
                @drop=${this.handleListDrop}
                >
                <span class="sidebar-list-label">${list.name}</span>
                <span class="sidebar-list-count"
                  >${list.countLabel ?? ""}</span
                >
                <span
                  class="sidebar-list-handle handle"
                  draggable="true"
                  aria-hidden="true"
                ></span>
              </button>
            </li>
          `;
        }
      ),
      listEl,
      { host: this }
    );
  }

  handleActionsToggle(event: Event) {
    const disclosure = event.currentTarget as HTMLDetailsElement | null;
    if (!disclosure) return;
    this.actionsOpen = disclosure.open;
    if (this.actionsOpen) {
      void this.loadServerVersion();
    }
  }

  private async loadServerVersion() {
    if (this.serverVersion || this.serverVersionLoading) return;
    this.serverVersionLoading = true;
    try {
      const version = await fetchServerVersion();
      if (!version) return;
      this.serverVersion = version;
      this.requestRender();
    } finally {
      this.serverVersionLoading = false;
    }
  }

  handleSidebarButtonClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
    const listId = button?.dataset?.listId;
    if (!listId) return;
    this.handlers.onSelectList?.(listId);
  }

  handleSearchInput(event: Event) {
    const target = event?.target as HTMLInputElement | null;
    const value = target?.value ?? "";
    this.currentSearch = value;
    clearTimeout(this.searchDebounceId ?? undefined);
    const token = ++this.searchSeq;
    this.searchDebounceId = setTimeout(() => {
      if (token !== this.searchSeq) return;
      this.handlers.onSearchChange?.(value);
    }, 150);
  }

  handleSearchKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (event.target) {
        const target = event.target as HTMLInputElement | null;
        if (target) {
          target.value = "";
        }
      }
      this.currentSearch = "";
      this.handlers.onSearchChange?.("");
      this.requestRender();
    }
  }

  parseTaskData(dataTransfer: DataTransfer | null): TaskDragPayload | null {
    if (!dataTransfer) return null;
    const types = Array.from(dataTransfer.types ?? []);
    if (!types.includes(SidebarElement.TASK_MIME)) return null;
    try {
      const payload = dataTransfer.getData(SidebarElement.TASK_MIME);
      if (!payload) return null;
      return JSON.parse(payload);
    } catch (err) {
      return null;
    }
  }

  hasTaskPayload(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.types ?? []).includes(SidebarElement.TASK_MIME);
  }

  handleListDragEnter(event: DragEvent) {
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    const row = button.closest("li");
    if (!row) return;
    const payload = this.parseTaskData(event.dataTransfer);
    const hasPayload = payload || this.hasTaskPayload(event.dataTransfer);
    if (!hasPayload) return;
    if (payload && payload.sourceListId === button.dataset.listId) return;
    event.preventDefault();
    if (this.dropTargetDepth.size) {
      const others = (
        Array.from(this.dropTargetDepth.keys()) as HTMLElement[]
      ).filter((item) => item !== row);
      others.forEach((item) => {
        item.classList.remove("is-drop-target");
        this.dropTargetDepth.delete(item);
      });
    }
    const nextDepth = (this.dropTargetDepth.get(row) ?? 0) + 1;
    this.dropTargetDepth.set(row, nextDepth);
    row.classList.add("is-drop-target");
  }

  handleListDragOver(event: DragEvent) {
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    const payload = this.parseTaskData(event.dataTransfer);
    const hasPayload = payload || this.hasTaskPayload(event.dataTransfer);
    if (!hasPayload) return;
    if (payload && payload.sourceListId === button.dataset.listId) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  handleListDragLeave(event: DragEvent) {
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    if (button.contains(event.relatedTarget as Node | null)) {
      return;
    }
    const row = button.closest("li");
    if (!row) return;
    const nextDepth = (this.dropTargetDepth.get(row) ?? 1) - 1;
    if (nextDepth <= 0) {
      this.dropTargetDepth.delete(row);
      row.classList.remove("is-drop-target");
    } else {
      this.dropTargetDepth.set(row, nextDepth);
    }
  }

  handleListDrop(event: DragEvent) {
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    const row = button.closest("li");
    if (!row) return;
    const payload = this.parseTaskData(event.dataTransfer);
    row.classList.remove("is-drop-target");
    this.dropTargetDepth.delete(row);
    if (!payload) return;
    const targetListId = button.dataset.listId;
    if (!targetListId || payload.sourceListId === targetListId) return;
    event.preventDefault();
    this.handlers.onItemDropped?.(payload, targetListId);
  }

  handleGlobalDragEnd() {
    if (!this.dropTargetDepth.size) return;
    this.dropTargetDepth.forEach((_, button) => {
      button.classList.remove("is-drop-target");
    });
    this.dropTargetDepth.clear();
  }

  ensureDragBehavior() {
    const listEl = this.querySelector(
      "[data-role='sidebar-list']"
    ) as HTMLElement | null;
    if (!listEl) return;
    if (!this.dragCoordinator) {
      this.dragCoordinator = new DraggableBehavior(listEl, {
        handleClass: "handle",
        animator: new FlipAnimator(),
        onReorder: (fromIndex, toIndex) =>
          this.handleListReorder(fromIndex, toIndex),
        onDragStart: (event) => this.handleListDragStart(event),
        onDragEnd: () => this.handleListDragEnd(),
        onDrop: () => this.handleListDragEnd(),
      });
      this.dragCoordinator.enable();
    }
  }

  handleListDragStart(event: DragEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains("handle") || !target.closest("li")) return;
    this.isListDragging = true;
    this.dragMove = null;
  }

  /** The drag moves the list's element, so its new neighbours are there. */
  handleListReorder(fromIndex: number, toIndex: number) {
    const listEl = this.querySelector<HTMLElement>("[data-role='sidebar-list']");
    const item = listEl?.children[toIndex] ?? null;
    const id = listIdOf(item);
    if (fromIndex === toIndex || !item || !id) return;
    this.dragMove = {
      id,
      afterId: listIdOf(item.previousElementSibling),
      beforeId: listIdOf(item.nextElementSibling),
    };
  }

  /** Saves where a list was dropped, once the drag is over. */
  handleListDragEnd() {
    if (!this.isListDragging) return;
    this.isListDragging = false;
    const move = this.dragMove;
    this.dragMove = null;
    if (move) {
      // The drag moved the list's element behind lit's back, which confuses
      // its bookkeeping of the lists: render them afresh.
      const listEl = this.querySelector("[data-role='sidebar-list']");
      if (listEl) {
        delete (listEl as HTMLElement & { _$litPart$?: unknown })._$litPart$;
        listEl.textContent = "";
        this.dragCoordinator?.invalidateItemsCache();
      }
      this.handlers.onReorderList?.(move);
    }
    if (move || this.pendingRender) {
      this.pendingRender = false;
      this.renderView();
    }
  }
}

customElements.define("a4-sidebar", SidebarElement);
