import { html, render, noChange } from "../../vendor/lit-html.js";
import { live } from "../../vendor/directives/live.js";
import { DragCoordinator } from "./drag-coordinator.js";
import { FlipAnimator } from "../../shared/drag-behavior.js";
import InlineTextEditor from "../../shared/inline-text-editor.js";
import {
  createStore,
  listReducer,
  LIST_ACTIONS,
  cloneListState,
  generateItemId,
} from "../state/list-store.js";
import {
  evaluateSearchEntry,
  matchesSearchEntry,
  tokenizeSearchQuery,
} from "../state/highlight-utils.js";
import { SHORTCUTS, matchesShortcut } from "../state/shortcuts.js";
import type { ListId, TaskItem, TaskListState } from "../../types/domain.js";
import type { ListRepository } from "../../app/list-repository.js";
import type { CaretBias, CaretPreference } from "../../types/caret.js";
import { isOffsetCaret } from "../../types/caret.js";

type PatternDefinition = {
  regex: RegExp;
  className: string;
  priority?: number;
};

type PatternConfigEntry = {
  regexSource: string;
  regexFlags: string;
  className: string;
  priority: number;
  key: string;
};

const makeOffsetCaret = (value: number, bias?: CaretBias): CaretPreference => ({
  type: "offset",
  value,
  bias,
});

type ListAction = Parameters<typeof listReducer>[1];
type ListStore = ReturnType<typeof createStore<TaskListState, ListAction>>;
type InlineEditor = InstanceType<typeof InlineTextEditor>;

type ReorderMove = { fromIndex: number; toIndex: number };

