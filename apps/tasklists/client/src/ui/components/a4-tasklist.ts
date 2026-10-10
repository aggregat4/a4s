import { html, render, noChange } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import DraggableBehavior, { FlipAnimator } from "../../shared/drag-behavior.js";
import InlineTextEditor, {
  visibleSiblingTask,
} from "../../shared/inline-text-editor.js";
import {
  cloneListState,
  normalizeHeaderError,
  generateItemId,
} from "../state/list-store.js";
import {
  URL_PATTERN,
  evaluateSearchEntry,
  matchesSearchEntry,
  tokenizeSearchQuery,
} from "../state/highlight-utils.js";
import type { PatternConfig, PatternKind } from "../state/highlight-utils.js";
import { SHORTCUTS, matchesShortcut } from "../state/shortcuts.js";
import type { ListId, TaskItem, TaskListState } from "../../types/domain.js";
import type { ListRepository } from "../../app/list-repository.js";
import { applyPendingChanges } from "../state/pending-changes.js";
import type { PendingChange } from "../state/pending-changes.js";
import type { CaretBias, CaretPreference } from "../../types/caret.js";
import { isOffsetCaret } from "../../types/caret.js";
import {
  flattenToPlainText,
  handlePlainTextPaste,
} from "../../shared/plain-text-input.js";

type PatternDefinition = {
  regex: RegExp;
  className: string;
  priority?: number;
  kind?: PatternKind;
};

type PatternConfigEntry = PatternConfig;

