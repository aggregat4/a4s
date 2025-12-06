import { html, render } from "../../vendor/lit-html.js";

class SidebarElement extends HTMLElement {
  constructor() {
    super();
    this.handlers = {};
    this.searchInput = null;
    this.listContainer = null;
    this.addButton = null;
    this.deleteButton = null;
    this.searchDebounceId = null;
    this.currentLists = [];
    this.activeListId = null;
    this.currentSearch = "";
    this.dropTargetDepth = new Map();
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
    this.cacheElements();
  }

  disconnectedCallback() {
    this.destroy();
  }

  setHandlers(handlers = {}) {
    this.handlers = handlers ?? {};
  }

  cacheElements() {
    this.searchInput =
      this.querySelector("[data-role='global-search']") ?? null;
    this.listContainer =
      this.querySelector("[data-role='sidebar-list']") ?? null;
    this.addButton = this.querySelector("[data-role='add-list']") ?? null;
    this.deleteButton = this.querySelector("[data-role='delete-list']") ?? null;
  }

  init() {
    this.cacheElements();
    this.searchInput?.addEventListener("input", this.handleSearchInput);
    this.searchInput?.addEventListener("keydown", this.handleSearchKeyDown);
    this.addButton?.addEventListener("click", () =>
      this.handlers.onAddList?.()
    );
    this.deleteButton?.addEventListener("click", () =>
      this.handlers.onDeleteList?.()
    );
    this.renderLists();
    this.updateActionStates();
    document.addEventListener("dragend", this.handleGlobalDragEnd);
  }

  destroy() {
    this.searchInput?.removeEventListener("input", this.handleSearchInput);
    this.searchInput?.removeEventListener("keydown", this.handleSearchKeyDown);
    clearTimeout(this.searchDebounceId);
    document.removeEventListener("dragend", this.handleGlobalDragEnd);
  }

  setSearchValue(value) {
    const next = value ?? "";
    if (this.searchInput && this.searchInput.value !== next) {
      this.searchInput.value = next;
    }
    this.currentSearch = next;
  }

  setLists(lists, { activeListId, searchQuery } = {}) {
    this.currentLists = Array.isArray(lists) ? lists : [];
    this.activeListId = activeListId ?? null;
    if (typeof searchQuery === "string") {
      this.setSearchValue(searchQuery);
    }
    this.renderLists();
    this.updateActionStates();
  }

  updateActionStates() {
    const listCount = this.currentLists.length;
    if (this.deleteButton) {
      this.deleteButton.disabled = listCount <= 1 || !this.activeListId;
    }
  }

  renderLists() {
    if (!this.listContainer) return;
    render(
      html`${this.currentLists.map((list) => {
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
              <span class="sidebar-list-count">${list.countLabel ?? ""}</span>
            </button>
          </li>
        `;
      })}`,
      this.listContainer
    );
  }

  handleSidebarButtonClick(event) {
    const button = event.currentTarget;
    const listId = button?.dataset?.listId;
    if (!listId) return;
    this.handlers.onSelectList?.(listId);
  }

  handleSearchInput(event) {
    const value = event?.target?.value ?? "";
    clearTimeout(this.searchDebounceId);
    this.searchDebounceId = setTimeout(() => {
      this.handlers.onSearchChange?.(value);
    }, 150);
  }

  handleSearchKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.searchInput) {
        this.searchInput.value = "";
      }
      this.handlers.onSearchChange?.("");
    }
  }

  parseTaskData(dataTransfer) {
    if (!dataTransfer) return null;
    const types = Array.from(dataTransfer.types ?? []);
    if (!types.includes("application/x-a4-task")) return null;
    try {
      const payload = dataTransfer.getData("application/x-a4-task");
      if (!payload) return null;
      return JSON.parse(payload);
    } catch (err) {
      return null;
    }
  }

  hasTaskPayload(dataTransfer) {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.types ?? []).includes(
      "application/x-a4-task"
    );
  }

  handleListDragEnter(event) {
    const button = event.currentTarget;
    const payload = this.parseTaskData(event.dataTransfer);
    const hasPayload = payload || this.hasTaskPayload(event.dataTransfer);
    if (!hasPayload) return;
    if (payload && payload.sourceListId === button.dataset.listId) return;
    event.preventDefault();
    if (this.dropTargetDepth.size) {
      const others = Array.from(this.dropTargetDepth.keys()).filter(
        (btn) => btn !== button
      );
      others.forEach((btn) => {
        btn.classList.remove("is-drop-target");
        this.dropTargetDepth.delete(btn);
      });
    }
    const nextDepth = (this.dropTargetDepth.get(button) ?? 0) + 1;
    this.dropTargetDepth.set(button, nextDepth);
    button.classList.add("is-drop-target");
  }

  handleListDragOver(event) {
    const button = event.currentTarget;
    const payload = this.parseTaskData(event.dataTransfer);
    const hasPayload = payload || this.hasTaskPayload(event.dataTransfer);
    if (!hasPayload) return;
    if (payload && payload.sourceListId === button.dataset.listId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  handleListDragLeave(event) {
    const button = event.currentTarget;
    if (button.contains(event.relatedTarget)) {
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

  handleListDrop(event) {
    const button = event.currentTarget;
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
