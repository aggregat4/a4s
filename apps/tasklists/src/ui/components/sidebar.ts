import { html, render } from "../../vendor/lit-html.js";
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
  }>;
  private searchDebounceId: ReturnType<typeof setTimeout> | null;
  private currentLists: SidebarListEntry[];
  private activeListId: ListId | null;
  private currentSearch: string;
  private dropTargetDepth: Map<HTMLElement, number>;
  private searchSeq: number;

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
    this.handleSearchInput = this.handleSearchInput.bind(this);
    this.handleSearchKeyDown = this.handleSearchKeyDown.bind(this);
    this.handleListDragEnter = this.handleListDragEnter.bind(this);
    this.handleListDragOver = this.handleListDragOver.bind(this);
    this.handleListDragLeave = this.handleListDragLeave.bind(this);
    this.handleListDrop = this.handleListDrop.bind(this);
    this.handleGlobalDragEnd = this.handleGlobalDragEnd.bind(this);
    this.handleSidebarButtonClick = this.handleSidebarButtonClick.bind(this);
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
  }

  setSearchValue(value: string) {
    const next = value ?? "";
    clearTimeout(this.searchDebounceId);
    this.searchDebounceId = null;
    this.searchSeq += 1;
    this.currentSearch = next;
    this.renderView();
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
    this.currentLists = Array.isArray(lists) ? lists : [];
    this.activeListId = activeListId ?? null;
    if (typeof searchQuery === "string") {
      this.setSearchValue(searchQuery);
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
                <li>
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
      this.renderView();
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
    const payload = this.parseTaskData(event.dataTransfer);
    const hasPayload = payload || this.hasTaskPayload(event.dataTransfer);
    if (!hasPayload) return;
    if (payload && payload.sourceListId === button.dataset.listId) return;
    event.preventDefault();
    if (this.dropTargetDepth.size) {
      const others = (
        Array.from(this.dropTargetDepth.keys()) as HTMLElement[]
      ).filter((btn) => btn !== button);
      others.forEach((btn) => {
        btn.classList.remove("is-drop-target");
        this.dropTargetDepth.delete(btn);
      });
    }
    const nextDepth = (this.dropTargetDepth.get(button) ?? 0) + 1;
    this.dropTargetDepth.set(button, nextDepth);
    button.classList.add("is-drop-target");
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
    const nextDepth = (this.dropTargetDepth.get(button) ?? 1) - 1;
    if (nextDepth <= 0) {
      this.dropTargetDepth.delete(button);
      button.classList.remove("is-drop-target");
    } else {
      this.dropTargetDepth.set(button, nextDepth);
    }
  }

  handleListDrop(event: DragEvent) {
    const button = event.currentTarget as HTMLElement | null;
    if (!button) return;
    const payload = this.parseTaskData(event.dataTransfer);
    button.classList.remove("is-drop-target");
    this.dropTargetDepth.delete(button);
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
}

customElements.define("a4-sidebar", SidebarElement);