const escapeSelectorId = (value: string | null | undefined) => {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

const escapeHTML = (value: string | null | undefined) => {
  if (typeof value !== "string") return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

// EditController queues follow-up edits so caret placement survives rerenders that
// happen between an action (merge, move) and the next paint.
class EditController {
  private getListElement: () => HTMLElement | null;
  private getInlineEditor: () => InlineTextEditor | null;
  private getEditingTarget: (itemId: string) => HTMLElement | null;
  private getItemSnapshot: (itemId: string) => TaskItem | null;
  private pendingItemId: string | null;
  private pendingCaret: CaretPreference | null;

  constructor({
    getListElement,
    getInlineEditor,
    getEditingTarget,
    getItemSnapshot,
  }: {
    getListElement?: () => HTMLElement | null;
    getInlineEditor?: () => InlineTextEditor | null;
    getEditingTarget?: (itemId: string) => HTMLElement | null;
    getItemSnapshot?: (itemId: string) => TaskItem | null;
  } = {}) {
    this.getListElement =
      typeof getListElement === "function" ? getListElement : () => null;
    this.getInlineEditor =
      typeof getInlineEditor === "function" ? getInlineEditor : () => null;
    this.getEditingTarget =
      typeof getEditingTarget === "function" ? getEditingTarget : null;
    this.getItemSnapshot =
      typeof getItemSnapshot === "function" ? getItemSnapshot : null;
    this.pendingItemId = null;
    this.pendingCaret = null;
  }

  queue(itemId: string, caretPreference: CaretPreference | null = null) {
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

  isPendingItem(itemId: string) {
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
    const inlineEditor = this.getInlineEditor();
    if (!inlineEditor) return false;

    let textEl = this.getEditingTarget?.(this.pendingItemId) ?? null;
    if (!textEl) {
      const listEl = this.getListElement();
      if (!listEl) return false;
      const selectorId = escapeSelectorId(this.pendingItemId);
      const targetLi = listEl.querySelector(`li[data-item-id="${selectorId}"]`);
      textEl = targetLi?.querySelector(".text") ?? null;
      if (textEl && this.getItemSnapshot) {
        const snapshot = this.getItemSnapshot(this.pendingItemId);
        if (snapshot && typeof snapshot.text === "string") {
          textEl.textContent = snapshot.text;
          textEl.dataset.originalText = snapshot.text;
        }
      }
    }
    if (!textEl) return false;

    if (inlineEditor.editingEl === textEl && this.pendingCaret) {
      inlineEditor.applyCaretPreference(textEl, this.pendingCaret);
      if (isOffsetCaret(this.pendingCaret)) {
        inlineEditor.setSelectionAtOffset(
          textEl,
          this.pendingCaret.value,
          this.pendingCaret.bias
        );
      }
      textEl.focus();
    } else {
      inlineEditor.startEditing(textEl, null, this.pendingCaret);
      if (isOffsetCaret(this.pendingCaret)) {
        inlineEditor.setSelectionAtOffset(
          textEl,
          this.pendingCaret.value,
          this.pendingCaret.bias
        );
      }
    }
    this.clear();
    return true;
  }
}

// TaskListView keeps DOM reconciliation separate from state changes so we can reuse
// focused nodes and avoid churn when the reducer reorders items.
class TaskListView {
  private getListElement: () => HTMLElement | null;

  constructor({ getListElement }: { getListElement?: () => HTMLElement | null } = {}) {
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
    const role: "toggle" | "text" | null = activeElement.classList.contains(
      "done-toggle"
    )
      ? "toggle"
      : activeElement.classList.contains("text")
      ? "text"
      : null;
    return role ? { itemId: activeLi.dataset.itemId, role } : null;
  }

  syncItems(
    items: TaskItem[],
    {
      createItem,
      updateItem,
    }: {
      createItem: (item: TaskItem) => HTMLElement;
      updateItem: (element: HTMLElement, item: TaskItem) => void;
    }
  ) {
    const listEl = this.getListElement() as HTMLElement | null;
    if (!listEl || !Array.isArray(items)) return;
    const existingNodes = (Array.from(listEl.children) as HTMLElement[]).filter(
      (li) => !li.classList.contains("placeholder")
    );
    const byId = new Map(existingNodes.map((li) => [li.dataset.itemId, li]));
    const usedNodes = new Set();
    let previous = null;

    const nextNonPlaceholder = (node: ChildNode | null) => {
      let current = node as HTMLElement | null;
      while (current && current.classList?.contains("placeholder")) {
        current = current.nextSibling as HTMLElement | null;
      }
      return current;
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

  restoreFocus(
    preservedFocus: { itemId: string; role: "toggle" | "text" } | null,
    { skip }: { skip?: boolean } = {}
  ) {
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
    (focusTarget as HTMLElement | null)?.focus();
  }
}

// Custom element binds the store, view, and behaviors together so the prototype
// remains drop-in embeddable without a framework runtime.
class A4TaskList extends HTMLElement {
  private listEl: HTMLOListElement | null;
  private dragCoordinator: DragCoordinator | null;
  private inlineEditor: InlineEditor | null;
  private headerEl: HTMLElement | null;
  private titleEl: HTMLElement | null;
  private searchInput: HTMLInputElement | null;
  private searchTimer: ReturnType<typeof setTimeout> | null;
  searchQuery: string;
  showDone: boolean;
  private store: ListStore | null;
  private unsubscribe: (() => void) | null;
  private suppressNameSync: boolean;
  private _initialState: TaskListState | null;
  private shellRendered: boolean;
  private patternConfig: PatternConfigEntry[];
  private listIdentifier: ListId | null;
  private lastReportedMatches: number | null;
  private lastReportedTotal: number | null;
  private lastReportedQuery: string;
  private lastReportedTitle: string | null;
  private emptyStateEl: HTMLElement | null;
  private isTitleEditing: boolean;
  private titleOriginalValue: string;
  private openActionsItemId: string | null;
  private touchGestureState: Map<
    number,
    { startX: number; startY: number; target: HTMLElement }
  >;
  private pendingRestoreEdit: { id: string; caret: CaretPreference | null } | null;
  private resumeEditOnBlur: { id: string; caret: CaretPreference | null } | null;
  private resumeEditTimer: ReturnType<typeof setTimeout> | null;
  private lastDragReorderMove: ReorderMove | null;
  private dragStartOrder: string[] | null;
  private repositorySyncPaused: number;
  private queuedRepositoryState: TaskListState | null;
  private editController: EditController;
  private view: TaskListView;
  private pendingEditFlushRequested: boolean;
  private _repository: ListRepository | null;
  private repositoryUnsubscribe: (() => void) | null;

  constructor() {
    super();
    this.listEl = null;
    this.dragCoordinator = null;
    this.inlineEditor = null;
    this.headerEl = null;
    this.titleEl = null;
    this.searchInput = null;
    this.searchTimer = null;
    this.searchQuery = "";
    this.showDone = false;
    this.store = null;
    this.unsubscribe = null;
    this.suppressNameSync = false;
    this._initialState = null;
    this.shellRendered = false;
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
    this.lastReportedMatches = null;
    this.lastReportedTotal = null;
    this.lastReportedQuery = "";
    this.lastReportedTitle = null;
    this.emptyStateEl = null;
    this.isTitleEditing = false;
    this.titleOriginalValue = "";
    this.openActionsItemId = null;
    this.touchGestureState = new Map();
    this.pendingRestoreEdit = null;
    this.resumeEditOnBlur = null;
    this.resumeEditTimer = null;
    this.lastDragReorderMove = null;
    this.dragStartOrder = null;
    this.repositorySyncPaused = 0;
    this.queuedRepositoryState = null;

    this.handleSearchInput = this.handleSearchInput.bind(this);
    this.handleSearchKeyDown = this.handleSearchKeyDown.bind(this);
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
    this.handleHeaderErrorDismiss = this.handleHeaderErrorDismiss.bind(this);
    this.handleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.handleTouchGestureStart = this.handleTouchGestureStart.bind(this);
    this.handleTouchGestureEnd = this.handleTouchGestureEnd.bind(this);
    this.handleTouchGestureCancel = this.handleTouchGestureCancel.bind(this);
    this.handleDragFinalize = this.handleDragFinalize.bind(this);

    this.editController = new EditController({
      getListElement: () => this.listEl,
      getInlineEditor: () => this.inlineEditor,
      getEditingTarget: (id) => this.getEditingTarget(id),
      getItemSnapshot: (id) => this.getItemSnapshot(id),
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

  set initialState(value: TaskListState | null) {
    this.applyRepositoryState(value ?? { title: "", items: [] });
  }

  pauseRepositorySync() {
    this.repositorySyncPaused += 1;
  }

  resumeRepositorySync() {
    if (this.repositorySyncPaused > 0) {
      this.repositorySyncPaused -= 1;
    }
    if (this.repositorySyncPaused !== 0) return;
    if (!this.queuedRepositoryState) return;
    const queued = this.queuedRepositoryState;
    this.queuedRepositoryState = null;
    this.applyRepositoryState(queued);
  }

  connectedCallback() {
    this.renderShell();
    if (!this.listEl) return;
    this.renderHeader(this.getHeaderRenderState());

    this.initializeStore();
    this.refreshRepositorySubscription();

    if (!this.dragCoordinator) {
      this.dragCoordinator = new DragCoordinator({
        handleClass: "handle",
        animator: new FlipAnimator(),
        onReorder: (fromIndex, toIndex) => {
          const detail = { fromIndex, toIndex };
          this.lastDragReorderMove = detail;
          this.listEl.dispatchEvent(new CustomEvent("reorder", { detail }));
          this.dispatchEvent(
            new CustomEvent("reorder", {
              detail,
              bubbles: true,
              composed: true,
            })
          );

          // Persist + store reconciliation happen on drop/dragend so the DOM stays in control while dragging.
        },
        onDragStart: this.handleListDragStart,
        onDragEnd: this.handleDragFinalize,
        onDrop: this.handleDragFinalize,
      });
    }
    this.dragCoordinator.attach(this.listEl);

    this.ensureInlineEditor();

    this.listEl.removeEventListener("blur", this.handleItemBlur, true);
    this.listEl.addEventListener("blur", this.handleItemBlur, true);
    this.listEl.removeEventListener("focusin", this.handleFocusIn);
    this.listEl.addEventListener("focusin", this.handleFocusIn);
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

  applyRepositoryState(state: TaskListState) {
    if (this.repositorySyncPaused > 0) {
      this.queuedRepositoryState = state;
      this._initialState = cloneListState(state);
      return;
    }
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

  runRepositoryOperation(promise: Promise<unknown> | null) {
    if (!promise || typeof promise.then !== "function") return;
    promise
      .then(() => {
        if (this.store) {
          this.store.dispatch({ type: LIST_ACTIONS.clearHeaderError });
        }
        this.syncFromRepository();
      })
      .catch((err) => {
        if (this.store) {
          this.store.dispatch({
            type: LIST_ACTIONS.setHeaderError,
            payload: {
              message:
                (err && err.message) ||
                "Sync failed. Please check your connection and retry.",
            },
          });
        }
      });
  }

  buildInitialState(): TaskListState {
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
    this.dragCoordinator?.destroy();
    this.dragCoordinator = null;
    this.listEl?.removeEventListener("blur", this.handleItemBlur, true);
    this.listEl?.removeEventListener("focusin", this.handleFocusIn);
    this.listEl?.removeEventListener(
      "touchstart",
      this.handleTouchGestureStart
    );
    this.listEl?.removeEventListener("touchend", this.handleTouchGestureEnd);
    this.listEl?.removeEventListener(
      "touchcancel",
      this.handleTouchGestureCancel
    );
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.repositoryUnsubscribe?.();
    this.repositoryUnsubscribe = null;
    this.classList.remove("tasklist-no-matches");
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    this.touchGestureState.clear();
    this.openActionsItemId = null;
    if (this.resumeEditTimer) {
      clearTimeout(this.resumeEditTimer);
      this.resumeEditTimer = null;
    }
    this.resumeEditOnBlur = null;
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

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null
  ) {
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
        this.renderHeader(this.getHeaderRenderState());
      }
      this.renderHeader(this.getHeaderRenderState(this.store?.getState?.()));
    }
  }

  renderShell() {
    if (this.shellRendered) return;
    render(
      html`
        <div class="tasklist-header"></div>
        <ol class="tasklist"></ol>
        <div class="tasklist-empty" hidden>No matching items</div>
      `,
      this
    );
    this.headerEl = this.querySelector(".tasklist-header");
    this.titleEl = this.querySelector(".tasklist-title");
    this.searchInput = this.querySelector(".tasklist-search-input");
    this.listEl = this.querySelector("ol.tasklist");
    this.emptyStateEl = this.querySelector(".tasklist-empty");
    this.shellRendered = true;
    this.renderHeader(this.getHeaderRenderState());
  }

  getHeaderRenderState(state: TaskListState | null = null) {
    const titleFromState =
      typeof state?.title === "string" ? state.title : undefined;
    const attrTitle = this.getAttribute("name");
    return {
      title:
        titleFromState ??
        (typeof attrTitle === "string" ? attrTitle : "") ??
        "",
      searchQuery: typeof this.searchQuery === "string" ? this.searchQuery : "",
      showDone: typeof this.showDone === "boolean" ? this.showDone : false,
      headerError: state?.headerError ?? null,
    };
  }

  renderHeader(
    headerState: {
      title?: string;
      searchQuery?: string;
      showDone?: boolean;
      headerError?: { message?: string; code?: string } | null;
    } = {}
  ) {
    if (!this.headerEl) return;
    const headerError =
      headerState?.headerError &&
      typeof headerState.headerError.message === "string"
        ? headerState.headerError
        : null;
    const titleText =
      this.isTitleEditing && this.titleEl
        ? this.titleEl.textContent ?? ""
        : typeof headerState.title === "string"
        ? headerState.title
        : "";
    const searchValue =
      typeof headerState.searchQuery === "string"
        ? headerState.searchQuery
        : "";
    const showDoneChecked = Boolean(headerState.showDone);

    render(
      html`
        ${headerError
          ? html`
              <div class="tasklist-header-error" role="alert">
                <span class="tasklist-header-error__message">
                  ${headerError.message}
                </span>
                <button
                  type="button"
                  class="tasklist-header-error__dismiss"
                  @click=${this.handleHeaderErrorDismiss}
                >
                  Dismiss
                </button>
              </div>
            `
          : null}
        <h2
          class=${`tasklist-title${this.isTitleEditing ? " is-editing" : ""}`}
          tabindex="0"
          title="Click to rename"
          contenteditable=${this.isTitleEditing ? "true" : null}
          spellcheck=${this.isTitleEditing ? "false" : null}
          role=${this.isTitleEditing ? "textbox" : null}
          aria-multiline=${this.isTitleEditing ? "false" : null}
          aria-label=${this.isTitleEditing ? "List title" : null}
          @click=${this.handleTitleClick}
          @keydown=${this.handleTitleKeyDown}
          @blur=${this.handleTitleBlur}
          .textContent=${live(titleText)}
        ></h2>
        <div class="tasklist-controls">
          <input
            type="search"
            class="tasklist-search-input"
            placeholder="Search tasks..."
            aria-label="Search tasks"
            .value=${searchValue}
            @input=${this.handleSearchInput}
            @keydown=${this.handleSearchKeyDown}
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
            @click=${this.handleAddButtonClick}
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

    this.titleEl =
      this.headerEl?.querySelector?.(".tasklist-title") ?? this.titleEl ?? null;
    this.searchInput =
      this.headerEl?.querySelector?.(".tasklist-search-input") ??
      this.searchInput ??
      null;
  }

  handleDragFinalize() {
    const beforeOrder = Array.isArray(this.dragStartOrder)
      ? this.dragStartOrder
      : null;
    if (!beforeOrder?.length) return;
    this.dragStartOrder = null;

    const move = this.lastDragReorderMove;
    this.lastDragReorderMove = null;
    this.scheduleReorderUpdate({ beforeOrder, move });
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
    if (this.isTitleEditing) return;
    this.isTitleEditing = true;
    // Capture current text before re-render so we can restore on cancel.
    this.titleOriginalValue = this.titleEl?.textContent ?? "";
    this.isTitleEditing = true;
    this.renderHeader(this.getHeaderRenderState(this.store?.getState?.()));
    this.titleEl?.focus();
    const selection = document.getSelection();
    if (selection && this.titleEl) {
      const range = document.createRange();
      range.selectNodeContents(this.titleEl);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  finishTitleEditing() {
    if (!this.titleEl) return;
    this.renderHeader(this.getHeaderRenderState(this.store?.getState?.()));
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
      this.renderHeader(this.getHeaderRenderState());
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

  handleHeaderErrorDismiss() {
    if (this.store) {
      this.store.dispatch({ type: LIST_ACTIONS.clearHeaderError });
      return;
    }
    this.renderHeader(this.getHeaderRenderState());
  }

  normalizePatternDefs(
    defs: Array<
      | PatternDefinition
      | { regex: string; className?: string; priority?: number }
      | null
      | undefined
    >
  ): PatternConfigEntry[] {
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

  setPatternHighlighters(defs: PatternDefinition[]) {
    this.patternConfig = this.normalizePatternDefs(defs);
    this.renderCurrentState();
  }

  get patternHighlighters() {
    return this.patternConfig.map((def) => ({
      regex: new RegExp(def.regexSource, def.regexFlags),
      className: def.className,
      priority: def.priority,
    }));
  }

  set patternHighlighters(defs: PatternDefinition[]) {
    this.setPatternHighlighters(defs);
  }

  handleSearchInput(event: Event) {
    const value =
      typeof (event.target as HTMLInputElement | null)?.value === "string"
        ? (event.target as HTMLInputElement).value
        : "";
    this.searchQuery = typeof value === "string" ? value : "";
    this.scheduleSearchRender();
  }

  handleSearchKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.clearSearch();
      this.searchInput?.focus();
    }
  }

  handleShowDoneChange(e: Event) {
    const isChecked = Boolean(
      (e.target as HTMLInputElement | null)?.checked
    );
    if (this.showDone === isChecked) return;
    this.showDone = isChecked;
    this.renderHeader(this.getHeaderRenderState(this.store?.getState?.()));
    this.renderCurrentState();
    this.dispatchEvent(
      new CustomEvent("showdonechange", {
        detail: { showDone: this.showDone },
        bubbles: true,
        composed: true,
      })
    );
  }

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.searchQuery = "";
    this.renderHeader(this.getHeaderRenderState(this.store?.getState?.()));
    this.renderCurrentState();
    this.dispatchEvent(
      new CustomEvent("clearsearch", { bubbles: true, composed: true })
    );
  }

  handleAddButtonClick() {
    if (!this.store) return;
    this.ensureInlineEditor();
    this.clearSearch();
    const stateBefore = this.store.getState();
    const firstItem =
      Array.isArray(stateBefore?.items) && stateBefore.items.length
        ? stateBefore.items[0].id
        : null;
    const newId = generateItemId();
    this.store.dispatch({
      type: LIST_ACTIONS.insertItem,
      payload: {
        index: 0,
        item: { id: newId, text: "", done: false },
      },
    });
    // Queue edit AFTER dispatch so element exists when pending edit is applied
    this.editController.queue(newId, "end");
    this.schedulePendingEditFlush();
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

  handleEditSplit({
    element,
    beforeText,
    afterText,
  }: {
    element: HTMLElement;
    beforeText: string;
    afterText: string;
  }) {
    if (!element || !this.store) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) return;

    const state = this.store.getState();
    const currentIndex = state.items.findIndex((item) => item.id === id);
    if (currentIndex === -1) return;
    const nextItemId = state.items[currentIndex + 1]?.id ?? null;

    const newId = generateItemId();
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
    // Queue edit AFTER dispatch so element exists when pending edit is applied
    this.editController.queue(newId, "start");
    // Try to start editing immediately; pending queue will retry if the node is not ready yet.
    this.startEditingItem(newId, "start");
    this.schedulePendingEditFlush();
    if (this._repository && this.listId) {
      this.pauseRepositorySync();
      const promise = (async () => {
        try {
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
        } finally {
          this.resumeRepositorySync();
        }
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
  }: {
    currentItemId: string | null;
    previousItemId: string | null;
    currentText: string;
    selectionStart?: number;
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

    this.editController.queue(previousItem.id, makeOffsetCaret(mergeOffset));
    this.schedulePendingEditFlush();
    this.store.dispatch({
      type: LIST_ACTIONS.updateItemText,
      payload: { id: previousItem.id, text: mergedText },
    });
    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id: currentItemId },
    });

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
  handleEditRemove({ element }: { element: HTMLElement }) {
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

    if (this.openActionsItemId === id) {
      this.closeActionsForItem(id);
    }

    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id },
    });

    if (this._repository && this.listId) {
      const promise = this._repository.removeTask(this.listId, id);
      this.runRepositoryOperation(promise);
    }
  }

  // Supports ctrl/cmd + arrow reordering while preserving caret placement, matching expectations from native outliners.
  handleEditMove({
    element,
    direction,
    selectionStart,
  }: {
    element: HTMLElement;
    direction: "up" | "down";
    selectionStart?: number;
  }) {
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
    const caretPreference = makeOffsetCaret(caretOffset);
    this.editController.queue(id, caretPreference);
    this.schedulePendingEditFlush();

    this.store.dispatch({
      type: LIST_ACTIONS.reorderItems,
      payload: { order },
    });
    this.pendingRestoreEdit = { id, caret: caretPreference };
    this.handleStoreChange();
    if (this.resumeEditTimer) {
      clearTimeout(this.resumeEditTimer);
    }
    this.resumeEditOnBlur = { id, caret: caretPreference };
    this.resumeEditTimer = setTimeout(() => {
      this.resumeEditOnBlur = null;
      this.resumeEditTimer = null;
    }, 500);
    const startedEdit = this.startEditingItem(id, caretPreference);
    if (!startedEdit && !this.focusItemImmediately(id, caretPreference)) {
      this.editController.applyPendingEdit();
    }
    setTimeout(() => {
      const retryStarted = this.startEditingItem(id, caretPreference);
      if (!retryStarted && !this.focusItemImmediately(id, caretPreference)) {
        this.editController.queue(id, caretPreference);
        this.schedulePendingEditFlush();
      }
    }, 0);

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

  scheduleSearchRender(delayMs = 120) {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.renderCurrentState();
    }, delayMs);
  }

  renderCurrentState() {
    if (this.store) {
      this.renderFromState(this.store.getState());
    }
  }

  getEditingTarget(itemId: string) {
    if (!this.listEl || !itemId) return null;
    const selectorId = escapeSelectorId(itemId);
    if (!selectorId) return null;
    const targetLi = this.listEl.querySelector(
      `li[data-item-id="${selectorId}"]`
    );
    const textEl = targetLi?.querySelector(".text") as HTMLElement | null;
    if (!textEl) return null;
    const snapshot = this.getItemSnapshot(itemId);
    if (snapshot && typeof snapshot.text === "string") {
      textEl.textContent = snapshot.text;
      textEl.dataset.originalText = snapshot.text;
    }
    return textEl;
  }

  startEditingItem(itemId: string, caretPreference: CaretPreference | null = null) {
    if (!this.inlineEditor) return false;
    const textEl = this.getEditingTarget(itemId);
    if (!textEl) return false;
    if (this.inlineEditor.editingEl === textEl) {
      // Re-apply caret even if we're already editing the node.
      textEl.focus();
    } else {
      this.inlineEditor.startEditing(textEl, null, caretPreference);
    }
    if (caretPreference) {
      this.inlineEditor.applyCaretPreference(textEl, caretPreference);
      if (isOffsetCaret(caretPreference)) {
        this.inlineEditor.setSelectionAtOffset(
          textEl,
          caretPreference.value,
          caretPreference.bias
        );
      }
    }
    this.editController.clear();
    return true;
  }

  focusItemImmediately(itemId: string, caretPreference: CaretPreference | null = null) {
    return this.startEditingItem(itemId, caretPreference);
  }

  renderItemTemplate(
    item: TaskItem,
    {
      isOpen = false,
      hidden = false,
      markup = null,
      isEditing = false,
    }: {
      isOpen?: boolean;
      hidden?: boolean;
      markup?: string | null;
      isEditing?: boolean;
    } = {}
  ) {
    const isDone = Boolean(item.done);
    const itemId = item.id;
    const text = typeof item.text === "string" ? item.text : "";
    const htmlContent = isEditing
      ? noChange
      : live(markup != null ? markup : escapeHTML(text));
    const textSpan = html`
      <span
        class="text"
        tabindex="0"
        role="textbox"
        aria-label="Task"
        data-original-text=${text}
        .innerHTML=${htmlContent}
      ></span>
    `;

    return html`
      <li
        class=${`task-item${isOpen ? " task-item--actions" : ""}`}
        data-item-id=${itemId}
        data-done=${isDone ? "true" : "false"}
        draggable="true"
        ?hidden=${hidden}
      >
        <div class="task-item__main">
          <input
            type="checkbox"
            class="done-toggle"
            ?checked=${isDone}
            @change=${this.handleToggle}
          />
          ${textSpan}
          <span class="handle" aria-hidden="true"></span>
        </div>
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
      </li>
    `;
  }

  // Acts as the single render pass so focus management and search updates happen in a predictable order after each state change.
  renderFromState(state: TaskListState) {
    if (!this.listEl || !state) return;

    this.renderHeader(this.getHeaderRenderState(state));

    const preservedFocus = this.view.captureFocus();
    const openActionsId = this.openActionsItemId;
    const tokens = tokenizeSearchQuery(this.searchQuery);
    const forceVisible = this.editController.getForceVisibleIds();
    const editingId =
      this.inlineEditor?.editingEl?.closest?.("li")?.dataset?.itemId ?? null;

    let visibleCount = 0;
    const itemsTemplate = (state.items ?? []).map((item) => {
      const text = typeof item.text === "string" ? item.text : "";
      const isEditing = editingId === item.id;
      let hidden = false;
      let markup = null;
      if (!isEditing) {
        const result = evaluateSearchEntry({
          originalText: text,
          tokens,
          patternConfig: this.patternConfig,
          showDone: this.showDone,
          isDone: item.done,
        });
        hidden = result.hidden;
        markup = result.markup;
      }
      if (forceVisible?.has(item.id)) {
        hidden = false;
        markup = null;
      }
      if (!hidden) {
        visibleCount += 1;
      }
      return this.renderItemTemplate(item, {
        isOpen: openActionsId === item.id,
        hidden,
        markup,
        isEditing,
      });
    });
    render(html`${itemsTemplate}`, this.listEl);
    this.dragCoordinator?.invalidateItemsCache();

    const totalCount = Array.isArray(state.items)
      ? state.items.filter((item) => !item?.done).length
      : 0;
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

    let hasPendingEdit = this.editController.hasPending();

    let appliedPendingEdit = false;
    if (hasPendingEdit) {
      appliedPendingEdit = this.editController.applyPendingEdit() === true;
      hasPendingEdit = this.editController.hasPending();
    }

    this.view.restoreFocus(preservedFocus, {
      skip: hasPendingEdit || appliedPendingEdit,
    });

    if (
      this.openActionsItemId &&
      !state.items?.some((item) => item.id === this.openActionsItemId)
    ) {
      this.openActionsItemId = null;
    }

    if (this.pendingRestoreEdit?.id) {
      this.startEditingItem(
        this.pendingRestoreEdit.id,
        this.pendingRestoreEdit.caret ?? null
      );
      this.pendingRestoreEdit = null;
    }

    if (
      visibleCount !== this.lastReportedMatches ||
      this.searchQuery !== this.lastReportedQuery
    ) {
      this.lastReportedMatches = visibleCount;
      this.lastReportedQuery = this.searchQuery;
      this.dispatchEvent(
        new CustomEvent("searchresultschange", {
          detail: {
            matches: visibleCount,
            query: this.searchQuery,
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

  handleToggle(e: Event) {
    const target = e.target as HTMLElement | null;
    if (!target?.classList?.contains("done-toggle")) return;
    const li = target.closest("li");
    const id = li?.dataset?.itemId;
    if (!id || !this.store) return;
    const nextDone = Boolean((target as HTMLInputElement).checked);
    // Defer state updates so click events settle before the list rerenders and hides completed items.
    setTimeout(() => {
      this.store.dispatch({
        type: LIST_ACTIONS.setItemDone,
        payload: { id, done: nextDone },
      });
      if (this._repository && this.listId) {
        const promise = this._repository.toggleTask(this.listId, id, nextDone);
        this.runRepositoryOperation(promise);
      }
    }, 0);
  }

  handleMoveButtonClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
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
    this.closeActionsForItem(itemId, { immediateRender: true });
  }

  handleDeleteButtonClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
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

    if (this.openActionsItemId === itemId) {
      this.closeActionsForItem(itemId);
    }
    this.store.dispatch({
      type: LIST_ACTIONS.removeItem,
      payload: { id: itemId },
    });
    if (this._repository && this.listId) {
      const promise = this._repository.removeTask(this.listId, itemId);
      this.runRepositoryOperation(promise);
    }
  }

  handleActionToggleClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
    const li = button?.closest("li");
    if (!li) return;
    const itemId = li.dataset?.itemId ?? null;
    if (!itemId) return;
    this.openActionsItemId = this.openActionsItemId === itemId ? null : itemId;
    this.renderFromState(this.store?.getState?.());
  }

  closeActionsForItem(
    target: string | HTMLElement,
    { immediateRender = false }: { immediateRender?: boolean } = {}
  ) {
    const id =
      typeof target === "string" ? target : target?.dataset?.itemId ?? null;
    if (!id || this.openActionsItemId !== id) return;
    this.openActionsItemId = null;
    if (immediateRender) {
      this.renderFromState(this.store?.getState?.());
    }
  }

  handleDocumentPointerDown(event: PointerEvent) {
    if (!this.openActionsItemId) return;
    const target = event.target as Node | null;
    if (!target) return;
    const openLi = this.listEl?.querySelector(
      `li[data-item-id="${escapeSelectorId(this.openActionsItemId)}"]`
    );
    if (openLi?.contains(target)) return;
    this.openActionsItemId = null;
    this.renderFromState(this.store?.getState?.());
  }

  handleTouchGestureStart(event: TouchEvent) {
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
        this.openActionsItemId &&
        element &&
        element.closest(
          `li[data-item-id="${escapeSelectorId(this.openActionsItemId)}"]`
        ) == null
      ) {
        this.openActionsItemId = null;
        this.renderFromState(this.store?.getState?.());
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

  handleTouchGestureEnd(event: TouchEvent) {
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
        const itemId = li.dataset?.itemId ?? null;
        this.openActionsItemId = itemId;
        this.renderFromState(this.store?.getState?.());
      } else {
        this.openActionsItemId = null;
        this.renderFromState(this.store?.getState?.());
      }
    });
  }

  handleTouchGestureCancel(event: TouchEvent) {
    if (!event?.changedTouches) return;
    Array.from(event.changedTouches).forEach((touch) => {
      this.touchGestureState.delete(touch.identifier);
    });
  }

  handleItemKeyDown(event: KeyboardEvent) {
    if (!event || event.defaultPrevented) return;
    if (event.isComposing) return;
    if (!matchesShortcut(event, SHORTCUTS.moveTask)) return;
    const target = event.target as HTMLElement | null;
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

  handleFocusIn(event: FocusEvent) {
    const target = event.target as HTMLElement | null;
    const li = target?.closest?.("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
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

  handleListDragStart(event: DragEvent) {
    this.lastDragReorderMove = null;
    this.dragStartOrder = this.store
      ?.getState?.()
      ?.items?.map((item) => item.id);
    const li = (event.target as HTMLElement | null)?.closest?.("li") ?? null;
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

  handleEditCommit({
    element,
    newText,
    previousText,
  }: {
    element: HTMLElement;
    newText: string;
    previousText: string;
  }) {
    if (!element || !this.store) {
      this.scheduleSearchRender(0);
      return;
    }
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) {
      this.scheduleSearchRender(0);
      return;
    }
    if (typeof newText !== "string") {
      this.scheduleSearchRender(0);
      return;
    }
    const currentState = this.store.getState();
    const stateItem = currentState?.items?.find((item) => item.id === id);
    if (stateItem && stateItem.text !== previousText) {
      const authoritativeText = stateItem.text ?? "";
      element.textContent = authoritativeText;
      element.dataset.originalText = authoritativeText;
      this.scheduleSearchRender(0);
      return;
    }
    if (newText === previousText) {
      this.scheduleSearchRender(0);
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

  scheduleReorderUpdate({
    beforeOrder,
    move,
  }: { beforeOrder?: string[] | null; move?: ReorderMove | null } = {}) {
    if (!this.store || !this.listEl) return;
    Promise.resolve().then(() => {
      if (!this.store || !this.listEl) return;
      if (!Array.isArray(beforeOrder) || !beforeOrder.length) return;

      let order = [];
      if (
        move &&
        Number.isInteger(move.fromIndex) &&
        Number.isInteger(move.toIndex) &&
        beforeOrder.length
      ) {
        const next = beforeOrder.slice();
        const [moved] = next.splice(move.fromIndex, 1);
        if (moved) {
          const clampedTo = Math.max(0, Math.min(move.toIndex, next.length));
          next.splice(clampedTo, 0, moved);
          order = next;
        }
      }

      if (!order.length) {
        order = (Array.from(this.listEl.children) as HTMLElement[])
          .filter((li) => !li.classList.contains("placeholder"))
          .map((li) => li.dataset.itemId)
          .filter(Boolean);
      }
      if (!order.length) return;

      if (order.length !== beforeOrder.length) {
        beforeOrder.forEach((id) => {
          if (!order.includes(id)) {
            order.push(id);
          }
        });
      }
      if (
        order.length !== beforeOrder.length ||
        beforeOrder.every((id, index) => id === order[index])
      ) {
        return;
      }

      // Drag behavior physically reorders <li> nodes, which can confuse lit-html's internal part bookkeeping.
      // Reset the render part before dispatching so the next render recreates the list DOM deterministically.
      try {
        delete (this.listEl as HTMLOListElement & { _$litPart$?: unknown })
          ._$litPart$;
      } catch (err) {
        // ignore
      }
      this.listEl.textContent = "";

      this.store.dispatch({
        type: LIST_ACTIONS.reorderItems,
        payload: { order },
      });

      const findMovedId = (before, after) => {
        if (!Array.isArray(before) || !Array.isArray(after)) return null;
        if (before.length !== after.length) return null;
        if (before.every((id, index) => id === after[index])) return null;
        for (const id of before) {
          const beforeWithout = before.filter((entry) => entry !== id);
          const afterWithout = after.filter((entry) => entry !== id);
          if (
            beforeWithout.length === afterWithout.length &&
            beforeWithout.every((entry, index) => entry === afterWithout[index])
          ) {
            return id;
          }
        }
        return null;
      };

      let movedId =
        move && Number.isInteger(move.fromIndex)
          ? beforeOrder[move.fromIndex] ?? null
          : null;
      if (!movedId || !order.includes(movedId)) {
        movedId = findMovedId(beforeOrder, order);
      }
      if (!movedId) return;

      if (this._repository && this.listId) {
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

  handleItemBlur(e: FocusEvent) {
    const target = e.target as HTMLElement | null;
    const textEl = target?.classList?.contains("text") ? target : null;
    if (!textEl) return;
    textEl.dataset.originalText = textEl.textContent;
    this.scheduleSearchRender(0);
    if (
      this.resumeEditOnBlur &&
      textEl.closest("li")?.dataset?.itemId === this.resumeEditOnBlur.id
    ) {
      const targetId = this.resumeEditOnBlur.id;
      const caretPreference = this.resumeEditOnBlur.caret ?? null;
      this.resumeEditOnBlur = null;
      if (this.resumeEditTimer) {
        clearTimeout(this.resumeEditTimer);
        this.resumeEditTimer = null;
      }
      setTimeout(() => {
        this.startEditingItem(targetId, caretPreference);
      }, 0);
    }
  }

  applyFilter(query: string) {
    const value = typeof query === "string" ? query : "";
    this.searchQuery = value;
    if (!this.listEl) {
      this.renderShell();
    }
    if (!this.store) {
      this.initializeStore();
    }
    this.renderHeader(this.getHeaderRenderState(this.store?.getState?.()));
    this.renderCurrentState();
  }

  clearFilter() {
    this.applyFilter("");
  }

  getItemSnapshot(itemId: string) {
    if (!this.store || !itemId) return null;
    const state = this.store.getState();
    const items = Array.isArray(state?.items) ? state.items : [];
    const found = items.find((item) => item.id === itemId);
    return found ? { ...found } : null;
  }

  removeItemById(itemId: string) {
    if (!this.store) {
      this.initializeStore();
    }
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

  prependItem(item: TaskItem) {
    if (!this.store) {
      this.initializeStore();
    }
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

  focusItem(itemId: string) {
    if (!this.listEl || !itemId) return false;
    const selectorId = escapeSelectorId(itemId);
    const targetLi = this.listEl.querySelector(
      `li[data-item-id="${selectorId}"]`
    );
    if (!targetLi) return false;
    const textEl = targetLi.querySelector(".text") as HTMLElement | null;
    if (textEl) {
      textEl.focus();
      return true;
    }
    return false;
  }

  cancelActiveDrag() {
    this.dragCoordinator?.cancel();
  }

  setListName(name: string) {
    const nextTitle = typeof name === "string" ? name : "";
    if (this.store) {
      this.store.dispatch({
        type: LIST_ACTIONS.setTitle,
        payload: { title: nextTitle },
      });
    } else {
      this.setAttribute("name", nextTitle);
      this.renderHeader(this.getHeaderRenderState());
    }
  }

  getTotalItemCount() {
    if (!this.store) return 0;
    const state = this.store.getState();
    return Array.isArray(state?.items)
      ? state.items.filter((item) => !item?.done).length
      : 0;
  }

  getSearchMatchCount() {
    if (typeof this.lastReportedMatches === "number") {
      return this.lastReportedMatches;
    }
    return this.getTotalItemCount();
  }

  getSearchMatchCountForQuery(query: string) {
    const tokens = tokenizeSearchQuery(query);
    const state = this.store?.getState?.();
    const items = Array.isArray(state?.items) ? state.items : [];
    let count = 0;
    items.forEach((item) => {
      const text = typeof item?.text === "string" ? item.text : "";
      const isDone = Boolean(item?.done);
      if (
        matchesSearchEntry({
          originalText: text,
          tokens,
          showDone: this.showDone,
          isDone,
        })
      ) {
        count += 1;
      }
    });
    return count;
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
    const target = event.target as Element | null;
    const host = target?.closest?.("a4-tasklist") as A4TaskList | null;
    if (!host || typeof host.handleItemKeyDown !== "function") return;
    host.handleItemKeyDown(event);
  },
  true
);
