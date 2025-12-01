import { html, render } from "../../vendor/lit-html.js";
import DraggableBehavior, { FlipAnimator } from "../../lib/drag-behavior.js";
import InlineTextEditor from "../../lib/inline-text-editor.js";
import {
  createStore,
  listReducer,
  LIST_ACTIONS,
  cloneListState,
  generateItemId,
} from "../state/list-store.js";
import {
  evaluateSearchEntry,
  tokenizeSearchQuery,
} from "../state/highlight-utils.js";

const escapeSelectorId = (value) => {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

// EditController queues follow-up edits so caret placement survives rerenders that
// happen between an action (merge, move) and the next paint.
class EditController {
  constructor({ getListElement, getInlineEditor }) {
    this.getListElement =
      typeof getListElement === "function" ? getListElement : () => null;
    this.getInlineEditor =
      typeof getInlineEditor === "function" ? getInlineEditor : () => null;
    this.pendingItemId = null;
    this.pendingCaret = null;
  }

  queue(itemId, caretPreference = null) {
    if (typeof itemId === "string" && itemId.length) {
      this.pendingItemId = itemId;
      this.pendingCaret = caretPreference ?? null;
    }
  }

  clear() {
    this.pendingItemId = null;
    this.pendingCaret = null;
  }

  hasPending() {
    return (
      typeof this.pendingItemId === "string" && this.pendingItemId.length > 0
    );
  }

  isPendingItem(itemId) {
    if (!this.hasPending()) return false;
    return this.pendingItemId === itemId;
  }

  getPendingEdit() {
    if (!this.hasPending()) return null;
    return {
      itemId: this.pendingItemId,
      caret: this.pendingCaret,
    };
  }

  getForceVisibleIds() {
    if (!this.hasPending()) return null;
    return new Set([this.pendingItemId]);
  }

  applyPendingEdit() {
    if (!this.hasPending()) return false;
    const listEl = this.getListElement();
    const inlineEditor = this.getInlineEditor();
    if (!listEl || !inlineEditor) return false;

    const selectorId = escapeSelectorId(this.pendingItemId);
    const targetLi = listEl.querySelector(`li[data-item-id="${selectorId}"]`);
    const textEl = targetLi?.querySelector(".text") ?? null;
    if (!textEl) {
      return false;
    }

    inlineEditor.startEditing(textEl, null, this.pendingCaret);
    this.clear();
    return true;
  }
}

// TaskListView keeps DOM reconciliation separate from state changes so we can reuse
// focused nodes and avoid churn when the reducer reorders items.
class TaskListView {
  constructor({ getListElement }) {
    this.getListElement =
      typeof getListElement === "function" ? getListElement : () => null;
  }

  captureFocus() {
    const listEl = this.getListElement();
    if (!listEl) return null;
    const activeElement = document.activeElement;
    if (!activeElement || !listEl.contains(activeElement)) return null;
    const activeLi = activeElement.closest("li");
    if (!activeLi?.dataset?.itemId) return null;
    const role = activeElement.classList.contains("done-toggle")
      ? "toggle"
      : activeElement.classList.contains("text")
      ? "text"
      : null;
    return role ? { itemId: activeLi.dataset.itemId, role } : null;
  }

  syncItems(items, { createItem, updateItem }) {
    const listEl = this.getListElement();
    if (!listEl || !Array.isArray(items)) return;
    const existingNodes = Array.from(listEl.children).filter(
      (li) => !li.classList.contains("placeholder")
    );
    const byId = new Map(existingNodes.map((li) => [li.dataset.itemId, li]));
    const usedNodes = new Set();
    let previous = null;

    const nextNonPlaceholder = (node) => {
      while (node && node.classList?.contains("placeholder")) {
        node = node.nextSibling;
      }
      return node;
    };

    items.forEach((item) => {
      let li = byId.get(item.id);
      if (!li) {
        li = createItem(item);
      } else {
        updateItem(li, item);
      }
      usedNodes.add(li);
      const desired = previous
        ? nextNonPlaceholder(previous.nextSibling)
        : nextNonPlaceholder(listEl.firstChild);
      if (li !== desired) {
        listEl.insertBefore(li, desired || null);
      }
      previous = li;
    });

    existingNodes.forEach((li) => {
      if (!usedNodes.has(li)) {
        li.remove();
      }
    });
  }

  restoreFocus(preservedFocus, { skip } = {}) {
    if (skip || !preservedFocus) return;
    const listEl = this.getListElement();
    if (!listEl) return;
    const selectorId = escapeSelectorId(preservedFocus.itemId);
    const targetLi = listEl.querySelector(`li[data-item-id="${selectorId}"]`);
    if (!targetLi) return;
    const focusTarget =
      preservedFocus.role === "toggle"
        ? targetLi.querySelector(".done-toggle")
        : preservedFocus.role === "text"
        ? targetLi.querySelector(".text")
        : null;
    focusTarget?.focus();
  }
}

// Custom element binds the store, view, and behaviors together so the prototype
// remains drop-in embeddable without a framework runtime.
class A4TaskList extends HTMLElement {
  constructor() {
    super();
    this.listEl = null;
    this.dragBehavior = null;
    this.inlineEditor = null;
    this.headerEl = null;
    this.titleEl = null;
    this.searchInput = null;
    this.addButton = null;
    this.showDoneCheckbox = null;
    this.searchTimer = null;
    this.searchQuery = "";
    this.showDone = false;
    this.store = null;
    this.unsubscribe = null;
    this.suppressNameSync = false;
    this._initialState = null;
    this.patternConfig = this.normalizePatternDefs([
      {
        regex: /@[A-Za-z0-9_]+/g,
        className: "task-token-mention",
        priority: 2,
      },
      {
        regex: /#[A-Za-z0-9_]+/g,
        className: "task-token-tag",
        priority: 2,
      },
    ]);

    this.listIdentifier = this.dataset.listId ?? null;
    this.lastFocusedItemId = null;
    this.lastReportedMatches = null;
    this.lastReportedTotal = null;
    this.lastReportedQuery = "";
    this.lastReportedTitle = null;
    this.emptyStateEl = null;
    this.isTitleEditing = false;
    this.titleOriginalValue = "";
    this.openActionsItem = null;
    this.touchGestureState = new Map();

    this.handleSearchInput = this.handleSearchInput.bind(this);
    this.handleSearchKeyDown = this.handleSearchKeyDown.bind(this);
    this.handleSearchClear = this.handleSearchClear.bind(this);
    this.handleItemBlur = this.handleItemBlur.bind(this);
    this.handleToggle = this.handleToggle.bind(this);
    this.handleStoreChange = this.handleStoreChange.bind(this);
    this.handleEditCommit = this.handleEditCommit.bind(this);
    this.handleEditSplit = this.handleEditSplit.bind(this);
    this.handleEditMerge = this.handleEditMerge.bind(this);
    this.handleEditRemove = this.handleEditRemove.bind(this);
    this.handleEditMove = this.handleEditMove.bind(this);
    this.handleAddButtonClick = this.handleAddButtonClick.bind(this);
    this.handleShowDoneChange = this.handleShowDoneChange.bind(this);
    this.scheduleReorderUpdate = this.scheduleReorderUpdate.bind(this);
    this.handleMoveButtonClick = this.handleMoveButtonClick.bind(this);
    this.handleDeleteButtonClick = this.handleDeleteButtonClick.bind(this);
    this.handleActionToggleClick = this.handleActionToggleClick.bind(this);
    this.handleItemKeyDown = this.handleItemKeyDown.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.handleListDragStart = this.handleListDragStart.bind(this);
    this.handleTitleClick = this.handleTitleClick.bind(this);
    this.handleTitleKeyDown = this.handleTitleKeyDown.bind(this);
    this.handleTitleBlur = this.handleTitleBlur.bind(this);
    this.handleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.handleTouchGestureStart = this.handleTouchGestureStart.bind(this);
    this.handleTouchGestureEnd = this.handleTouchGestureEnd.bind(this);
    this.handleTouchGestureCancel = this.handleTouchGestureCancel.bind(this);

    this.editController = new EditController({
      getListElement: () => this.listEl,
      getInlineEditor: () => this.inlineEditor,
    });
    this.view = new TaskListView({
      getListElement: () => this.listEl,
    });
    this.pendingEditFlushRequested = false;
    this._repository = null;
    this.repositoryUnsubscribe = null;
  }

  static get observedAttributes() {
    return ["name"];
  }

  get initialState() {
    return this._initialState;
  }

  set initialState(value) {
    this.applyRepositoryState(value ?? { title: "", items: [] });
  }

  connectedCallback() {
    this.ensureList();
    if (!this.listEl) return;

    this.ensureHeader();
    if (this.searchInput) {
      this.searchInput.value = this.searchQuery;
    }
    if (this.showDoneCheckbox) {
      this.showDoneCheckbox.checked = this.showDone;
    }

    this.initializeStore();
    this.refreshRepositorySubscription();

    if (!this.dragBehavior) {
      this.dragBehavior = new DraggableBehavior(this.listEl, {
        handleClass: "handle",
        onReorder: (fromIndex, toIndex) => {
          const detail = { fromIndex, toIndex };
          this.listEl.dispatchEvent(new CustomEvent("reorder", { detail }));
          this.dispatchEvent(
            new CustomEvent("reorder", {
              detail,
              bubbles: true,
              composed: true,
            })
          );
          this.scheduleReorderUpdate();
        },
        animator: new FlipAnimator(),
      });
    }
    this.dragBehavior.enable();

    this.ensureInlineEditor();

    this.listEl.removeEventListener("blur", this.handleItemBlur, true);
    this.listEl.addEventListener("blur", this.handleItemBlur, true);
    this.listEl.removeEventListener("focusin", this.handleFocusIn);
    this.listEl.addEventListener("focusin", this.handleFocusIn);
    this.listEl.removeEventListener("dragstart", this.handleListDragStart);
    this.listEl.addEventListener("dragstart", this.handleListDragStart);
    this.listEl.removeEventListener("touchstart", this.handleTouchGestureStart);
    this.listEl.addEventListener("touchstart", this.handleTouchGestureStart, {
      passive: true,
    });
    this.listEl.removeEventListener("touchend", this.handleTouchGestureEnd);
    this.listEl.addEventListener("touchend", this.handleTouchGestureEnd, {
      passive: true,
    });
    this.listEl.removeEventListener(
      "touchcancel",
      this.handleTouchGestureCancel
    );
    this.listEl.addEventListener("touchcancel", this.handleTouchGestureCancel, {
      passive: true,
    });
    if (this.listIdentifier) {
      this.dataset.listId = this.listIdentifier;
    }
    this.performSearch(this.searchQuery);
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    document.addEventListener("pointerdown", this.handleDocumentPointerDown);
  }

  initializeStore() {
    const baseState = this.buildInitialState();
    if (!this.store) {
      this.store = createStore(listReducer, baseState);
    } else if (baseState) {
      this.store.dispatch({
        type: LIST_ACTIONS.replaceAll,
        payload: baseState,
      });
    }
    if (this.store && !this.unsubscribe) {
      this.unsubscribe = this.store.subscribe(this.handleStoreChange);
    }
    if (this.store) {
      this.handleStoreChange();
    }
  }

  refreshRepositorySubscription() {
    this.repositoryUnsubscribe?.();
    this.repositoryUnsubscribe = null;
    if (!this._repository || !this.listId) {
      return;
    }
    if (
      typeof this._repository.isInitialized === "function" &&
      !this._repository.isInitialized()
    ) {
      const maybePromise = this._repository.initialize?.();
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(() => {
          if (this._repository && this.listId) {
            this.refreshRepositorySubscription();
          }
        });
      }
      return;
    }
    const currentState = this._repository.getListState(this.listId);
    if (currentState) {
      this.applyRepositoryState(currentState);
    }
    this.repositoryUnsubscribe = this._repository.subscribeList(
      this.listId,
      (state) => this.applyRepositoryState(state),
      { emitCurrent: false }
    );
  }

  applyRepositoryState(state) {
    const next = cloneListState(state);
    this._initialState = next;
    if (this.store) {
      this.store.dispatch({
        type: LIST_ACTIONS.replaceAll,
        payload: next,
      });
      return;
    }
    if (this.isConnected) {
      this.initializeStore();
    }
  }

  syncFromRepository() {
    if (!this._repository || !this.listId) return;
    const latest = this._repository.getListState(this.listId);
    if (latest) {
      this.applyRepositoryState(latest);
    }
  }

  runRepositoryOperation(promise) {
    if (!promise || typeof promise.then !== "function") return;
    promise
      .then(() => {
        this.syncFromRepository();
      })
      .catch(() => {});
  }

  buildInitialState() {
    const fallback = {
      title: this.getAttribute("name") ?? "",
      items: [],
    };
    const source = this._initialState ?? fallback;
    const baseState = cloneListState(source);
    const attrTitle = this.getAttribute("name");
    if (typeof attrTitle === "string" && attrTitle.length) {
      baseState.title = attrTitle;
    }
    return baseState;
  }

  disconnectedCallback() {
    this.dragBehavior?.destroy();
    this.dragBehavior = null;
    this.listEl?.removeEventListener("blur", this.handleItemBlur, true);
    this.listEl?.removeEventListener("focusin", this.handleFocusIn);
    this.listEl?.removeEventListener("dragstart", this.handleListDragStart);
    this.listEl?.removeEventListener(
      "touchstart",
      this.handleTouchGestureStart
    );
    this.listEl?.removeEventListener("touchend", this.handleTouchGestureEnd);
    this.listEl?.removeEventListener(
      "touchcancel",
      this.handleTouchGestureCancel
    );
    if (this.searchInput) {
      this.searchInput.removeEventListener("input", this.handleSearchInput);
      this.searchInput.removeEventListener("keydown", this.handleSearchKeyDown);
    }
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.repositoryUnsubscribe?.();
    this.repositoryUnsubscribe = null;
    this.classList.remove("tasklist-no-matches");
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    this.touchGestureState.clear();
    this.openActionsItem = null;
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.store = null;
    this.inlineEditor?.destroy();
    this.inlineEditor = null;
    this.repositoryUnsubscribe?.();
    this.repositoryUnsubscribe = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "name" && oldValue !== newValue) {
      if (this.suppressNameSync) return;
      const nextTitle = typeof newValue === "string" ? newValue : "";
      if (this._repository && this.listId) {
        const promise = this._repository.renameList(this.listId, nextTitle);
        this.runRepositoryOperation(promise);
      } else if (this.store) {
        this.store.dispatch({
          type: LIST_ACTIONS.setTitle,
          payload: { title: nextTitle },
        });
      } else {
        this.syncTitle();
      }
    }
  }

  ensureList() {
    if (this.listEl && this.contains(this.listEl)) return;

    let list = this.querySelector("ol.tasklist");
    const existingItems = Array.from(this.querySelectorAll(":scope > li"));
    if (!list) {
      render(html` <ol class="tasklist"></ol> `, this);
      list = this.querySelector("ol.tasklist");
    }
    if (list && existingItems.length) {
      existingItems.forEach((li) => list.appendChild(li));
    }
    this.listEl = list;

    if (!this.emptyStateEl || !this.contains(this.emptyStateEl)) {
      const emptyTemplate = html`
        <div class="tasklist-empty" hidden>No matching items</div>
      `;
      if (this.listEl?.nextSibling) {
        const fragment = document.createElement("div");
        render(emptyTemplate, fragment);
        const emptyElement = fragment.firstElementChild;
        if (emptyElement) {
          this.insertBefore(emptyElement, this.listEl.nextSibling);
          this.emptyStateEl = emptyElement;
        }
      } else {
        render(emptyTemplate, this);
        this.emptyStateEl = this.querySelector(".tasklist-empty");
      }
    }
  }

  ensureHeader() {
    if (!this.headerEl || !this.contains(this.headerEl)) {
      const header = document.createElement("div");
      header.className = "tasklist-header";
      if (this.listEl && this.contains(this.listEl)) {
        this.insertBefore(header, this.listEl);
      } else {
        this.appendChild(header);
      }
      this.headerEl = header;
    }

    const currentTitle = this.getAttribute("name") ?? "";
    const currentSearch = this.searchInput?.value ?? this.searchQuery ?? "";
    const showDoneChecked =
      typeof this.showDone === "boolean" ? this.showDone : false;

    render(
      html`
        <h2 class="tasklist-title" tabindex="0" title="Click to rename">
          ${currentTitle}
        </h2>
        <div class="tasklist-controls">
          <input
            type="search"
            class="tasklist-search-input"
            placeholder="Search tasks..."
            aria-label="Search tasks"
            .value=${currentSearch}
          />
          <label class="tasklist-show-done">
            <input
              type="checkbox"
              class="tasklist-show-done-toggle"
              ?checked=${showDoneChecked}
              @change=${this.handleShowDoneChange}
            />
            <span>Show done</span>
          </label>
          <button
            type="button"
            class="iconlabel"
            aria-label="Add task"
            data-role="tasklist-add"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M7 1h2v6h6v2H9v6H7V9H1V7h6z"></path>
            </svg>
            <span>Add</span>
          </button>
        </div>
      `,
      this.headerEl
    );

    this.titleEl = this.headerEl.querySelector(".tasklist-title") ?? null;
    this.searchInput =
      this.headerEl.querySelector(".tasklist-search-input") ?? null;
    this.showDoneCheckbox =
      this.headerEl.querySelector(".tasklist-show-done-toggle") ?? null;
    this.addButton =
      this.headerEl.querySelector("[data-role='tasklist-add']") ?? null;

    if (this.titleEl) {
      this.titleEl.setAttribute("tabindex", "0");
      this.titleEl.setAttribute("title", "Click to rename");
      this.titleEl.removeEventListener("click", this.handleTitleClick);
      this.titleEl.addEventListener("click", this.handleTitleClick);
      this.titleEl.removeEventListener("keydown", this.handleTitleKeyDown);
      this.titleEl.addEventListener("keydown", this.handleTitleKeyDown);
    }

    if (this.searchInput) {
      this.searchInput.removeEventListener("input", this.handleSearchInput);
      this.searchInput.removeEventListener("keydown", this.handleSearchKeyDown);
      this.searchInput.addEventListener("input", this.handleSearchInput);
      this.searchInput.addEventListener("keydown", this.handleSearchKeyDown);
    }
    if (this.addButton) {
      this.addButton.removeEventListener("click", this.handleAddButtonClick);
      this.addButton.addEventListener("click", this.handleAddButtonClick);
    }
  }

  ensureInlineEditor() {
    if (this.inlineEditor || !this.listEl) {
      return this.inlineEditor;
    }
    this.inlineEditor = new InlineTextEditor(this.listEl, {
      onCommit: this.handleEditCommit,
      onSplit: this.handleEditSplit,
      onMerge: this.handleEditMerge,
      onRemove: this.handleEditRemove,
      onMove: this.handleEditMove,
    });
    return this.inlineEditor;
  }

  startTitleEditing() {
    if (!this.titleEl || this.isTitleEditing) return;
    this.isTitleEditing = true;
    this.titleOriginalValue = this.titleEl.textContent ?? "";
    this.titleEl.classList.add("is-editing");
    this.titleEl.setAttribute("contenteditable", "true");
    this.titleEl.setAttribute("spellcheck", "false");
    this.titleEl.setAttribute("role", "textbox");
    this.titleEl.setAttribute("aria-multiline", "false");
    this.titleEl.setAttribute("aria-label", "List title");
    this.titleEl.addEventListener("blur", this.handleTitleBlur);
    this.titleEl.focus();
    const selection = document.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(this.titleEl);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  finishTitleEditing() {
    if (!this.titleEl) return;
    this.titleEl.classList.remove("is-editing");
    this.titleEl.removeAttribute("contenteditable");
    this.titleEl.removeAttribute("spellcheck");
    this.titleEl.removeAttribute("role");
    this.titleEl.removeAttribute("aria-multiline");
    this.titleEl.removeAttribute("aria-label");
    this.titleEl.removeEventListener("blur", this.handleTitleBlur);
    this.isTitleEditing = false;
    this.titleOriginalValue = "";
  }

  commitTitleEditing({ restoreFocus = true } = {}) {
    if (!this.titleEl || !this.isTitleEditing) return;
    const rawValue = this.titleEl.textContent ?? "";
    const trimmed = rawValue.trim();
    const previousValue = this.titleOriginalValue ?? "";

    if (!trimmed.length) {
      this.titleEl.textContent = previousValue;
      this.finishTitleEditing();
      if (restoreFocus) {
        this.titleEl.focus();
      }
      return;
    }

    this.titleEl.textContent = trimmed;
    this.finishTitleEditing();

    if (trimmed === previousValue) {
      if (restoreFocus) {
        this.titleEl.focus();
      }
      return;
    }

    if (this.store) {
      this.store.dispatch({
        type: LIST_ACTIONS.setTitle,
        payload: { title: trimmed },
      });
    } else {
      this.setAttribute("name", trimmed);
      this.syncTitle();
    }

    if (this._repository && this.listId) {
      const promise = this._repository.renameList(this.listId, trimmed);
      this.runRepositoryOperation(promise);
    }

    this.dispatchEvent(
      new CustomEvent("titlechange", {
        detail: { title: trimmed },
        bubbles: true,
        composed: true,
      })
    );

    if (restoreFocus) {
      this.titleEl.focus();
    }
  }

  cancelTitleEditing({ restoreFocus = true } = {}) {
    if (!this.titleEl || !this.isTitleEditing) return;
    const previousValue = this.titleOriginalValue ?? "";
    this.titleEl.textContent = previousValue;
    this.finishTitleEditing();
    if (restoreFocus) {
      this.titleEl.focus();
    }
  }

  handleTitleClick() {
    if (this.isTitleEditing) return;
    this.startTitleEditing();
  }

  handleTitleKeyDown(event) {
    if (!this.titleEl) return;
    if (this.isTitleEditing) {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitTitleEditing();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelTitleEditing();
      }
      return;
    }

    if (
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "Spacebar"
    ) {
      event.preventDefault();
      this.startTitleEditing();
    }
  }

  handleTitleBlur() {
    if (!this.isTitleEditing) return;
    this.commitTitleEditing({ restoreFocus: false });
  }

  syncTitle() {
    if (!this.titleEl || this.isTitleEditing) return;
    const value = this.getAttribute("name");
    this.titleEl.textContent = value ?? "";
  }

  normalizePatternDefs(defs) {
    // Accepts both literal regexes and plain objects so embedding pages can
    // configure highlights without worrying about flag safety or class naming.
    if (!Array.isArray(defs)) return [];
    const normalized = [];
    defs.forEach((def) => {
      if (!def) return;
      let { regex, className, priority } = def;
      if (typeof regex === "string") {
        try {
          regex = new RegExp(regex, "g");
        } catch (err) {
          return;
        }
      } else if (regex instanceof RegExp) {
        const flags = regex.flags.includes("g")
          ? regex.flags
          : regex.flags + "g";
        regex = new RegExp(regex.source, flags);
      } else {
        return;
      }

      const safeClass =
        typeof className === "string" && className.trim().length
          ? className.trim()
          : "task-token";
      const prio = Number.isFinite(priority) ? priority : 2;
      normalized.push({
        regexSource: regex.source,
        regexFlags: regex.flags,
        className: safeClass,
        priority: prio,
        key: `pattern:${safeClass}`,
      });
    });
    return normalized;
  }

  setPatternHighlighters(defs) {
    this.patternConfig = this.normalizePatternDefs(defs);
    this.performSearch(this.searchQuery);
  }

  get patternHighlighters() {
    return this.patternConfig.map((def) => ({
      regex: new RegExp(def.regexSource, def.regexFlags),
      className: def.className,
      priority: def.priority,
    }));
  }

  set patternHighlighters(defs) {
    this.setPatternHighlighters(defs);
  }

  handleSearchInput() {
    if (!this.searchInput) return;
    const value = this.searchInput.value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.performSearch(value);
      this.searchTimer = null;
    }, 120);
  }

  handleSearchKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.clearSearch();
      this.searchInput?.focus();
    }
  }

  handleSearchClear() {
    this.clearSearch();
    this.searchInput?.focus();
  }

  handleShowDoneChange(e) {
    const isChecked = Boolean(e?.target?.checked);
    if (this.showDone === isChecked) return;
    this.showDone = isChecked;
    this.performSearch(this.searchQuery);
  }

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    if (this.searchInput) {
      this.searchInput.value = "";
    }
    this.performSearch("");
  }

  handleAddButtonClick() {
    if (!this.store) return;
    this.ensureInlineEditor();
    if (this.searchQuery) {
      this.clearSearch();
    }
    const stateBefore = this.store.getState();
    const firstItem =
      Array.isArray(stateBefore?.items) && stateBefore.items.length
        ? stateBefore.items[0].id
        : null;
    const newId = generateItemId();
    this.editController.queue(newId, "end");
    this.schedulePendingEditFlush();
    this.store.dispatch({
      type: LIST_ACTIONS.insertItem,
      payload: {
        index: 0,
        item: { id: newId, text: "", done: false },
      },
    });
    this.handleStoreChange();
    if (!this.focusItemImmediately(newId, "end")) {
      this.editController.applyPendingEdit();
    }
    if (this._repository && this.listId) {
      const promise = this._repository.insertTask(this.listId, {
        itemId: newId,
        text: "",
        done: false,
        beforeId: firstItem ?? undefined,
      });
      this.runRepositoryOperation(promise);
    }
  }

  handleEditSplit({ element, beforeText, afterText }) {
    if (!element || !this.store) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) return;

    const state = this.store.getState();
    const currentIndex = state.items.findIndex((item) => item.id === id);
    if (currentIndex === -1) return;
    const nextItemId = state.items[currentIndex + 1]?.id ?? null;

    const newId = generateItemId();
    this.editController.queue(newId, "start");
    this.schedulePendingEditFlush();
    if (typeof beforeText === "string") {
      this.store.dispatch({
        type: LIST_ACTIONS.updateItemText,
        payload: { id, text: beforeText },
      });
    }

    this.store.dispatch({
      type: LIST_ACTIONS.insertItem,
      payload: {
        index: currentIndex + 1,
        item: {
          id: newId,
          text: typeof afterText === "string" ? afterText : "",
          done: false,
        },
      },
    });
    this.handleStoreChange();
    if (!this.focusItemImmediately(newId, "start")) {
      this.editController.applyPendingEdit();
    }
    if (this._repository && this.listId) {
      const promise = (async () => {
        if (typeof beforeText === "string") {
          await this._repository.updateTask(this.listId, id, {
            text: beforeText,
          });
        }
        await this._repository.insertTask(this.listId, {
          itemId: newId,
          text: typeof afterText === "string" ? afterText : "",
          done: false,
          afterId: id,
          beforeId: nextItemId ?? undefined,
        });
      })();
      this.runRepositoryOperation(promise);
    }
  }

  // Re-stitches adjacent tasks on Backspace so users can treat the list like a text editor without losing content.
  handleEditMerge({
    currentItemId,
    previousItemId,
    currentText,
    selectionStart,
  }) {
    if (!this.store || !currentItemId || !previousItemId) return false;

    const state = this.store.getState();
    const items = Array.isArray(state?.items) ? state.items : [];
    const currentIndex = items.findIndex((item) => item.id === currentItemId);
    if (currentIndex <= 0) return false;

    const previousIndex = currentIndex - 1;
    const previousItem = items[previousIndex];
    if (!previousItem || previousItem.id !== previousItemId) return false;

    const prevText =
      typeof previousItem.text === "string" ? previousItem.text : "";
    const currentTextValue = typeof currentText === "string" ? currentText : "";
    const mergedText = prevText + currentTextValue;

    const mergeOffset =
      prevText.length +
      (typeof selectionStart === "number"
        ? Math.max(0, Math.min(selectionStart, currentTextValue.length))
        : 0);

    this.editController.queue(previousItem.id, {
      type: "offset",
      value: mergeOffset,
    });
    this.schedulePendingEditFlush();

    this.store.dispatch({
      type: LIST_ACTIONS.updateItemText,
      payload: { id: previousItem.id, text: mergedText },
    });
    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id: currentItemId },
    });
    this.handleStoreChange();
    if (
      !this.focusItemImmediately(previousItem.id, {
        type: "offset",
        value: mergeOffset,
      })
    ) {
      this.editController.applyPendingEdit();
    }

    if (this._repository && this.listId) {
      const promise = (async () => {
        await this._repository.updateTask(this.listId, previousItem.id, {
          text: mergedText,
        });
        await this._repository.removeTask(this.listId, currentItemId);
      })();
      this.runRepositoryOperation(promise);
    }

    return true;
  }

  // Redirects focus when a task is deleted so keyboard users land on a sensible neighbor instead of losing their place.
  handleEditRemove({ element }) {
    if (!element || !this.store) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) return;

    const state = this.store.getState();
    const items = state?.items ?? [];
    const currentIndex = items.findIndex((item) => item.id === id);
    if (currentIndex === -1) return;

    const nextItem = items[currentIndex + 1] ?? items[currentIndex - 1] ?? null;
    const focusTargetId = nextItem?.id ?? null;
    if (focusTargetId) {
      this.editController.queue(focusTargetId, "end");
      this.schedulePendingEditFlush();
    } else {
      this.editController.clear();
    }

    this.closeActionsForItem(li);

    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id },
    });
    this.handleStoreChange();
    if (!focusTargetId || !this.focusItemImmediately(focusTargetId, "end")) {
      this.editController.applyPendingEdit();
    }

    if (this._repository && this.listId) {
      const promise = this._repository.removeTask(this.listId, id);
      this.runRepositoryOperation(promise);
    }
  }

  // Supports ctrl/cmd + arrow reordering while preserving caret placement, matching expectations from native outliners.
  handleEditMove({ element, direction, selectionStart }) {
    if (!element || !this.store) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) return;

    const state = this.store.getState();
    const items = Array.isArray(state?.items) ? state.items : [];
    const fromIndex = items.findIndex((item) => item.id === id);
    if (fromIndex === -1) return;
    const delta = direction === "down" ? 1 : -1;
    const toIndex = fromIndex + delta;
    if (toIndex < 0 || toIndex >= items.length) return;

    const order = items.map((item) => item.id);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);

    const caretOffset =
      typeof selectionStart === "number" ? Math.max(0, selectionStart) : 0;
    this.editController.queue(id, {
      type: "offset",
      value: caretOffset,
    });
    this.schedulePendingEditFlush();
    this.inlineEditor?.finishEditing(element, true);

    this.store.dispatch({
      type: LIST_ACTIONS.reorderItems,
      payload: { order },
    });
    this.handleStoreChange();
    if (
      !this.focusItemImmediately(id, {
        type: "offset",
        value: caretOffset,
      })
    ) {
      this.editController.applyPendingEdit();
    }

    if (this._repository && this.listId) {
      const beforeNeighbor = order[toIndex - 1] ?? null;
      const afterNeighbor = order[toIndex + 1] ?? null;
      const promise = this._repository.moveTaskWithinList(this.listId, id, {
        afterId: beforeNeighbor ?? undefined,
        beforeId: afterNeighbor ?? undefined,
      });
      this.runRepositoryOperation(promise);
    }
  }

  handleStoreChange() {
    if (!this.store) return;
    this.renderFromState(this.store.getState());
  }

  schedulePendingEditFlush() {
    if (this.pendingEditFlushRequested) return;
    this.pendingEditFlushRequested = true;
    const scheduleFlush = (cb) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => cb());
      } else if (typeof queueMicrotask === "function") {
        queueMicrotask(cb);
      } else {
        Promise.resolve().then(cb);
      }
    };
    scheduleFlush(() => {
      this.pendingEditFlushRequested = false;
      if (!this.editController?.hasPending()) {
        return;
      }
      this.editController.applyPendingEdit();
    });
  }

  focusItemImmediately(itemId, caretPreference = null) {
    if (!this.listEl || !this.inlineEditor) {
      return false;
    }
    const selectorId = escapeSelectorId(itemId ?? "");
    if (!selectorId) return false;
    const targetLi = this.listEl.querySelector(
      `li[data-item-id="${selectorId}"]`
    );
    const textEl = targetLi?.querySelector(".text") ?? null;
    if (!textEl) {
      return false;
    }
    this.inlineEditor.startEditing(textEl, null, caretPreference);
    this.editController.clear();
    return true;
  }

  // Acts as the single render pass so focus management and search updates happen in a predictable order after each state change.
  renderFromState(state) {
    if (!this.listEl || !state) return;

    const preservedFocus = this.view.captureFocus();

    this.view.syncItems(state.items, {
      createItem: (item) => this.createItemElement(item),
      updateItem: (li, item) => this.updateItemElement(li, item),
    });

    const totalCount = Array.isArray(state.items) ? state.items.length : 0;
    if (totalCount !== this.lastReportedTotal) {
      this.lastReportedTotal = totalCount;
      this.dispatchEvent(
        new CustomEvent("itemcountchange", {
          detail: { total: totalCount },
          bubbles: true,
          composed: true,
        })
      );
    }

    const nextTitle = state.title ?? "";
    if (this.titleEl && !this.isTitleEditing) {
      this.titleEl.textContent = nextTitle;
    }

    const attrTitle = this.getAttribute("name");
    if (attrTitle !== nextTitle) {
      this.suppressNameSync = true;
      if (nextTitle) {
        this.setAttribute("name", nextTitle);
      } else {
        this.removeAttribute("name");
      }
      this.suppressNameSync = false;
    }

    if (nextTitle !== this.lastReportedTitle) {
      this.lastReportedTitle = nextTitle;
      this.dispatchEvent(
        new CustomEvent("titlechange", {
          detail: { title: nextTitle },
          bubbles: true,
          composed: true,
        })
      );
    }

    const forceVisible = this.editController.getForceVisibleIds();
    let hasPendingEdit = this.editController.hasPending();

    this.performSearch(this.searchQuery, { forceVisible });

    let appliedPendingEdit = false;
    if (hasPendingEdit) {
      appliedPendingEdit = this.editController.applyPendingEdit() === true;
      hasPendingEdit = this.editController.hasPending();
    }

    this.view.restoreFocus(preservedFocus, {
      skip: hasPendingEdit || appliedPendingEdit,
    });

    if (this.openActionsItem && !this.listEl.contains(this.openActionsItem)) {
      this.openActionsItem = null;
    }
  }

  populateItemElement(li, item) {
    if (!li) return;
    const isOpen = li.classList.contains("task-item--actions");
    const isDone = Boolean(item.done);
    const itemId = item.id;
    const text = typeof item.text === "string" ? item.text : "";

    render(
      html`
        <div class="task-item__main">
          <input type="checkbox" class="done-toggle" ?checked=${isDone} />
          <span
            class="text"
            tabindex="0"
            role="textbox"
            aria-label="Task"
          ></span>
          <span class="handle" aria-hidden="true"></span>
        </div>
        <button
          type="button"
          class=${`task-item__toggle ${
            isOpen ? "task-item__toggle--active" : "closed"
          }`}
          aria-expanded=${isOpen ? "true" : "false"}
          aria-label=${isOpen
            ? "Hide task actions for this task"
            : "Show task actions for this task"}
          title=${isOpen ? "Hide task actions" : "Show task actions"}
          @click=${this.handleActionToggleClick}
        ></button>
        <div
          class="task-item__actions"
          aria-hidden=${isOpen ? "false" : "true"}
        >
          <button
            type="button"
            class="task-move-button"
            title="Move this task to another list (shortcut: M)"
            @click=${this.handleMoveButtonClick}
          >
            Move
          </button>
          <button
            type="button"
            class="task-delete-button danger"
            title="Delete this task"
            @click=${this.handleDeleteButtonClick}
          >
            Delete
          </button>
        </div>
      `,
      li
    );

    li.classList.add("task-item");
    li.dataset.itemId = itemId;
    li.dataset.done = isDone ? "true" : "false";
    if (li.getAttribute("draggable") !== "true") {
      li.setAttribute("draggable", "true");
    }

    const toggle = li.querySelector(".task-item__toggle");
    this.updateActionToggleState(toggle, isOpen);

    const textSpan = li.querySelector(".text");
    if (textSpan) {
      textSpan.dataset.originalText = text;
      if (!textSpan.hasAttribute("tabindex")) {
        textSpan.tabIndex = 0;
      }
      if (!textSpan.isContentEditable && textSpan.textContent !== text) {
        textSpan.textContent = text;
      }
    }

    const doneToggleInput = li.querySelector(".done-toggle");
    if (doneToggleInput) {
      doneToggleInput.removeEventListener("change", this.handleToggle);
      doneToggleInput.addEventListener("change", this.handleToggle);
    }
  }

  createItemElement(item) {
    const li = document.createElement("li");
    this.populateItemElement(li, item);
    return li;
  }

  updateItemElement(li, item) {
    this.populateItemElement(li, item);
  }

  updateActionToggleState(toggle, isOpen) {
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.setAttribute(
      "aria-label",
      isOpen
        ? "Hide task actions for this task"
        : "Show task actions for this task"
    );
    toggle.title = isOpen ? "Hide task actions" : "Show task actions";
    // toggle.textContent = isOpen ? "»" : "«";
    toggle.classList.toggle("task-item__toggle--active", Boolean(isOpen));
  }

  openActionsForItem(li) {
    if (!li) return;
    if (this.openActionsItem && this.openActionsItem !== li) {
      this.closeActionsForItem(this.openActionsItem);
    }
    li.classList.add("task-item--actions");
    const actions = li.querySelector(".task-item__actions");
    const toggle = li.querySelector(".task-item__toggle");
    actions?.setAttribute("aria-hidden", "false");
    this.updateActionToggleState(toggle, true);
    this.openActionsItem = li;
  }

  closeActionsForItem(li) {
    if (!li) return;
    li.classList.remove("task-item--actions");
    const actions = li.querySelector(".task-item__actions");
    const toggle = li.querySelector(".task-item__toggle");
    actions?.setAttribute("aria-hidden", "true");
    this.updateActionToggleState(toggle, false);
    if (this.openActionsItem === li) {
      this.openActionsItem = null;
    }
  }

  handleToggle(e) {
    if (!e.target.classList?.contains("done-toggle")) return;
    const li = e.target.closest("li");
    const id = li?.dataset?.itemId;
    if (!id || !this.store) return;
    this.store.dispatch({
      type: LIST_ACTIONS.setItemDone,
      payload: { id, done: e.target.checked },
    });
    if (this._repository && this.listId) {
      const promise = this._repository.toggleTask(
        this.listId,
        id,
        Boolean(e.target.checked)
      );
      this.runRepositoryOperation(promise);
    }
  }

  handleMoveButtonClick(event) {
    const button = event.currentTarget;
    const li = button?.closest("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    this.dispatchEvent(
      new CustomEvent("taskMoveRequest", {
        detail: {
          itemId,
          item: snapshot,
          sourceListId: this.listId,
          trigger: "button",
        },
        bubbles: true,
        composed: true,
      })
    );
    if (li) {
      this.closeActionsForItem(li);
    }
  }

  handleDeleteButtonClick(event) {
    const button = event.currentTarget;
    const li = button?.closest("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId || !this.store) return;

    const snapshot = this.getItemSnapshot(itemId);
    const confirmationMessage = snapshot?.text
      ? `Delete "${snapshot.text}"?`
      : "Delete this task?";
    if (!window.confirm(confirmationMessage)) {
      return;
    }

    const state = this.store.getState();
    const items = Array.isArray(state?.items) ? state.items : [];
    const currentIndex = items.findIndex((item) => item.id === itemId);
    if (currentIndex === -1) return;

    const nextItem = items[currentIndex + 1] ?? items[currentIndex - 1] ?? null;
    const focusTargetId = nextItem?.id ?? null;
    if (focusTargetId) {
      this.editController.queue(focusTargetId, "end");
      this.schedulePendingEditFlush();
    } else {
      this.editController.clear();
    }

    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id: itemId },
    });
    this.handleStoreChange();
    if (!focusTargetId || !this.focusItemImmediately(focusTargetId, "end")) {
      this.editController.applyPendingEdit();
    }
    if (this._repository && this.listId) {
      const promise = this._repository.removeTask(this.listId, itemId);
      this.runRepositoryOperation(promise);
    }
    if (li) {
      this.closeActionsForItem(li);
    }
  }

  handleActionToggleClick(event) {
    const button = event.currentTarget;
    const li = button?.closest("li");
    if (!li) return;
    if (li.classList.contains("task-item--actions")) {
      this.closeActionsForItem(li);
    } else {
      this.openActionsForItem(li);
    }
  }

  handleDocumentPointerDown(event) {
    if (!this.openActionsItem) return;
    const target = event.target;
    if (!target) return;
    if (this.openActionsItem.contains(target)) return;
    this.closeActionsForItem(this.openActionsItem);
  }

  handleTouchGestureStart(event) {
    if (!event?.changedTouches) return;
    Array.from(event.changedTouches).forEach((touch) => {
      const target = touch.target;
      const element =
        target instanceof Element
          ? target
          : event.target instanceof Element
          ? event.target
          : null;
      if (
        this.openActionsItem &&
        element &&
        !this.openActionsItem.contains(element)
      ) {
        this.closeActionsForItem(this.openActionsItem);
      }
      const li = element?.closest?.("li") ?? null;
      if (!li) return;
      if (element.closest(".handle")) return;
      if (element.closest(".task-item__actions")) return;
      if (element.closest(".task-item__toggle")) return;
      this.touchGestureState.set(touch.identifier, {
        startX: touch.clientX,
        startY: touch.clientY,
        target: li,
      });
    });
  }

  handleTouchGestureEnd(event) {
    if (!event?.changedTouches) return;
    Array.from(event.changedTouches).forEach((touch) => {
      const state = this.touchGestureState.get(touch.identifier);
      if (!state) return;
      this.touchGestureState.delete(touch.identifier);
      const li = state.target;
      if (!li || !li.isConnected) return;
      const deltaX = touch.clientX - state.startX;
      const deltaY = touch.clientY - state.startY;
      if (Math.abs(deltaX) < 30) return;
      if (Math.abs(deltaX) < Math.abs(deltaY)) return;
      if (deltaX < 0) {
        this.openActionsForItem(li);
      } else {
        this.closeActionsForItem(li);
      }
    });
  }

  handleTouchGestureCancel(event) {
    if (!event?.changedTouches) return;
    Array.from(event.changedTouches).forEach((touch) => {
      this.touchGestureState.delete(touch.identifier);
    });
  }

  handleItemKeyDown(event) {
    if (!event || event.defaultPrevented) return;
    if (event.isComposing) return;
    const key = event.key?.toLowerCase?.() ?? "";
    if (key !== "m") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (!target) return;
    if (target.isContentEditable) return;
    const li = target.closest?.("li");
    if (!li) return;
    const itemId = li.dataset?.itemId ?? null;
    if (!itemId) return;
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("taskMoveRequest", {
        detail: {
          itemId,
          item: snapshot,
          sourceListId: this.listId,
          trigger: "shortcut",
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleFocusIn(event) {
    const target = event.target;
    const li = target?.closest?.("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
    this.lastFocusedItemId = itemId;
    this.dispatchEvent(
      new CustomEvent("taskFocus", {
        detail: {
          itemId,
          sourceListId: this.listId,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleListDragStart(event) {
    const li = event?.target?.closest?.("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const payload = {
      itemId,
      item: snapshot,
      sourceListId: this.listId,
      trigger: "drag",
    };
    try {
      transfer.setData("application/x-a4-task", JSON.stringify(payload));
    } catch (err) {
      // Ignore inability to set custom data
    }
    try {
      transfer.setData("text/plain", snapshot.text ?? "");
    } catch (err) {
      // ignore
    }
    transfer.effectAllowed = "move";
  }

  handleEditCommit({ element, newText, previousText }) {
    if (!element || !this.store) {
      this.performSearch(this.searchQuery);
      return;
    }
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) {
      this.performSearch(this.searchQuery);
      return;
    }
    if (typeof newText !== "string") {
      this.performSearch(this.searchQuery);
      return;
    }
    const currentState = this.store.getState();
    const stateItem = currentState?.items?.find((item) => item.id === id);
    if (stateItem && stateItem.text !== previousText) {
      const authoritativeText = stateItem.text ?? "";
      element.textContent = authoritativeText;
      element.dataset.originalText = authoritativeText;
      this.performSearch(this.searchQuery);
      return;
    }
    if (newText === previousText) {
      this.performSearch(this.searchQuery);
      return;
    }
    this.store.dispatch({
      type: LIST_ACTIONS.updateItemText,
      payload: { id, text: newText },
    });
    if (this._repository && this.listId) {
      const promise = this._repository.updateTask(this.listId, id, {
        text: newText,
      });
      this.runRepositoryOperation(promise);
    }
  }

  scheduleReorderUpdate() {
    if (!this.store || !this.listEl) return;
    Promise.resolve().then(() => {
      if (!this.store || !this.listEl) return;
      const previousState = this.store.getState();
      const prevOrder = Array.isArray(previousState?.items)
        ? previousState.items.map((item) => item.id)
        : [];
      const order = Array.from(this.listEl.children)
        .filter((li) => !li.classList.contains("placeholder"))
        .map((li) => li.dataset.itemId)
        .filter(Boolean);
      if (!order.length) return;
      this.store.dispatch({
        type: LIST_ACTIONS.reorderItems,
        payload: { order },
      });
      if (this._repository && this.listId) {
        let movedId = null;
        for (let i = 0; i < order.length; i++) {
          if (order[i] !== prevOrder[i]) {
            movedId = order[i];
            break;
          }
        }
        if (!movedId) return;
        const targetIndex = order.indexOf(movedId);
        const beforeNeighbor = order[targetIndex - 1] ?? null;
        const afterNeighbor = order[targetIndex + 1] ?? null;
        const promise = this._repository.moveTaskWithinList(
          this.listId,
          movedId,
          {
            afterId: beforeNeighbor ?? undefined,
            beforeId: afterNeighbor ?? undefined,
          }
        );
        this.runRepositoryOperation(promise);
      }
    });
  }

  handleItemBlur(e) {
    const textEl = e.target.classList?.contains("text") ? e.target : null;
    if (!textEl) return;
    textEl.dataset.originalText = textEl.textContent;
    this.performSearch(this.searchQuery);
  }

  // Keeps filtering and highlighting in sync with state changes so users never see
  // stale markup, while forcing certain ids visible when edits demand it.
  performSearch(query, options = {}) {
    if (!this.listEl) return;
    this.searchQuery = query;
    const tokens = tokenizeSearchQuery(query);
    const forceVisible = options?.forceVisible ?? null;

    let visibleCount = 0;

    this.listEl.querySelectorAll("li").forEach((li) => {
      if (li.classList.contains("placeholder")) return;
      const textEl = li.querySelector(".text");
      if (!textEl) return;
      const isEditing = textEl.isContentEditable;
      const isDone = li.dataset.done === "true";

      const original =
        textEl.dataset.originalText != null
          ? textEl.dataset.originalText
          : (textEl.dataset.originalText = textEl.textContent);

      if (isEditing) {
        li.hidden = false;
        visibleCount += 1;
        return;
      }

      if (
        forceVisible &&
        li.dataset.itemId &&
        forceVisible.has(li.dataset.itemId)
      ) {
        li.hidden = false;
        textEl.textContent = original;
        visibleCount += 1;
        return;
      }

      const result = evaluateSearchEntry({
        originalText: original,
        tokens,
        patternConfig: this.patternConfig,
        showDone: this.showDone,
        isDone,
      });

      li.hidden = result.hidden;
      if (result.hidden || result.markup == null) {
        textEl.textContent = original;
        return;
      }
      textEl.innerHTML = result.markup;
      if (!li.hidden) {
        visibleCount += 1;
      }
    });

    this.dragBehavior?.invalidateItemsCache();

    if (
      visibleCount !== this.lastReportedMatches ||
      query !== this.lastReportedQuery
    ) {
      this.lastReportedMatches = visibleCount;
      this.lastReportedQuery = query;
      this.dispatchEvent(
        new CustomEvent("searchresultschange", {
          detail: {
            matches: visibleCount,
            query,
          },
          bubbles: true,
          composed: true,
        })
      );
    }

    const shouldShowEmpty =
      typeof this.searchQuery === "string" &&
      this.searchQuery.trim().length > 0 &&
      visibleCount === 0;
    if (this.emptyStateEl) {
      this.emptyStateEl.hidden = !shouldShowEmpty;
    }
    this.classList.toggle("tasklist-no-matches", shouldShowEmpty);
  }

  applyFilter(query) {
    const value = typeof query === "string" ? query : "";
    if (this.searchInput) {
      this.searchInput.value = value;
    }
    this.performSearch(value);
  }

  clearFilter() {
    this.applyFilter("");
  }

  getItemSnapshot(itemId) {
    if (!this.store || !itemId) return null;
    const state = this.store.getState();
    const items = Array.isArray(state?.items) ? state.items : [];
    const found = items.find((item) => item.id === itemId);
    return found ? { ...found } : null;
  }

  removeItemById(itemId) {
    if (!this.store || !itemId) return false;
    const state = this.store.getState();
    if (!state?.items?.some((item) => item.id === itemId)) {
      return false;
    }
    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id: itemId },
    });
    this.handleStoreChange();
    return true;
  }

  prependItem(item) {
    if (!this.store || !item || !item.id) return false;
    this.store.dispatch({
      type: LIST_ACTIONS.insertItem,
      payload: {
        index: 0,
        item: {
          id: item.id,
          text: typeof item.text === "string" ? item.text : "",
          done: Boolean(item.done),
        },
      },
    });
    this.handleStoreChange();
    return true;
  }

  focusItem(itemId) {
    if (!this.listEl || !itemId) return false;
    const selectorId = escapeSelectorId(itemId);
    const targetLi = this.listEl.querySelector(
      `li[data-item-id="${selectorId}"]`
    );
    if (!targetLi) return false;
    const textEl = targetLi.querySelector(".text");
    if (textEl) {
      textEl.focus();
      return true;
    }
    return false;
  }

  cancelActiveDrag() {
    this.dragBehavior?.cancel?.();
  }

  setListName(name) {
    const nextTitle = typeof name === "string" ? name : "";
    if (this.store) {
      this.store.dispatch({
        type: LIST_ACTIONS.setTitle,
        payload: { title: nextTitle },
      });
    } else {
      this.setAttribute("name", nextTitle);
      this.syncTitle();
    }
  }

  getTotalItemCount() {
    if (!this.store) return 0;
    const state = this.store.getState();
    return Array.isArray(state?.items) ? state.items.length : 0;
  }

  getSearchMatchCount() {
    if (typeof this.lastReportedMatches === "number") {
      return this.lastReportedMatches;
    }
    return this.getTotalItemCount();
  }

  get listId() {
    return this.listIdentifier;
  }

  set listId(value) {
    if (value == null) {
      this.listIdentifier = null;
      delete this.dataset.listId;
      this.refreshRepositorySubscription();
      return;
    }
    this.listIdentifier = String(value);
    this.dataset.listId = this.listIdentifier;
    this.refreshRepositorySubscription();
  }

  get listRepository() {
    return this._repository;
  }

  set listRepository(value) {
    if (this._repository === value) return;
    this._repository = value ?? null;
    this.refreshRepositorySubscription();
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  set name(value) {
    if (value == null) {
      this.removeAttribute("name");
    } else {
      this.setAttribute("name", String(value));
    }
  }
}

customElements.define("a4-tasklist", A4TaskList);
document.addEventListener(
  "keydown",
  (event) => {
    if (!event || event.defaultPrevented) return;
    const host = event.target?.closest?.("a4-tasklist");
    if (!host || typeof host.handleItemKeyDown !== "function") return;
    host.handleItemKeyDown(event);
  },
  true
);