const makeOffsetCaret = (value: number, bias?: CaretBias): CaretPreference => ({
  type: "offset",
  value,
  bias,
});

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
  private getEditingTarget: ((itemId: string) => HTMLElement | null) | null;
  private getItemSnapshot: ((itemId: string) => TaskItem | null) | null;
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
    const itemId = this.pendingItemId;
    if (!itemId) return false;
    const inlineEditor = this.getInlineEditor();
    if (!inlineEditor) return false;

    let textEl = this.getEditingTarget?.(itemId) ?? null;
    if (!textEl) {
      const listEl = this.getListElement();
      if (!listEl) return false;
      const selectorId = escapeSelectorId(itemId);
      const targetLi = listEl.querySelector(`li[data-item-id="${selectorId}"]`);
      textEl = targetLi?.querySelector(".text") ?? null;
      if (textEl && this.getItemSnapshot) {
        const snapshot = this.getItemSnapshot(itemId);
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
// Custom element binds the store and behaviors together so the prototype
// remains drop-in embeddable without a framework runtime.
class A4TaskList extends HTMLElement {
  private listEl: HTMLOListElement | null;
  private dragCoordinator: DraggableBehavior | null;
  private inlineEditor: InlineEditor | null;
  private headerEl: HTMLElement | null;
  private titleEl: HTMLElement | null;
  private searchInput: HTMLInputElement | null;
  private searchTimer: ReturnType<typeof setTimeout> | null;
  searchQuery: string;
  showDone: boolean;
  private _searchMode: boolean;
  /** The list as it is shown: the confirmed state with pending changes. */
  private state: TaskListState;
  /** Why the last save failed, until one succeeds or it is dismissed. */
  private headerError: TaskListState["headerError"];
  private suppressNameSync: boolean;
  /** The list as the repository last reported it. */
  private confirmedState: TaskListState | null;
  /** The user's changes the repository has not saved yet, in order. */
  private pendingChanges: PendingChange[][];
  /** Notes being typed, which are saved when the note loses focus. */
  private noteDrafts: Map<string, string>;
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
  private titleLiveUpdates: boolean;
  private openActionsItemId: string | null;
  private openNoteItemIds: Set<string>;
  private pendingNoteFocusId: string | null;
  private focusedItemId: string | null;
  private touchGestureState: Map<
    number,
    {
      startX: number;
      startY: number;
      target: HTMLElement;
      revealWidth: number;
      swiping: boolean;
      wasOpen: boolean;
    }
  >;
  private lastDragReorderMove: ReorderMove | null;
  private dragStartOrder: string[] | null;
  private editController: EditController;

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
    this._searchMode = false;
    this.state = { title: "", items: [], headerError: null };
    this.headerError = null;
    this.suppressNameSync = false;
    this.confirmedState = null;
    this.pendingChanges = [];
    this.noteDrafts = new Map();
    this.shellRendered = false;
    // Contexts and tags start a word, so "me@example.com" holds no context.
    this.patternConfig = this.normalizePatternDefs([
      {
        regex: URL_PATTERN,
        className: "task-token-link",
        kind: "link",
      },
      {
        regex: /(?<![\w@#])@[A-Za-z0-9_]+/g,
        className: "task-token-mention",
        priority: 2,
        kind: "search",
      },
      {
        regex: /(?<![\w@#])#[A-Za-z0-9_]+/g,
        className: "task-token-tag",
        priority: 2,
        kind: "search",
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
    this.titleLiveUpdates = false;
    this.openActionsItemId = null;
    this.openNoteItemIds = new Set();
    this.pendingNoteFocusId = null;
    this.focusedItemId = null;
    this.touchGestureState = new Map();
    this.lastDragReorderMove = null;
    this.dragStartOrder = null;

    this.handleSearchInput = this.handleSearchInput.bind(this);
    this.handleSearchKeyDown = this.handleSearchKeyDown.bind(this);
    this.handleItemBlur = this.handleItemBlur.bind(this);
    this.handleToggle = this.handleToggle.bind(this);
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
    this.handleNoteToggleClick = this.handleNoteToggleClick.bind(this);
    this.handleNoteInput = this.handleNoteInput.bind(this);
    this.handleNoteKeyDown = this.handleNoteKeyDown.bind(this);
    this.handleNoteBlur = this.handleNoteBlur.bind(this);
    this.handleNoteScroll = this.handleNoteScroll.bind(this);
    this.handleItemKeyDown = this.handleItemKeyDown.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.handleFocusOut = this.handleFocusOut.bind(this);
    this.handleListDragStart = this.handleListDragStart.bind(this);
    this.handleTitleClick = this.handleTitleClick.bind(this);
    this.handleTitleKeyDown = this.handleTitleKeyDown.bind(this);
    this.handleTitleBlur = this.handleTitleBlur.bind(this);
    this.handleTitleInput = this.handleTitleInput.bind(this);
    this.handleHeaderErrorDismiss = this.handleHeaderErrorDismiss.bind(this);
    this.handleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.handleTouchGestureStart = this.handleTouchGestureStart.bind(this);
    this.handleTouchGestureMove = this.handleTouchGestureMove.bind(this);
    this.handleTouchGestureEnd = this.handleTouchGestureEnd.bind(this);
    this.handleTouchGestureCancel = this.handleTouchGestureCancel.bind(this);
    this.handleDragFinalize = this.handleDragFinalize.bind(this);
    this.handleListKeyDown = this.handleListKeyDown.bind(this);
    this.handleTokenClick = this.handleTokenClick.bind(this);
    this.handleInlineInput = this.handleInlineInput.bind(this);

    this.editController = new EditController({
      getListElement: () => this.listEl,
      getInlineEditor: () => this.inlineEditor,
      getEditingTarget: (id) => this.getEditingTarget(id),
      getItemSnapshot: (id) => this.getItemSnapshot(id),
    });

    this.pendingEditFlushRequested = false;
    this._repository = null;
    this.repositoryUnsubscribe = null;
  }

  static get observedAttributes() {
    return ["name"];
  }

  get initialState() {
    return this.confirmedState;
  }

  set initialState(value: TaskListState | null) {
    this.applyRepositoryState(value ?? { title: "", items: [] });
  }

  connectedCallback() {
    this.renderShell();
    if (!this.listEl) return;
    this.renderHeader(this.getHeaderRenderState());

    this.showState();
    this.refreshRepositorySubscription();

    const listEl = this.listEl;
    if (!this.dragCoordinator) {
      this.dragCoordinator = new DraggableBehavior(listEl, {
        handleClass: "handle",
        animator: new FlipAnimator(),
        onReorder: (fromIndex, toIndex) => {
          const detail = { fromIndex, toIndex };
          this.lastDragReorderMove = detail;
          listEl.dispatchEvent(new CustomEvent("reorder", { detail }));
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
      this.dragCoordinator.enable();
    }

    this.ensureInlineEditor();

    this.listEl.removeEventListener("blur", this.handleItemBlur, true);
    this.listEl.addEventListener("blur", this.handleItemBlur, true);
    this.listEl.removeEventListener("keydown", this.handleListKeyDown, true);
    this.listEl.addEventListener("keydown", this.handleListKeyDown, true);
    this.listEl.removeEventListener("click", this.handleTokenClick);
    this.listEl.addEventListener("click", this.handleTokenClick);
    this.listEl.removeEventListener("focusin", this.handleFocusIn);
    this.listEl.addEventListener("focusin", this.handleFocusIn);
    this.listEl.removeEventListener("focusout", this.handleFocusOut);
    this.listEl.addEventListener("focusout", this.handleFocusOut);
    this.listEl.removeEventListener("touchstart", this.handleTouchGestureStart);
    this.listEl.addEventListener("touchstart", this.handleTouchGestureStart, {
      passive: true,
    });
    this.listEl.removeEventListener("touchmove", this.handleTouchGestureMove);
    this.listEl.addEventListener("touchmove", this.handleTouchGestureMove, {
      passive: false,
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

  /** Shows the repository's state, with the user's unsaved changes on top. */
  applyRepositoryState(state: TaskListState) {
    this.confirmedState = cloneListState(state);
    this.showState();
  }

  syncFromRepository() {
    if (!this._repository || !this.listId) return;
    const latest = this._repository.getListState(this.listId);
    if (latest) {
      this.applyRepositoryState(latest);
    }
  }

  /** The list as the user should see it. */
  shownState(): TaskListState {
    const changes: PendingChange[] = this.pendingChanges.flat();
    for (const [id, note] of this.noteDrafts) {
      changes.push({ type: "update", id, fields: { note } });
    }
    return applyPendingChanges(this.confirmedState ?? this.buildInitialState(), changes);
  }

  showState() {
    this.state = { ...this.shownState(), headerError: this.headerError };
    this.renderCurrentState();
  }

  setHeaderError(error: unknown) {
    this.headerError = normalizeHeaderError(error);
    this.showState();
  }

  /** Asks the repository for a change to this list, if it has one. */
  save(request: (repository: ListRepository, listId: ListId) => Promise<unknown>) {
    return this._repository && this.listId ? request(this._repository, this.listId) : null;
  }

  /**
   * A change of the user, shown right away. The repository saves changes one
   * at a time, and on a slow device it lags behind: until it has saved this
   * one, its snapshots predate it, so the change stays on top of them.
   * Without a repository the change is final.
   */
  changeList(changes: PendingChange[], saved: Promise<unknown> | null) {
    if (!saved) {
      this.confirmedState = applyPendingChanges(
        this.confirmedState ?? this.buildInitialState(),
        changes
      );
      this.showState();
      return;
    }
    this.pendingChanges.push(changes);
    this.showState();
    saved
      .finally(() => {
        this.pendingChanges = this.pendingChanges.filter((entry) => entry !== changes);
        this.syncFromRepository();
        this.showState();
      })
      .then(() => {
        if (this.headerError) this.setHeaderError(null);
      })
      .catch((err) => {
        this.setHeaderError({
          message:
            (err && err.message) ||
            "Sync failed. Please check your connection and retry.",
        });
      });
  }

  /** Reports the outcome of a change that is not shown before it is saved. */
  reportSave(saved: Promise<unknown> | null) {
    this.changeList([], saved);
  }

  buildInitialState(): TaskListState {
    const fallback: TaskListState = {
      title: this.getAttribute("name") ?? "",
      items: [],
    };
    const source = this.confirmedState ?? fallback;
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
    this.listEl?.removeEventListener("keydown", this.handleListKeyDown, true);
    this.listEl?.removeEventListener("click", this.handleTokenClick);
    this.listEl?.removeEventListener(
      "touchstart",
      this.handleTouchGestureStart
    );
    this.listEl?.removeEventListener("touchmove", this.handleTouchGestureMove);
    this.listEl?.removeEventListener("touchend", this.handleTouchGestureEnd);
    this.listEl?.removeEventListener(
      "touchcancel",
      this.handleTouchGestureCancel
    );
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.repositoryUnsubscribe?.();
    this.repositoryUnsubscribe = null;
    this.classList.remove("tasklist-no-matches");
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    this.touchGestureState.clear();
    this.openActionsItemId = null;
  }

  dispose() {
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
      this.changeList(
        [{ type: "rename", title: nextTitle }],
        this.save((repository, listId) => repository.renameList(listId, nextTitle))
      );
      this.renderHeader(this.getHeaderRenderState(this.state));
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

  getHeaderRenderState(state?: TaskListState | null) {
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
      searchMode: this._searchMode,
      headerError: state?.headerError ?? null,
    };
  }

  renderHeader(
    headerState: {
      title?: string;
      searchQuery?: string;
      showDone?: boolean;
      searchMode?: boolean;
      headerError?: { message?: string; code?: string } | null;
    } = {}
  ) {
    if (!this.headerEl) return;
    const headerError =
      headerState?.headerError &&
      typeof headerState.headerError.message === "string"
        ? headerState.headerError
        : null;
    const searchMode = Boolean(headerState?.searchMode);
    const titleText =
      this.isTitleEditing && this.titleEl
        ? this.titleEl.textContent ?? ""
        : typeof headerState.title === "string"
        ? headerState.title
        : "";
    const showDoneChecked = Boolean(headerState.showDone);

    // In search mode the title is a read-only label (no rename affordance)
    // and the "Add task" button is hidden; "Show done" stays so matched-but-
    // done items can be surfaced.
    const titleTemplate = searchMode
      ? html`
          <div class="tasklist-title-wrapper">
            <h2 class="tasklist-title" .textContent=${titleText}></h2>
          </div>
        `
      : html`
          <div class="tasklist-title-wrapper">
            <h2
              class=${`tasklist-title${this.isTitleEditing ? " is-editing" : ""}`}
              tabindex="0"
              contenteditable=${this.isTitleEditing ? "true" : null}
              spellcheck=${this.isTitleEditing ? "false" : null}
              role=${this.isTitleEditing ? "textbox" : null}
              aria-multiline=${this.isTitleEditing ? "false" : null}
              aria-label=${this.isTitleEditing ? "List title" : "Click to edit list title"}
              title=${this.isTitleEditing ? null : "Click to rename"}
              @click=${this.handleTitleClick}
              @input=${this.handleTitleInput}
              @paste=${handlePlainTextPaste}
              @keydown=${this.handleTitleKeyDown}
              @blur=${this.handleTitleBlur}
              .textContent=${live(titleText)}
            ></h2>
            <span class="tasklist-title-edit-icon" aria-hidden="true"></span>
          </div>
        `;

    const controlsTemplate = html`
      <div class="tasklist-controls">
        ${searchMode
          ? null
          : html`
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
            `}
        <label class="tasklist-show-done">
          <span class="tasklist-show-done-label">Show done</span>
          <input
            type="checkbox"
            class="tasklist-show-done-toggle switch"
            role="switch"
            aria-label="Show done tasks"
            ?checked=${showDoneChecked}
            @change=${this.handleShowDoneChange}
          />
        </label>
      </div>
    `;

    render(
      html`
        ${headerError
          ? html`
              <div class="tasklist-header-error" role="alert">
                <span class="tasklist-header-error-message">
                  ${headerError.message}
                </span>
                <button
                  type="button"
                  class="tasklist-header-error-dismiss"
                  @click=${this.handleHeaderErrorDismiss}
                >
                  Dismiss
                </button>
              </div>
            `
          : null}
        ${titleTemplate}
        ${controlsTemplate}
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
      onInput: this.handleInlineInput,
      onSplit: this.handleEditSplit,
      onMerge: this.handleEditMerge,
      onRemove: this.handleEditRemove,
      onMove: this.handleEditMove,
    });
    return this.inlineEditor;
  }

  startTitleEditing() {
    if (this.isTitleEditing) return;
    if (this._searchMode) return;
    this.isTitleEditing = true;
    // Capture current text before re-render so we can restore on cancel.
    this.titleOriginalValue = this.titleEl?.textContent ?? "";
    this.titleLiveUpdates = false;
    this.isTitleEditing = true;
    this.renderHeader(this.getHeaderRenderState(this.state));
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
    this.isTitleEditing = false;
    this.titleOriginalValue = "";
    this.titleLiveUpdates = false;
    this.renderHeader(this.getHeaderRenderState(this.state));
  }

  commitTitleEditing({ restoreFocus = true } = {}) {
    if (!this.titleEl || !this.isTitleEditing) return;
    const rawValue = this.titleEl.textContent ?? "";
    const trimmed = rawValue.trim();
    const previousValue = this.titleOriginalValue ?? "";
    const hadLiveUpdates = this.titleLiveUpdates;

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

    if (!hadLiveUpdates) {
      this.changeList(
        [{ type: "rename", title: trimmed }],
        this.save((repository, listId) => repository.renameList(listId, trimmed))
      );

      this.dispatchEvent(
        new CustomEvent("titlechange", {
          detail: { title: trimmed },
          bubbles: true,
          composed: true,
        })
      );
    }

    if (restoreFocus) {
      this.titleEl.focus();
    }
  }

  handleTitleInput(event: Event) {
    if (!this.isTitleEditing) return;
    const target = event.target as HTMLElement | null;
    if (!target?.classList?.contains("tasklist-title")) return;
    flattenToPlainText(target);
    const rawValue = target.textContent ?? "";
    const trimmed = rawValue.trim();
    const currentTitle = this.state.title ?? "";
    if (!trimmed.length || trimmed === currentTitle) return;
    this.titleLiveUpdates = true;
    this.changeList(
      [{ type: "rename", title: trimmed }],
      this.save((repository, listId) => repository.renameList(listId, trimmed))
    );
  }

  cancelTitleEditing({ restoreFocus = true } = {}) {
    if (!this.titleEl || !this.isTitleEditing) return;
    const previousValue = this.titleOriginalValue ?? "";
    const hadLiveUpdates = this.titleLiveUpdates;
    this.titleEl.textContent = previousValue;
    this.finishTitleEditing();
    if (hadLiveUpdates) {
      this.changeList(
        [{ type: "rename", title: previousValue }],
        this.save((repository, listId) => repository.renameList(listId, previousValue))
      );
    }
    if (restoreFocus) {
      this.titleEl.focus();
    }
  }

  handleTitleClick() {
    if (this._searchMode) return;
    if (this.isTitleEditing) return;
    this.startTitleEditing();
  }

  handleTitleKeyDown(event: KeyboardEvent) {
    if (this._searchMode) return;
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
    this.setHeaderError(null);
  }

  normalizePatternDefs(
    defs: Array<
      | PatternDefinition
      | { regex: string; className?: string; priority?: number; kind?: PatternKind }
      | null
      | undefined
    >
  ): PatternConfigEntry[] {
    // Accepts both literal regexes and plain objects so embedding pages can
    // configure highlights without worrying about flag safety or class naming.
    if (!Array.isArray(defs)) return [];
    const normalized: PatternConfigEntry[] = [];
    defs.forEach((def) => {
      if (!def) return;
      let { regex, className, priority } = def;
      const kind =
        def.kind === "link" || def.kind === "search" ? def.kind : undefined;
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
      const prio =
        typeof priority === "number" && Number.isFinite(priority)
          ? priority
          : 2;
      normalized.push({
        regexSource: regex.source,
        regexFlags: regex.flags,
        className: safeClass,
        priority: prio,
        key: `pattern:${safeClass}`,
        kind,
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
      kind: def.kind,
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
    this.setShowDone(Boolean((e.target as HTMLInputElement | null)?.checked));
  }

  setShowDone(value: boolean) {
    if (this.showDone === value) return;
    this.showDone = value;
    this.renderHeader(this.getHeaderRenderState(this.state));
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
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.searchQuery = "";
    this.renderHeader(this.getHeaderRenderState(this.state));
    this.renderCurrentState();
    this.dispatchEvent(
      new CustomEvent("clearsearch", { bubbles: true, composed: true })
    );
  }

  handleAddButtonClick() {
    this.addTask();
  }

  /** Inserts an empty task at the top of the list and starts editing it. */
  addTask() {
    this.ensureInlineEditor();
    this.clearSearch();
    const stateBefore = this.state;
    const firstItem =
      Array.isArray(stateBefore?.items) && stateBefore.items.length
        ? stateBefore.items[0].id
        : null;
    const newId = generateItemId();
    this.changeList(
      [
        {
          type: "insert",
          item: { id: newId, text: "", done: false, note: "" },
          afterId: null,
          beforeId: firstItem,
        },
      ],
      this.save((repository, listId) =>
        repository.insertTask(listId, {
          itemId: newId,
          text: "",
          done: false,
          beforeId: firstItem ?? undefined,
        })
      )
    );
    // Queue edit AFTER the change so the element exists when the edit is applied
    this.editController.queue(newId, "end");
    this.schedulePendingEditFlush();
  }

  handleEditSplit({
    element,
    beforeText,
    afterText,
    previousText: _previousText,
  }: {
    element: HTMLElement;
    beforeText: string;
    afterText: string;
    previousText: string;
  }) {
    if (!element) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) return;

    const state = this.state;
    const currentIndex = state.items.findIndex((item) => item.id === id);
    if (currentIndex === -1) return;
    const nextItemId = state.items[currentIndex + 1]?.id ?? null;

    const newId = generateItemId();
    const before = typeof beforeText === "string" ? beforeText : "";
    const after = typeof afterText === "string" ? afterText : "";
    this.changeList(
      [
        { type: "update", id, fields: { text: before } },
        {
          type: "insert",
          item: { id: newId, text: after, done: false, note: "" },
          afterId: id,
          beforeId: nextItemId,
        },
      ],
      this.save((repository, listId) =>
        repository.splitTask(listId, id, {
          beforeText: before,
          afterText: after,
          previousText: `${before}${after}`,
          newItemId: newId,
          afterId: id,
          beforeId: nextItemId ?? undefined,
        })
      )
    );
    // Queue edit AFTER the change so the element exists when the edit is applied
    this.editController.queue(newId, "start");
    // Try to start editing immediately; pending queue will retry if the node is not ready yet.
    this.startEditingItem(newId, "start");
    this.schedulePendingEditFlush();
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
    if (!currentItemId || !previousItemId) return false;

    const state = this.state;
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
    this.changeList(
      [
        { type: "update", id: previousItem.id, fields: { text: mergedText } },
        { type: "remove", id: currentItemId },
      ],
      this.save((repository, listId) =>
        repository.mergeTask(listId, previousItem.id, currentItemId, { mergedText })
      )
    );

    return true;
  }

  // Redirects focus when a task is deleted so keyboard users land on a sensible neighbor instead of losing their place.
  handleEditRemove({
    element,
    reason,
  }: {
    element: HTMLElement;
    reason?: string;
  }) {
    if (!element) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!li || !id) return;

    // Continue editing a task the user can see: never one hidden by "Show
    // done" or the search. Backspace in an empty task moves up, like deleting
    // an empty line in a text editor; the delete shortcut prefers the next one.
    const above = visibleSiblingTask(li, "up");
    const below = visibleSiblingTask(li, "down");
    const focusTarget =
      reason === "empty-backspace" ? above ?? below : below ?? above;
    const focusTargetId = focusTarget?.dataset?.itemId ?? null;
    if (focusTargetId) {
      this.editController.queue(focusTargetId, "end");
      this.schedulePendingEditFlush();
    } else {
      this.editController.clear();
    }

    if (this.openActionsItemId === id) {
      this.closeActionsForItem(id);
    }

    this.changeList(
      [{ type: "remove", id }],
      this.save((repository, listId) => repository.removeTask(listId, id))
    );
  }

  // Supports ctrl/cmd + arrow reordering while preserving caret placement, matching expectations from native outliners.
  handleEditMove({
    element,
    direction,
  }: {
    element: HTMLElement;
    direction: "up" | "down";
  }) {
    if (!element) return;
    const li = element.closest("li");
    const id = li?.dataset?.itemId;
    if (!id) return;

    const state = this.state;
    const items = Array.isArray(state?.items) ? state.items : [];
    const fromIndex = items.findIndex((item) => item.id === id);
    if (fromIndex === -1) return;

    const tokens = tokenizeSearchQuery(this.searchQuery);
    const visibleItems = items.filter((item) =>
      matchesSearchEntry({
        originalText: item?.text ?? "",
        noteText: item?.note ?? "",
        tokens,
        showDone: this.showDone,
        isDone: Boolean(item?.done),
      })
    );
    const visibleIndex = visibleItems.findIndex((item) => item.id === id);
    if (visibleIndex === -1) return;
    const targetVisibleIndex =
      direction === "down" ? visibleIndex + 1 : visibleIndex - 1;
    const targetItem = visibleItems[targetVisibleIndex] ?? null;
    if (!targetItem?.id) return;

    const order = items.map((item) => item.id);
    order.splice(fromIndex, 1);
    const targetIndexAfterRemoval = order.indexOf(targetItem.id);
    if (targetIndexAfterRemoval === -1) return;
    const toIndex =
      direction === "down" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
    order.splice(toIndex, 0, id);

    // Rendering keeps the task in edit, the cursor where it was.
    const afterId = order[toIndex - 1] ?? null;
    const beforeId = order[toIndex + 1] ?? null;
    this.changeList(
      [{ type: "move", id, afterId, beforeId }],
      this.save((repository, listId) =>
        repository.moveTaskWithinList(listId, id, {
          afterId: afterId ?? undefined,
          beforeId: beforeId ?? undefined,
        })
      )
    );
  }

  schedulePendingEditFlush() {
    if (this.pendingEditFlushRequested) return;
    this.pendingEditFlushRequested = true;
    const scheduleFlush = (cb: () => void) => {
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
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.renderCurrentState();
    }, delayMs);
  }

  renderCurrentState() {
    if (this.listEl) this.renderFromState(this.state);
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
    if (!this.inlineEditor) {
      this.ensureInlineEditor();
    }
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
      noteMarkup = null,
      noteMatched = false,
      isEditing = false,
    }: {
      isOpen?: boolean;
      hidden?: boolean;
      markup?: string | null;
      noteMarkup?: string | null;
      noteMatched?: boolean;
      isEditing?: boolean;
    } = {}
  ) {
    const isDone = Boolean(item.done);
    const itemId = item.id;
    const text = typeof item.text === "string" ? item.text : "";
    const note = typeof item.note === "string" ? item.note : "";
    const notePresent = note.trim().length > 0;
    const noteOpen = this.openNoteItemIds.has(itemId);
    // Auto-expand a note while a search matches it. Ephemeral: it does not
    // mutate openNoteItemIds, so it reverts when the search clears.
    const effectiveNoteOpen = noteOpen || noteMatched;
    const noteLabel = notePresent ? "Edit note" : "Add note";
    const isFocused = this.focusedItemId === itemId;
    const htmlContent = isEditing
      ? noChange
      : live(markup != null ? markup : escapeHTML(text));
    const textSpan = html`
      <span
        class=${`text task-text${isEditing ? " text-editing" : ""}${
          isDone ? " text-checked" : ""
        }`}
        tabindex="0"
        role="textbox"
        aria-label="Task"
        data-original-text=${text}
        .innerHTML=${htmlContent as string}
      ></span>
    `;

    return html`
      <li
        class=${`task-item${isFocused ? " is-focused" : ""}`}
        data-item-id=${itemId}
        data-done=${isDone ? "true" : "false"}
        draggable=${noteOpen || isEditing ? "false" : "true"}
        ?hidden=${hidden}
      >
        <div class="task-item-body">
          <div class="task-item-main">
            <input
              type="checkbox"
              class="done-toggle"
              .checked=${live(isDone)}
              @change=${this.handleToggle}
            />
            ${textSpan}
            <div class="task-item-trailing">
              <button
                type="button"
                class=${`task-note-toggle${notePresent ? " has-note" : ""}`}
                aria-pressed=${effectiveNoteOpen ? "true" : "false"}
                aria-expanded=${effectiveNoteOpen ? "true" : "false"}
                aria-label=${noteLabel}
                title=${noteLabel}
                @click=${this.handleNoteToggleClick}
              ></button>
              <span class="handle" aria-hidden="true"></span>
            </div>
          </div>
          ${effectiveNoteOpen
            ? html`
                <div class="task-note-panel">
                  <div class="task-note-scroll-wrap">
                    ${noteMatched
                      ? html`<div
                          class="task-note-highlight"
                          .innerHTML=${noteMarkup ?? ""}
                        ></div>`
                      : html`<textarea
                          class="task-note-input"
                          rows="5"
                          placeholder="Add a note..."
                          .value=${this.isNoteInputActive(itemId)
                            ? noChange
                            : note}
                          @input=${this.handleNoteInput}
                          @blur=${this.handleNoteBlur}
                          @scroll=${this.handleNoteScroll}
                          @keydown=${this.handleNoteKeyDown}
                        ></textarea>`}
                  </div>
                </div>
              `
            : null}
        </div>
        <div
          class=${`task-item-actions${isOpen ? " task-item-actions-open" : ""}`}
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
            class=${`task-item-toggle ${
              isOpen ? "task-item-toggle-open" : "closed"
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
  renderFromState(state?: TaskListState) {
    if (!this.listEl || !state) return;

    this.renderHeader(this.getHeaderRenderState(state));

    const preservedFocus = this.captureFocus();
    const openActionsId = this.openActionsItemId;
    const tokens = tokenizeSearchQuery(this.searchQuery);
    const forceVisible = this.editController.getForceVisibleIds();
    const editingId =
      this.inlineEditor?.editingEl?.closest?.("li")?.dataset?.itemId ?? null;

    let visibleCount = 0;
    const itemsTemplate = repeat(
      state.items ?? [],
      (item) => item.id,
      (item) => {
        const text = typeof item.text === "string" ? item.text : "";
        const note = typeof item.note === "string" ? item.note : "";
        const isEditing = editingId === item.id;
        let hidden = false;
        let markup = null;
        let noteMarkup = null;
        let noteMatched = false;
        if (!isEditing) {
          const result = evaluateSearchEntry({
            originalText: text,
            noteText: note,
            tokens,
            patternConfig: this.patternConfig,
            showDone: this.showDone,
            isDone: item.done,
          });
          hidden = result.hidden;
          markup = result.markup;
          noteMarkup = result.noteMarkup;
          noteMatched = result.noteMatched;
        }
        if (forceVisible?.has(item.id)) {
          hidden = false;
          markup = null;
          noteMarkup = null;
          noteMatched = false;
        }
        if (!hidden) {
          visibleCount += 1;
        }
        return this.renderItemTemplate(item, {
          isOpen: openActionsId === item.id,
          hidden,
          markup,
          noteMarkup,
          noteMatched,
          isEditing,
        });
      }
    );
    const renderItems = () => render(html`${itemsTemplate}`, this.listEl!);
    if (this.inlineEditor) this.inlineEditor.keepEditingThrough(renderItems);
    else renderItems();
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

    if (this.isTitleEditing && this.titleEl) {
      const currentTitleText = this.titleEl.textContent ?? "";
      if (currentTitleText !== nextTitle) {
        this.titleEl.textContent = nextTitle;
        const caretTarget = nextTitle.length;
        if (this.inlineEditor) {
          this.inlineEditor.setSelectionAtOffset(
            this.titleEl,
            caretTarget,
            "end"
          );
        }
      }
    }

    if (editingId && this.inlineEditor?.editingEl) {
      const editingEl = this.inlineEditor.editingEl;
      const stateItem = state.items?.find((item) => item.id === editingId) ?? null;
      if (stateItem) {
        // Another device changed the text: show it, the cursor where it was.
        const desiredText = stateItem.text ?? "";
        if ((editingEl.textContent ?? "") !== desiredText) {
          const { start } = this.inlineEditor.getSelectionOffsets(editingEl);
          editingEl.textContent = desiredText;
          editingEl.dataset.originalText = desiredText;
          this.inlineEditor.setSelectionAtOffset(editingEl, start);
        }
      }
    }

    let hasPendingEdit = this.editController.hasPending();

    let appliedPendingEdit = false;
    if (hasPendingEdit) {
      appliedPendingEdit = this.editController.applyPendingEdit() === true;
      hasPendingEdit = this.editController.hasPending();
    }

    this.restoreFocus(preservedFocus, {
      skip: hasPendingEdit || appliedPendingEdit,
    });

    if (this.openNoteItemIds.size > 0) {
      for (const itemId of this.openNoteItemIds) {
        const noteInput = this.listEl.querySelector(
          `li[data-item-id="${escapeSelectorId(itemId)}"] .task-note-input`
        ) as HTMLTextAreaElement | null;
        if (noteInput) {
          this.updateNoteScrollState(noteInput);
        }
      }
    }

    if (
      this.openActionsItemId &&
      !state.items?.some((item) => item.id === this.openActionsItemId)
    ) {
      this.openActionsItemId = null;
    }
    if (this.openNoteItemIds.size && Array.isArray(state.items)) {
      const validIds = new Set(state.items.map((item) => item.id));
      for (const id of this.openNoteItemIds) {
        if (!validIds.has(id)) {
          this.openNoteItemIds.delete(id);
        }
      }
    }
    if (this.pendingNoteFocusId) {
      const targetId = this.pendingNoteFocusId;
      this.pendingNoteFocusId = null;
      const selectorId = escapeSelectorId(targetId);
      const target = this.listEl?.querySelector(
        `li[data-item-id="${selectorId}"] .task-note-input`
      ) as HTMLTextAreaElement | null;
      if (target) {
        target.focus();
        const end = target.value.length;
        target.setSelectionRange(end, end);
        this.updateNoteScrollState(target);
      }
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
    if (!id) return;
    const nextDone = Boolean((target as HTMLInputElement).checked);
    // Request the change right away so it is queued in the order of the
    // user's actions: an undo pressed right after must find it.
    const saved = this.save((repository, listId) =>
      repository.toggleTask(listId, id, nextDone)
    );
    // Show it once click events settle, as the list then rerenders and hides
    // completed items.
    setTimeout(() => {
      this.changeList([{ type: "update", id, fields: { done: nextDone } }], saved);
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
      new CustomEvent("task-move-request", {
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
    if (!itemId) return;

    const snapshot = this.getItemSnapshot(itemId);
    const confirmationMessage = snapshot?.text
      ? `Delete "${snapshot.text}"?`
      : "Delete this task?";
    if (!window.confirm(confirmationMessage)) {
      return;
    }

    const state = this.state;
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
    this.changeList(
      [{ type: "remove", id: itemId }],
      this.save((repository, listId) => repository.removeTask(listId, itemId))
    );
  }

  handleActionToggleClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
    const li = button?.closest("li");
    if (!li) return;
    const itemId = li.dataset?.itemId ?? null;
    if (!itemId) return;
    this.openActionsItemId = this.openActionsItemId === itemId ? null : itemId;
    this.renderFromState(this.state);
  }

  isNoteInputActive(itemId: string) {
    const activeElement = document.activeElement;
    if (!activeElement?.classList?.contains("task-note-input")) return false;
    return activeElement.closest("li")?.dataset?.itemId === itemId;
  }

  /** Saves a note that was typed, if it changed. */
  commitNoteChange(itemId: string, nextNote: string) {
    this.noteDrafts.delete(itemId);
    const item = this.confirmedItem(itemId);
    if (!item || (item.note ?? "") === nextNote) return;
    this.changeList(
      [{ type: "update", id: itemId, fields: { note: nextNote } }],
      this.save((repository, listId) => repository.updateTask(listId, itemId, { note: nextNote }))
    );
  }

  /** An item as the repository and the pending changes have it, without drafts. */
  confirmedItem(itemId: string) {
    const base = this.confirmedState ?? this.buildInitialState();
    return applyPendingChanges(base, this.pendingChanges.flat()).items.find(
      (item) => item.id === itemId
    );
  }

  flushNoteChange(itemId: string, nextNote: string) {
    this.commitNoteChange(itemId, nextNote);
  }

  updateNoteScrollState(textarea: HTMLTextAreaElement) {
    const wrap = textarea.closest(".task-note-scroll-wrap");
    if (!wrap) return;
    const atTop = textarea.scrollTop <= 1;
    const atBottom =
      textarea.scrollTop + textarea.clientHeight >= textarea.scrollHeight - 1;
    const overflows = textarea.scrollHeight > textarea.clientHeight + 1;
    wrap.classList.toggle("is-scrolled-down", overflows && !atTop);
    wrap.classList.toggle("is-scrolled-up", overflows && !atBottom);
  }

  handleNoteScroll(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    if (!target) return;
    this.updateNoteScrollState(target);
  }

  handleNoteBlur(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    const li = target?.closest("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId || !target) return;
    this.flushNoteChange(itemId, target.value ?? "");
  }

  handleNoteToggleClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
    const li = button?.closest("li");
    if (!li) return;
    const itemId = li.dataset?.itemId ?? null;
    if (!itemId) return;
    const shouldFocus = this.openNoteItemIds.has(itemId) === false;
    this.toggleNoteForItem(itemId, { focus: shouldFocus });
  }

  handleNoteInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    const li = target?.closest("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId || !target) return;
    this.noteDrafts.set(itemId, target.value ?? "");
    this.updateNoteScrollState(target);
  }

  handleNoteKeyDown(event: KeyboardEvent) {
    if (!event) return;
    if (
      event.key !== "Escape" &&
      !matchesShortcut(event, SHORTCUTS.toggleNote)
    ) {
      return;
    }
    const target = event.currentTarget as HTMLElement | null;
    const li = target?.closest("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
    event.preventDefault();
    if (matchesShortcut(event, SHORTCUTS.toggleNote)) {
      this.toggleNoteForItem(itemId, { restoreEdit: true });
      return;
    }
    const noteInput = li?.querySelector(
      ".task-note-input"
    ) as HTMLTextAreaElement | null;
    if (noteInput) {
      this.flushNoteChange(itemId, noteInput.value ?? "");
    }
    this.openNoteItemIds.delete(itemId);
    this.renderFromState(this.state);
    const textTarget = li?.querySelector(".text") as HTMLElement | null;
    textTarget?.focus();
  }

  toggleItemDone(itemId: string) {
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    const nextDone = !Boolean(snapshot.done);
    const shouldMoveFocus = nextDone && this.showDone === false;
    if (shouldMoveFocus) {
      const state = this.state;
      const items = Array.isArray(state?.items) ? state.items : [];
      const tokens = tokenizeSearchQuery(this.searchQuery);
      const isVisible = (item: TaskItem) =>
        matchesSearchEntry({
          originalText: item?.text ?? "",
          noteText: item?.note ?? "",
          tokens,
          showDone: this.showDone,
          isDone: Boolean(item?.done),
        });
      const currentIndex = items.findIndex((item) => item.id === itemId);
      let focusTargetId: string | null = null;
      if (currentIndex !== -1) {
        for (let i = currentIndex + 1; i < items.length; i += 1) {
          if (isVisible(items[i])) {
            focusTargetId = items[i].id;
            break;
          }
        }
        if (!focusTargetId) {
          for (let i = currentIndex - 1; i >= 0; i -= 1) {
            if (isVisible(items[i])) {
              focusTargetId = items[i].id;
              break;
            }
          }
        }
      }
      if (this.inlineEditor?.editingEl) {
        this.inlineEditor.finishEditing(this.inlineEditor.editingEl);
      }
      if (focusTargetId) {
        this.editController.queue(focusTargetId, "end");
        this.schedulePendingEditFlush();
      } else {
        this.editController.clear();
      }
    }
    setTimeout(() => {
      this.changeList(
        [{ type: "update", id: itemId, fields: { done: nextDone } }],
        this.save((repository, listId) => repository.toggleTask(listId, itemId, nextDone))
      );
    }, 0);
  }

  toggleNoteForItem(
    itemId: string,
    { focus = false, restoreEdit = false } = {}
  ) {
    if (!itemId) return;
    let restoreCaret: CaretPreference | null = null;
    if (this.openNoteItemIds.has(itemId)) {
      const noteInput = this.listEl?.querySelector(
        `li[data-item-id="${escapeSelectorId(itemId)}"] .task-note-input`
      ) as HTMLTextAreaElement | null;
      if (noteInput) {
        this.flushNoteChange(itemId, noteInput.value ?? "");
      }
      this.openNoteItemIds.delete(itemId);
      this.pendingNoteFocusId = null;
      if (restoreEdit) {
        restoreCaret = "end";
      }
    } else {
      const textEl = this.getEditingTarget(itemId);
      if (textEl && this.inlineEditor?.editingEl === textEl) {
        this.inlineEditor.finishEditing(textEl);
      }
      this.openNoteItemIds.add(itemId);
      this.pendingNoteFocusId = focus ? itemId : null;
    }
    this.renderFromState(this.state);
    if (restoreCaret) {
      setTimeout(() => {
        this.startEditingItem(itemId, restoreCaret);
      }, 0);
    }
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
      this.renderFromState(this.state);
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
    this.renderFromState(this.state);
  }

  getTaskActionsRevealWidth(li: HTMLElement) {
    const actions = li.querySelector(".task-item-actions");
    if (!(actions instanceof HTMLElement)) return 128;
    return Math.max(96, Math.min(actions.scrollWidth || 128, 180));
  }

  setTaskSwipeReveal(li: HTMLElement, reveal: number, revealWidth: number) {
    const clamped = Math.max(0, Math.min(reveal, revealWidth));
    li.style.setProperty("--task-swipe-translate", `${-clamped}px`);
    li.style.setProperty("--task-actions-reveal-width", `${revealWidth}px`);
    li.classList.toggle("task-item-swiping", clamped > 0);
  }

  clearTaskSwipeReveal(li: HTMLElement | null | undefined) {
    if (!li) return;
    li.classList.remove("task-item-swiping");
    li.style.removeProperty("--task-swipe-translate");
    li.style.removeProperty("--task-actions-reveal-width");
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
        this.renderFromState(this.state);
      }
      if (!element) return;
      const li = element.closest("li");
      if (!li) return;
      if (element.closest(".handle")) return;
      if (element.closest(".task-item-actions")) return;
      if (element.closest(".task-item-toggle")) return;
      if (element.closest(".task-note-toggle")) return;
      if (element.closest(".task-note-panel")) return;
      const itemId = li.dataset?.itemId ?? null;
      this.touchGestureState.set(touch.identifier, {
        startX: touch.clientX,
        startY: touch.clientY,
        target: li,
        revealWidth: this.getTaskActionsRevealWidth(li),
        swiping: false,
        wasOpen: itemId != null && this.openActionsItemId === itemId,
      });
    });
  }

  handleTouchGestureMove(event: TouchEvent) {
    if (!event?.changedTouches) return;
    Array.from(event.changedTouches).forEach((touch) => {
      const state = this.touchGestureState.get(touch.identifier);
      if (!state) return;
      const li = state.target;
      if (!li || !li.isConnected) {
        this.touchGestureState.delete(touch.identifier);
        return;
      }
      const deltaX = touch.clientX - state.startX;
      const deltaY = touch.clientY - state.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (!state.swiping) {
        if (absX < 8) return;
        if (absX < absY) {
          this.clearTaskSwipeReveal(li);
          this.touchGestureState.delete(touch.identifier);
          return;
        }
        state.swiping = true;
      }
      event.preventDefault();
      const startReveal = state.wasOpen ? state.revealWidth : 0;
      const reveal = Math.max(
        0,
        Math.min(state.revealWidth, startReveal - deltaX)
      );
      this.setTaskSwipeReveal(li, reveal, state.revealWidth);
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
      this.clearTaskSwipeReveal(li);
      if (Math.abs(deltaX) < 30) return;
      if (Math.abs(deltaX) < Math.abs(deltaY)) return;
      const startReveal = state.wasOpen ? state.revealWidth : 0;
      const reveal = Math.max(
        0,
        Math.min(state.revealWidth, startReveal - deltaX)
      );
      if (reveal > state.revealWidth / 2) {
        const itemId = li.dataset?.itemId ?? null;
        this.openActionsItemId = itemId;
        this.renderFromState(this.state);
      } else {
        this.openActionsItemId = null;
        this.renderFromState(this.state);
      }
    });
  }

  handleTouchGestureCancel(event: TouchEvent) {
    if (!event?.changedTouches) return;
    Array.from(event.changedTouches).forEach((touch) => {
      const state = this.touchGestureState.get(touch.identifier);
      this.clearTaskSwipeReveal(state?.target);
      this.touchGestureState.delete(touch.identifier);
    });
  }

  handleItemKeyDown(event: KeyboardEvent) {
    if (!event || event.defaultPrevented) return;
    if (event.isComposing) return;
    if (matchesShortcut(event, SHORTCUTS.toggleNote)) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.classList.contains("task-note-input")) {
        return;
      }
      const li = target.closest?.("li");
      if (!li) return;
      const itemId = li.dataset?.itemId ?? null;
      if (!itemId) return;
      event.preventDefault();
      this.toggleNoteForItem(itemId, { focus: true });
      return;
    }
    if (
      matchesShortcut(event, SHORTCUTS.jumpToListStart) ||
      matchesShortcut(event, SHORTCUTS.jumpToListEnd)
    ) {
      const target = event.target as HTMLElement | null;
      if (target?.classList?.contains("task-note-input")) return;
      const items = this.state.items;
      if (!items.length) return;
      const tokens = tokenizeSearchQuery(this.searchQuery);
      const isVisible = (item: TaskItem) =>
        matchesSearchEntry({
          originalText: item?.text ?? "",
          noteText: item?.note ?? "",
          tokens,
          showDone: this.showDone,
          isDone: Boolean(item?.done),
        });
      const isEnd = matchesShortcut(event, SHORTCUTS.jumpToListEnd);
      let targetItem: TaskItem | null = null;
      if (isEnd) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (isVisible(items[i])) {
            targetItem = items[i];
            break;
          }
        }
      } else {
        for (let i = 0; i < items.length; i += 1) {
          if (isVisible(items[i])) {
            targetItem = items[i];
            break;
          }
        }
      }
      if (!targetItem?.id) return;
      event.preventDefault();
      this.startEditingItem(targetItem.id, isEnd ? "end" : "start");
      return;
    }
    if (matchesShortcut(event, SHORTCUTS.toggleDone)) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const li = target.closest?.("li");
      if (!li) return;
      const itemId = li.dataset?.itemId ?? null;
      if (!itemId) return;
      event.preventDefault();
      this.toggleItemDone(itemId);
      return;
    }
    if (!matchesShortcut(event, SHORTCUTS.moveTask)) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const li = target.closest?.("li");
    if (!li) return;
    const itemId = li.dataset?.itemId ?? null;
    if (!itemId) return;
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("task-move-request", {
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

  handleInlineInput({
    element,
    text,
  }: {
    element: HTMLElement;
    text: string;
  }) {
    if (!element?.classList?.contains("text")) return;
    if (!element.isContentEditable) return;
    const li = element.closest("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
    const newText = text ?? "";
    const stateItem = this.state.items.find((item) => item.id === itemId);
    if (!stateItem) return;
    if (stateItem.text === newText) return;
    this.changeList(
      [{ type: "update", id: itemId, fields: { text: newText } }],
      this.save((repository, listId) => repository.updateTask(listId, itemId, { text: newText }))
    );
  }

  /**
   * A tag or context in task text was clicked: ask the app to add it to the
   * search. Links need no handling; they open in a new tab.
   */
  handleTokenClick(event: MouseEvent) {
    const button = (event.target as Element | null)?.closest?.(
      "[data-search-token]"
    ) as HTMLElement | null;
    const token = button?.dataset.searchToken;
    if (!button || !token || !this.listEl?.contains(button)) return;
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("tokensearch", {
        detail: { token },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleListKeyDown(event: KeyboardEvent) {
    if (!this._repository) return;
    if (!event || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    const isEditing = Boolean(target?.closest?.("[contenteditable='true']"));
    if (!isEditing) return;
    if (matchesShortcut(event, SHORTCUTS.toggleDone)) {
      const li = target?.closest?.("li");
      const itemId = li?.dataset?.itemId ?? null;
      if (!itemId) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleItemDone(itemId);
      return;
    }
    if (matchesShortcut(event, SHORTCUTS.undo)) {
      event.preventDefault();
      void this._repository.undo();
      return;
    }
    if (
      matchesShortcut(event, SHORTCUTS.redo) ||
      matchesShortcut(event, SHORTCUTS.redoAlt)
    ) {
      event.preventDefault();
      void this._repository.redo();
    }
  }

  handleFocusIn(event: FocusEvent) {
    const target = event.target as HTMLElement | null;
    const li = target?.closest?.("li");
    const itemId = li?.dataset?.itemId ?? null;
    if (!itemId) return;
    if (this.focusedItemId && this.focusedItemId !== itemId) {
      const previous = this.listEl?.querySelector(
        `li[data-item-id="${escapeSelectorId(this.focusedItemId)}"]`
      );
      previous?.classList.remove("is-focused");
    }
    this.focusedItemId = itemId;
    li?.classList.add("is-focused");
    this.dispatchEvent(
      new CustomEvent("task-focus", {
        detail: {
          itemId,
          sourceListId: this.listId,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleFocusOut(event: FocusEvent) {
    const target = event.target as HTMLElement | null;
    const li = target?.closest?.("li");
    if (!li) return;
    const related = event.relatedTarget as HTMLElement | null;
    if (related && li.contains(related)) return;
    const itemId = li?.dataset?.itemId ?? null;
    if (itemId && this.focusedItemId === itemId) {
      this.focusedItemId = null;
    }
    li.classList.remove("is-focused");
  }

  handleListDragStart(event: DragEvent) {
    this.lastDragReorderMove = null;
    this.dragStartOrder =
      this.state.items?.map((item) => item.id) ?? null;
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
    if (!element) {
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
    const currentState = this.state;
    const stateItem = currentState?.items?.find((item) => item.id === id);
    if (!stateItem) {
      this.scheduleSearchRender(0);
      return;
    }
    if (newText === previousText) {
      this.scheduleSearchRender(0);
      return;
    }
    if (stateItem.text === newText) {
      element.dataset.originalText = newText;
      this.scheduleSearchRender(0);
      return;
    }
    this.changeList(
      [{ type: "update", id, fields: { text: newText } }],
      this.save((repository, listId) => repository.updateTask(listId, id, { text: newText }))
    );
  }

  scheduleReorderUpdate({
    beforeOrder,
    move,
  }: { beforeOrder?: string[] | null; move?: ReorderMove | null } = {}) {
    if (!this.listEl) return;
    Promise.resolve().then(() => {
      if (!this.listEl) return;
      if (!Array.isArray(beforeOrder) || !beforeOrder.length) return;

      let order: string[] = [];
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
          .filter((id): id is string => Boolean(id));
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

      const findMovedId = (before: string[], after: string[]) => {
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
      if (!movedId) {
        this.renderCurrentState();
        return;
      }

      const id = movedId;
      const targetIndex = order.indexOf(id);
      const afterId = order[targetIndex - 1] ?? null;
      const beforeId = order[targetIndex + 1] ?? null;
      this.changeList(
        [{ type: "move", id, afterId, beforeId }],
        this.save((repository, listId) =>
          repository.moveTaskWithinList(listId, id, {
            afterId: afterId ?? undefined,
            beforeId: beforeId ?? undefined,
          })
        )
      );
    });
  }

  handleItemBlur(e: FocusEvent) {
    const target = e.target as HTMLElement | null;
    const textEl = target?.classList?.contains("text") ? target : null;
    if (!textEl) return;
    textEl.dataset.originalText = textEl.textContent;
    this.scheduleSearchRender(0);
  }

  applyFilter(query: string) {
    const value = typeof query === "string" ? query : "";
    this.searchQuery = value;
    if (!this.listEl) {
      this.renderShell();
    }
    this.renderHeader(this.getHeaderRenderState(this.state));
    this.renderCurrentState();
  }

  clearFilter() {
    this.applyFilter("");
  }

  getItemSnapshot(itemId: string) {
    if (!itemId) return null;
    const state = this.state;
    const items = Array.isArray(state?.items) ? state.items : [];
    const found = items.find((item) => item.id === itemId);
    return found ? { ...found } : null;
  }

  firstItemId() {
    return this.state.items[0]?.id ?? null;
  }

  /** Removes a task that moves to another list, until `saved` settles. */
  removeItemById(itemId: string, saved: Promise<unknown> | null) {
    if (!itemId) return false;
    if (!this.state.items.some((item) => item.id === itemId)) {
      return false;
    }
    this.changeList([{ type: "remove", id: itemId }], saved);
    return true;
  }

  /** Adds a task that moves here from another list, until `saved` settles. */
  prependItem(item: TaskItem, saved: Promise<unknown> | null) {
    if (!item || !item.id) return false;
    const first = this.firstItemId();
    this.changeList(
      [
        {
          type: "insert",
          item: {
            id: item.id,
            text: typeof item.text === "string" ? item.text : "",
            done: Boolean(item.done),
            note: typeof item.note === "string" ? item.note : "",
          },
          afterId: null,
          beforeId: first,
        },
      ],
      saved
    );
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

  getTotalItemCount() {
        const state = this.state;
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
    const state = this.state;
    const items = Array.isArray(state?.items) ? state.items : [];
    let count = 0;
    items.forEach((item) => {
      const text = typeof item?.text === "string" ? item.text : "";
      const note = typeof item?.note === "string" ? item.note : "";
      const isDone = Boolean(item?.done);
      if (
        matchesSearchEntry({
          originalText: text,
          noteText: note,
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

  /**
   * Capture the current focus state within the list for later restoration.
   * Returns null if focus is not within the list.
   */
  captureFocus(): { itemId: string; role: "toggle" | "text" | "note" } | null {
    const listEl = this.listEl;
    if (!listEl) return null;
    const activeElement = document.activeElement;
    if (!activeElement || !listEl.contains(activeElement as Node)) return null;
    const activeLi = (activeElement as Element).closest("li");
    if (!activeLi?.dataset?.itemId) return null;
    const role: "toggle" | "text" | "note" | null =
      activeElement.classList.contains("done-toggle")
        ? "toggle"
        : activeElement.classList.contains("text")
        ? "text"
        : activeElement.classList.contains("task-note-input")
        ? "note"
        : null;
    return role ? { itemId: activeLi.dataset.itemId, role } : null;
  }

  /**
   * Restore focus to a previously captured focus state.
   */
  restoreFocus(
    preservedFocus: { itemId: string; role: "toggle" | "text" | "note" } | null,
    { skip }: { skip?: boolean } = {}
  ) {
    if (skip || !preservedFocus) return;
    const listEl = this.listEl;
    if (!listEl) return;
    const selectorId = escapeSelectorId(preservedFocus.itemId);
    const targetLi = listEl.querySelector(`li[data-item-id="${selectorId}"]`);
    if (!targetLi) return;
    const focusTarget =
      preservedFocus.role === "toggle"
        ? targetLi.querySelector(".done-toggle")
        : preservedFocus.role === "text"
        ? targetLi.querySelector(".text")
        : preservedFocus.role === "note"
        ? targetLi.querySelector(".task-note-input")
        : null;
    if (!focusTarget) return;
    (focusTarget as HTMLElement).focus();
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

  get searchMode() {
    return this._searchMode;
  }

  set searchMode(value) {
    const next = Boolean(value);
    if (next === this._searchMode) return;
    this._searchMode = next;
    if (this.shellRendered) {
      this.renderHeader(this.getHeaderRenderState(this.state));
    }
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
