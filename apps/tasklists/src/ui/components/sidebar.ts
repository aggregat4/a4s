import { html, render } from "lit";
import { DragCoordinator } from "./drag-coordinator.js";
import { FlipAnimator } from "../../shared/drag-behavior.js";
import type { ListId, TaskItem } from "../../types/domain.js";

type SidebarListEntry = {
  id: ListId;
  name: string;
  countLabel?: string;
  totalCount: number;
  matchCount: number;
};

type TaskDragPayload = {
  sourceListId: ListId;
  itemId: string;
  item?: TaskItem;
};

class SidebarElement extends HTMLElement {
  private handlers: Partial<{
    onAddList: () => void;
    onDeleteList: () => void;
    onSelectList: (listId: ListId) => void;
    onSearchChange: (value: string) => void;
    onItemDropped: (payload: TaskDragPayload, targetListId: ListId) => void;
    onReorderList: (payload: {
      movedId: ListId;
      order: ListId[];
    }) => void;
  }>;
  private searchDebounceId: ReturnType<typeof setTimeout> | null;
  private currentLists: SidebarListEntry[];
  private activeListId: ListId | null;
  private currentSearch: string;
  private dropTargetDepth: Map<HTMLElement, number>;
  private searchSeq: number;
  private dragCoordinator: DragCoordinator | null;
  private dragStartOrder: ListId[] | null;
  private isListDragging: boolean;
  private pendingRender: boolean;
  private pendingRenderMode: "reorder" | "render" | null;

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
    this.dragStartOrder = null;
    this.isListDragging = false;
    this.pendingRender = false;
    this.pendingRenderMode = null;
    this.handleSearchInput = this.handleSearchInput.bind(this);
    this.handleSearchKeyDown = this.handleSearchKeyDown.bind(this);
    this.handleListDragEnter = this.handleListDragEnter.bind(this);
    this.handleListDragOver = this.handleListDragOver.bind(this);
    this.handleListDragLeave = this.handleListDragLeave.bind(this);
    this.handleListDrop = this.handleListDrop.bind(this);
    this.handleGlobalDragEnd = this.handleGlobalDragEnd.bind(this);
    this.handleSidebarButtonClick = this.handleSidebarButtonClick.bind(this);
    this.handleListDragStart = this.handleListDragStart.bind(this);
    this.handleListDragEnd = this.handleListDragEnd.bind(this);
    this.handleListReorder = this.handleListReorder.bind(this);
  }

  connectedCallback() {
    this.classList.add("lists-sidebar");
    if (!this.dataset.role) {
      this.dataset.role = "sidebar";
    }
    this.renderView();
  }

  disconnectedCallback() {
    this.destroy();
  }

  setHandlers(
    handlers: Partial<{
      onAddList: () => void;
      onDeleteList: () => void;
      onSelectList: (listId: ListId) => void;
      onSearchChange: (value: string) => void;
      onItemDropped: (payload: TaskDragPayload, targetListId: ListId) => void;
      onReorderList: (payload: {
        movedId: ListId;
        order: ListId[];
      }) => void;
    }> = {}
  ) {
    this.handlers = handlers ?? {};
  }

  init() {
    this.renderView();
    document.addEventListener("dragend", this.handleGlobalDragEnd);
  }

  destroy() {
    clearTimeout(this.searchDebounceId);
    document.removeEventListener("dragend", this.handleGlobalDragEnd);
    this.dragCoordinator?.destroy();
    this.dragCoordinator = null;
    this.dragStartOrder = null;
    this.isListDragging = false;
    this.pendingRender = false;
    this.pendingRenderMode = null;
  }

  setSearchValue(value: string) {
    const next = value ?? "";
    clearTimeout(this.searchDebounceId);
    this.searchDebounceId = null;
    this.searchSeq += 1;
    this.currentSearch = next;
    if (this.isListDragging) {
      this.pendingRender = true;
      this.pendingRenderMode = "render";
    } else {
      this.renderView();
    }
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
    const reorderOnly = !searchChanged
      ? this.isReorderOnlyUpdate(nextLists, nextActiveId, nextSearch)
      : false;

    this.currentLists = nextLists;
    this.activeListId = nextActiveId;

    if (searchChanged) {
      this.setSearchValue(nextSearch);
      return;
    }

    if (this.isListDragging) {
      this.pendingRender = true;
      this.pendingRenderMode = reorderOnly ? "reorder" : "render";
      return;
    }

    if (reorderOnly) {
      this.syncListDomOrder();
      return;
    }

    this.renderView();
  }

  renderView() {
    const deleteDisabled =
      this.currentLists.length <= 1 || !this.activeListId;
    render(
      html`
        <div class="sidebar-header">
          <h1 class="sidebar-title">Lists</h1>
        </div>
        <div class="sidebar-section sidebar-search">
          <label class="sidebar-field">
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
        <nav class="sidebar-section sidebar-lists" aria-label="Available lists">
          <ul class="sidebar-list" data-role="sidebar-list">
            ${this.currentLists.map((list) => {
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
            })}
          </ul>
        </nav>
        <div class="sidebar-section sidebar-actions">
          <button type="button" data-role="add-list" @click=${() =>
            this.handlers.onAddList?.()}>
            Add list
          </button>
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
      `,
      this
    );
    this.ensureDragBehavior();
    this.syncListDomOrder();
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
    clearTimeout(this.searchDebounceId);
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
    if (this.isListDragging) {
      this.pendingRender = true;
      this.pendingRenderMode = "render";
    } else {
      this.renderView();
    }
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
    event.dataTransfer.dropEffect = "move";
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
      this.dragCoordinator = new DragCoordinator({
        handleClass: "handle",
        animator: new FlipAnimator(),
        onReorder: (fromIndex, toIndex) =>
          this.handleListReorder(fromIndex, toIndex),
        onDragStart: this.handleListDragStart,
        onDragEnd: this.handleListDragEnd,
        onDrop: this.handleListDragEnd,
      });
    }
    this.dragCoordinator.attach(listEl);
  }

  handleListDragStart(event: DragEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains("handle")) return;
    const li = target.closest("li");
    if (!li) return;
    this.isListDragging = true;
    this.dragStartOrder = this.getCurrentListOrder();
  }

  handleListDragEnd() {
    if (!this.isListDragging) return;
    this.isListDragging = false;
    this.dragStartOrder = null;
    if (this.pendingRender) {
      const mode = this.pendingRenderMode ?? "render";
      this.pendingRender = false;
      this.pendingRenderMode = null;
      if (mode === "reorder") {
        this.syncListDomOrder();
      } else {
        this.renderView();
      }
    }
  }

  handleListReorder(fromIndex: number, toIndex: number) {
    const order = this.getCurrentListOrder();
    const movedId =
      order[toIndex] ??
      (this.dragStartOrder ? this.dragStartOrder[fromIndex] : null);
    const beforeOrder = this.dragStartOrder ?? [];
    if (
      order.length &&
      movedId &&
      !this.areOrdersEqual(order, beforeOrder)
    ) {
      this.handlers.onReorderList?.({
        movedId,
        order,
      });
    }
  }

  getCurrentListOrder() {
    return Array.from(
      this.querySelectorAll<HTMLElement>("li[data-item-id]")
    )
      .map((item) => item.dataset.itemId)
      .filter(
        (id): id is string => typeof id === "string" && id.length > 0
      );
  }

  syncListDomOrder() {
    const listEl = this.querySelector(
      "[data-role='sidebar-list']"
    ) as HTMLElement | null;
    if (!listEl) return;
    const desiredOrder = this.currentLists.map((list) => list.id);
    if (!desiredOrder.length) return;
    const currentOrder = this.getCurrentListOrder();
    if (this.areOrdersEqual(currentOrder, desiredOrder)) return;
    const items = new Map(
      Array.from(listEl.querySelectorAll<HTMLElement>("li[data-item-id]")).map(
        (item) => [item.dataset.itemId ?? "", item]
      )
    );
    desiredOrder.forEach((id) => {
      const item = items.get(id);
      if (item) {
        listEl.appendChild(item);
      }
    });
    this.dragCoordinator?.invalidateItemsCache();
  }

  isReorderOnlyUpdate(
    nextLists: SidebarListEntry[],
    nextActiveId: ListId | null,
    nextSearch: string
  ) {
    if (nextActiveId !== this.activeListId) return false;
    if (nextSearch !== this.currentSearch) return false;
    if (nextLists.length !== this.currentLists.length) return false;
    const previousById = new Map(
      this.currentLists.map((entry) => [entry.id, entry])
    );
    if (previousById.size !== nextLists.length) return false;
    for (const entry of nextLists) {
      const prev = previousById.get(entry.id);
      if (!prev) return false;
      if (
        prev.name !== entry.name ||
        prev.countLabel !== entry.countLabel ||
        prev.totalCount !== entry.totalCount ||
        prev.matchCount !== entry.matchCount
      ) {
        return false;
      }
    }
    return true;
  }

  areOrdersEqual(a: ListId[] = [], b: ListId[] = []) {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

customElements.define("a4-sidebar", SidebarElement);
