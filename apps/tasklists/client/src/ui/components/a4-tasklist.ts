import { html, render, noChange } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import DraggableBehavior, { FlipAnimator } from "../../shared/drag-behavior.js";
import InlineTextEditor, {
  visibleSiblingTask,
} from "../../shared/inline-text-editor.js";
import { generateItemId } from "../state/list-store.js";
import { ListState } from "../state/list-state.js";
import "./tasklist-header.js";
import type { TaskListHeaderElement } from "./tasklist-header.js";
import { TaskActions } from "./task-actions.js";
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
import type { CaretBias, CaretPreference } from "../../types/caret.js";

/** A highlighted kind of token in task text. */
const pattern = (regex: RegExp, className: string, kind: PatternKind): PatternConfig => ({
  regexSource: regex.source,
  regexFlags: regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
  className,
  priority: 2,
  key: `pattern:${className}`,
  kind,
});

// Contexts and tags start a word, so "me@example.com" holds no context.
const TASK_PATTERNS = [
  pattern(URL_PATTERN, "task-token-link", "link"),
  pattern(/(?<![\w@#])@[A-Za-z0-9_]+/g, "task-token-mention", "search"),
  pattern(/(?<![\w@#])#[A-Za-z0-9_]+/g, "task-token-tag", "search"),
];

const makeOffsetCaret = (value: number, bias?: CaretBias): CaretPreference => ({
  type: "offset",
  value,
  bias,
});

type InlineEditor = InstanceType<typeof InlineTextEditor>;

/** Where a dragged task was dropped: between two tasks. */
type DragMove = { id: string; afterId: string | null; beforeId: string | null };

const itemIdOf = (element: Element | null) =>
  (element as HTMLElement | null)?.dataset.itemId ?? null;

/** The id of the task an element is part of. */
const taskIdOf = (node: EventTarget | null) =>
  node instanceof Element ? itemIdOf(node.closest("li")) : null;

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

/**
 * One task list: renders a list's tasks with lit and handles editing, ticking
 * off, moving, notes and search. It shows the repository's state of the list
 * through `ListState`, with the user's changes on top until they are saved.
 */
class A4TaskList extends HTMLElement {
  private listEl: HTMLOListElement | null;
  private dragCoordinator: DraggableBehavior | null;
  private inlineEditor: InlineEditor | null;
  private header: TaskListHeaderElement | null;
  private searchTimer: ReturnType<typeof setTimeout> | null;
  searchQuery: string;
  showDone: boolean;
  private _searchMode: boolean;
  /** The list as the repository has it, with the user's unsaved changes. */
  private list: ListState;
  private shellRendered: boolean;
  private listIdentifier: ListId | null;
  /** The detail of each change event last emitted, to emit only changes. */
  private reported: Map<string, string>;
  private emptyStateEl: HTMLElement | null;
  /** Which task shows its actions, opened by its button or by swiping. */
  private actions: TaskActions;
  private openNoteItemIds: Set<string>;
  private pendingNoteFocusId: string | null;
  private focusedItemId: string | null;
  /** A drop to save once the drag is over. */
  private dragMove: DragMove | null;
  /** A task to edit once it is rendered, and where the cursor goes in it. */
  private nextEdit: { itemId: string; caret: CaretPreference } | null;

  private _repository: ListRepository | null;
  /** Aborted when the element is disconnected, removing its listeners. */
  private connection: AbortController | null;

  constructor() {
    super();
    this.listEl = null;
    this.dragCoordinator = null;
    this.inlineEditor = null;
    this.header = null;
    this.searchTimer = null;
    this.searchQuery = "";
    this.showDone = false;
    this._searchMode = false;
    this.list = new ListState(() => this.renderCurrentState());
    this.shellRendered = false;

    this.listIdentifier = this.dataset.listId ?? null;
    this.reported = new Map();
    this.emptyStateEl = null;
    this.actions = new TaskActions({
      itemElement: (itemId) => this.itemElement(itemId),
      onChange: () => this.renderCurrentState(),
    });
    this.openNoteItemIds = new Set();
    this.pendingNoteFocusId = null;
    this.focusedItemId = null;
    this.dragMove = null;

    this.nextEdit = null;

    this._repository = null;
    this.connection = null;
  }

  /** The list as it is shown. */
  private get state() {
    return this.list.shown;
  }

  connectedCallback() {
    this.renderShell();
    if (!this.listEl) return;

    this.renderCurrentState();
    this.list.connect(this._repository, this.listId);

    const listEl = this.listEl;
    if (!this.dragCoordinator) {
      this.dragCoordinator = new DraggableBehavior(listEl, {
        handleClass: "handle",
        animator: new FlipAnimator(),
        // The drag moves the task's element, so its new neighbours are there.
        onReorder: (fromIndex, toIndex) => {
          const item = listEl.children[toIndex] ?? null;
          const id = itemIdOf(item);
          if (fromIndex === toIndex || !item || !id) return;
          this.dragMove = {
            id,
            afterId: itemIdOf(item.previousElementSibling),
            beforeId: itemIdOf(item.nextElementSibling),
          };
        },
        onDragStart: (event) => this.handleListDragStart(event),
        onDragEnd: () => this.saveDragMove(),
        onDrop: () => this.saveDragMove(),
      });
      this.dragCoordinator.enable();
    }

    this.ensureInlineEditor();

    this.connection?.abort();
    this.connection = new AbortController();
    const { signal } = this.connection;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options: AddEventListenerOptions = {}
    ) => listEl.addEventListener(type, handler, { ...options, signal });
    on("keydown", (event) => this.handleListKeyDown(event), { capture: true });
    on("click", (event) => this.handleTokenClick(event));
    on("focusin", (event) => this.handleFocusIn(event));
    on("focusout", (event) => this.handleFocusOut(event));
    this.actions.listen(listEl, signal);
    if (this.listIdentifier) {
      this.dataset.listId = this.listIdentifier;
    }
  }

  disconnectedCallback() {
    this.dragCoordinator?.destroy();
    this.dragCoordinator = null;
    this.connection?.abort();
    this.connection = null;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.list.disconnect();
    this.classList.remove("tasklist-no-matches");
    this.actions.reset();
  }

  dispose() {
    this.inlineEditor?.destroy();
    this.inlineEditor = null;
    this.list.disconnect();
  }

  renderShell() {
    if (this.shellRendered) return;
    render(
      html`
        <a4-tasklist-header></a4-tasklist-header>
        <ol class="tasklist"></ol>
        <div class="tasklist-empty" hidden>No matching items</div>
      `,
      this,
      { host: this }
    );
    this.header = this.querySelector("a4-tasklist-header");
    this.header?.setHandlers({
      onRename: (title) => this.rename(title),
      onAddTask: () => this.addTask(),
      onShowDoneChange: (showDone) => this.setShowDone(showDone),
      onDismissError: () => this.list.dismissError(),
    });
    this.listEl = this.querySelector("ol.tasklist");
    this.emptyStateEl = this.querySelector(".tasklist-empty");
    this.shellRendered = true;
    this.renderHeader();
  }

  renderHeader() {
    this.header?.setState({
      title: this.state.title,
      showDone: this.showDone,
      searchMode: this._searchMode,
      error: this.state.headerError ?? null,
    });
  }

  rename(title: string) {
    this.list.change(
      [{ type: "rename", title }],
      this.list.save((repository, listId) => repository.renameList(listId, title))
    );
  }

  /** Saves where a task was dropped, once the drag is over. */
  saveDragMove() {
    const move = this.dragMove;
    this.dragMove = null;
    if (!move || !this.listEl) return;
    // The drag moved the task's element behind lit's back, which confuses its
    // bookkeeping of the list: render the list afresh.
    delete (this.listEl as HTMLOListElement & { _$litPart$?: unknown })._$litPart$;
    this.listEl.textContent = "";
    const { id, afterId, beforeId } = move;
    this.list.change(
      [{ type: "move", id, afterId, beforeId }],
      this.list.save((repository, listId) =>
        repository.moveTaskWithinList(listId, id, {
          afterId: afterId ?? undefined,
          beforeId: beforeId ?? undefined,
        })
      )
    );
  }

  ensureInlineEditor() {
    if (this.inlineEditor || !this.listEl) {
      return this.inlineEditor;
    }
    this.inlineEditor = new InlineTextEditor(this.listEl, {
      onCommit: (payload) => this.handleEditCommit(payload),
      onInput: (payload) => this.handleInlineInput(payload),
      onSplit: (payload) => this.handleEditSplit(payload),
      onMerge: (payload) => this.handleEditMerge(payload),
      onRemove: (payload) => this.handleEditRemove(payload),
      onMove: (payload) => this.handleEditMove(payload),
    });
    return this.inlineEditor;
  }

  setShowDone(value: boolean) {
    if (this.showDone === value) return;
    this.showDone = value;
    this.renderHeader();
    this.renderCurrentState();
    this.emit("showdonechange", { showDone: this.showDone });
  }

  clearSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.searchQuery = "";
    this.renderHeader();
    this.renderCurrentState();
    this.emit("clearsearch");
  }

  /** Inserts an empty task at the top of the list and starts editing it. */
  addTask() {
    this.ensureInlineEditor();
    this.clearSearch();
    const firstItem = this.firstItemId();
    const newId = generateItemId();
    this.editNext(newId, "end");
    this.list.change(
      [
        {
          type: "insert",
          item: { id: newId, text: "", done: false, note: "" },
          afterId: null,
          beforeId: firstItem,
        },
      ],
      this.list.save((repository, listId) =>
        repository.insertTask(listId, {
          itemId: newId,
          text: "",
          done: false,
          beforeId: firstItem ?? undefined,
        })
      )
    );
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
    const id = taskIdOf(element);
    if (!id) return;

    const state = this.state;
    const currentIndex = state.items.findIndex((item) => item.id === id);
    if (currentIndex === -1) return;
    const nextItemId = state.items[currentIndex + 1]?.id ?? null;

    const newId = generateItemId();
    this.editNext(newId, "start");
    this.list.change(
      [
        { type: "update", id, fields: { text: beforeText } },
        {
          type: "insert",
          item: { id: newId, text: afterText, done: false, note: "" },
          afterId: id,
          beforeId: nextItemId,
        },
      ],
      this.list.save((repository, listId) =>
        repository.splitTask(listId, id, {
          beforeText,
          afterText,
          previousText: `${beforeText}${afterText}`,
          newItemId: newId,
          afterId: id,
          beforeId: nextItemId ?? undefined,
        })
      )
    );
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

    const items = this.state.items;
    const currentIndex = items.findIndex((item) => item.id === currentItemId);
    if (currentIndex <= 0) return false;

    const previousItem = items[currentIndex - 1];
    if (previousItem.id !== previousItemId) return false;

    const mergedText = previousItem.text + currentText;
    // The cursor goes where the merged task's text starts, or further in.
    const mergeOffset =
      previousItem.text.length +
      (typeof selectionStart === "number"
        ? Math.max(0, Math.min(selectionStart, currentText.length))
        : 0);

    this.editNext(previousItem.id, makeOffsetCaret(mergeOffset));
    this.list.change(
      [
        { type: "update", id: previousItem.id, fields: { text: mergedText } },
        { type: "remove", id: currentItemId },
      ],
      this.list.save((repository, listId) =>
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
    const li = element?.closest("li") ?? null;
    const id = itemIdOf(li);
    if (!li || !id) return;

    // Continue editing a task the user can see: never one hidden by "Show
    // done" or the search. Backspace in an empty task moves up, like deleting
    // an empty line in a text editor; the delete shortcut prefers the next one.
    const above = visibleSiblingTask(li, "up");
    const below = visibleSiblingTask(li, "down");
    const focusTarget =
      reason === "empty-backspace" ? above ?? below : below ?? above;
    this.editNext(itemIdOf(focusTarget), "end");

    this.actions.close(id);

    this.list.change(
      [{ type: "remove", id }],
      this.list.save((repository, listId) => repository.removeTask(listId, id))
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
    const id = taskIdOf(element);
    if (!id) return;

    const items = this.state.items;
    const fromIndex = items.findIndex((item) => item.id === id);
    if (fromIndex === -1) return;

    const visibleItems = items.filter((item) => this.isShown(item));
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
    this.list.change(
      [{ type: "move", id, afterId, beforeId }],
      this.list.save((repository, listId) =>
        repository.moveTaskWithinList(listId, id, {
          afterId: afterId ?? undefined,
          beforeId: beforeId ?? undefined,
        })
      )
    );
  }

  /**
   * Edits a task once it is rendered: after the next render, or on the next
   * frame if nothing renders. Until then it shows, as the task being edited
   * does. Without a task, nothing is edited next.
   */
  editNext(itemId: string | null, caret: CaretPreference) {
    this.nextEdit = itemId ? { itemId, caret } : null;
    if (itemId) requestAnimationFrame(() => this.applyNextEdit());
  }

  /** Edits the task asked for next, if it is rendered. */
  applyNextEdit() {
    return this.nextEdit ? this.editTask(this.nextEdit.itemId, this.nextEdit.caret) : false;
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

  /** Edits a task now, the cursor where asked, if it is rendered. */
  editTask(itemId: string, caret: CaretPreference) {
    const inlineEditor = this.ensureInlineEditor();
    const textEl = this.itemElement(itemId)?.querySelector<HTMLElement>(".text");
    if (!inlineEditor || !textEl) return false;
    this.nextEdit = null;
    if (inlineEditor.editingEl === textEl) {
      textEl.focus();
      inlineEditor.applyCaretPreference(textEl, caret);
    } else {
      inlineEditor.startEditing(textEl, null, caret);
    }
    return true;
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
    const isDone = item.done;
    const itemId = item.id;
    const text = item.text;
    const note = item.note ?? "";
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

    this.renderHeader();
    const focus = this.captureFocus();
    const editingId = this.editingItemId();
    const shownCount = this.renderItems(state.items, editingId);
    if (editingId) this.showEditedText(state.items, editingId);
    const startedEdit = this.applyNextEdit();
    this.restoreFocus(focus, { skip: startedEdit || this.nextEdit !== null });
    this.forgetRemovedItems(state.items);
    this.updateOpenNotes();
    this.renderEmptyState(shownCount);
    this.reportChanges(state, shownCount);
  }

  /** Renders the tasks as the search and "Show done" have them; returns how many show. */
  renderItems(items: TaskItem[], editingId: string | null) {
    const tokens = tokenizeSearchQuery(this.searchQuery);
    const nextEditId = this.nextEdit?.itemId ?? null;
    let shownCount = 0;
    const itemsTemplate = repeat(
      items,
      (item) => item.id,
      (item) => {
        const isEditing = editingId === item.id;
        // A task being edited, or about to be, shows plainly.
        const view =
          isEditing || item.id === nextEditId
            ? { hidden: false, markup: null, noteMarkup: null, noteMatched: false }
            : evaluateSearchEntry({
                originalText: item.text,
                noteText: item.note ?? "",
                tokens,
                patternConfig: TASK_PATTERNS,
                showDone: this.showDone,
                isDone: item.done,
              });
        if (!view.hidden) shownCount += 1;
        return this.renderItemTemplate(item, {
          ...view,
          isOpen: this.actions.openItemId === item.id,
          isEditing,
        });
      }
    );
    const renderItems = () => render(html`${itemsTemplate}`, this.listEl!, { host: this });
    if (this.inlineEditor) this.inlineEditor.keepEditingThrough(renderItems);
    else renderItems();
    this.dragCoordinator?.invalidateItemsCache();
    return shownCount;
  }

  /** Shows text another device saved in the task being edited. */
  showEditedText(items: TaskItem[], editingId: string) {
    const item = items.find((entry) => entry.id === editingId);
    if (item && this.inlineEditor?.editingEl) this.inlineEditor.replaceText(item.text ?? "");
  }

  /** Closes the actions and notes of tasks that are gone. */
  forgetRemovedItems(items: TaskItem[]) {
    const ids = new Set(items.map((item) => item.id));
    const openActions = this.actions.openItemId;
    if (openActions && !ids.has(openActions)) this.actions.close();
    for (const id of this.openNoteItemIds) {
      if (!ids.has(id)) this.openNoteItemIds.delete(id);
    }
  }

  /** Updates the scroll shadows of open notes, and focuses a note that was asked for. */
  updateOpenNotes() {
    for (const itemId of this.openNoteItemIds) {
      const noteInput = this.noteInput(itemId);
      if (noteInput) this.updateNoteScrollState(noteInput);
    }
    if (!this.pendingNoteFocusId) return;
    const target = this.noteInput(this.pendingNoteFocusId);
    this.pendingNoteFocusId = null;
    if (!target) return;
    target.focus();
    const end = target.value.length;
    target.setSelectionRange(end, end);
    this.updateNoteScrollState(target);
  }

  /** Says so when a search matches none of the tasks. */
  renderEmptyState(shownCount: number) {
    const noMatches = this.searchQuery.trim().length > 0 && shownCount === 0;
    if (this.emptyStateEl) this.emptyStateEl.hidden = !noMatches;
    this.classList.toggle("tasklist-no-matches", noMatches);
  }

  /** Tells the app about changes to the list's title and counts. */
  reportChanges(state: TaskListState, shownCount: number) {
    // Tests find a list by its title.
    if (this.getAttribute("name") !== state.title) {
      if (state.title) this.setAttribute("name", state.title);
      else this.removeAttribute("name");
    }
    // Until the list's state is known, there is nothing to tell.
    if (!this.list.savedState) return;
    this.emitChange("itemcountchange", { total: this.getTotalItemCount() });
    this.emitChange("titlechange", { title: state.title });
    this.emitChange("searchresultschange", { matches: shownCount, query: this.searchQuery });
  }

  handleToggle(e: Event) {
    const target = e.target as HTMLElement | null;
    if (!target?.classList?.contains("done-toggle")) return;
    const id = taskIdOf(target);
    if (!id) return;
    const nextDone = Boolean((target as HTMLInputElement).checked);
    // Request the change right away so it is queued in the order of the
    // user's actions: an undo pressed right after must find it.
    const saved = this.list.save((repository, listId) =>
      repository.toggleTask(listId, id, nextDone)
    );
    // Show it once click events settle, as the list then rerenders and hides
    // completed items.
    setTimeout(() => {
      this.list.change([{ type: "update", id, fields: { done: nextDone } }], saved);
    }, 0);
  }

  handleMoveButtonClick(event: Event) {
    const itemId = taskIdOf(event.currentTarget);
    if (!itemId) return;
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    this.emit("task-move-request", {
      itemId,
      item: snapshot,
      sourceListId: this.listId,
      trigger: "button",
    });
    if (this.actions.close(itemId)) this.renderCurrentState();
  }

  handleDeleteButtonClick(event: Event) {
    const itemId = taskIdOf(event.currentTarget);
    if (!itemId) return;

    const snapshot = this.getItemSnapshot(itemId);
    const confirmationMessage = snapshot?.text
      ? `Delete "${snapshot.text}"?`
      : "Delete this task?";
    if (!window.confirm(confirmationMessage)) {
      return;
    }

    this.editNext(this.nextShownTaskId(itemId), "end");
    this.actions.close(itemId);
    this.list.change(
      [{ type: "remove", id: itemId }],
      this.list.save((repository, listId) => repository.removeTask(listId, itemId))
    );
  }

  handleActionToggleClick(event: Event) {
    const itemId = taskIdOf(event.currentTarget);
    if (!itemId) return;
    this.actions.toggle(itemId);
  }

  isNoteInputActive(itemId: string) {
    const activeElement = document.activeElement;
    if (!activeElement?.classList?.contains("task-note-input")) return false;
    return taskIdOf(activeElement) === itemId;
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
    const itemId = taskIdOf(target);
    if (!itemId || !target) return;
    this.list.commitNote(itemId, target.value ?? "");
  }

  handleNoteToggleClick(event: Event) {
    const itemId = taskIdOf(event.currentTarget);
    if (!itemId) return;
    const shouldFocus = this.openNoteItemIds.has(itemId) === false;
    this.toggleNoteForItem(itemId, { focus: shouldFocus });
  }

  handleNoteInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement | null;
    const itemId = taskIdOf(target);
    if (!itemId || !target) return;
    this.list.draftNote(itemId, target.value ?? "");
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
    const li = (event.currentTarget as HTMLElement | null)?.closest("li") ?? null;
    const itemId = itemIdOf(li);
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
      this.list.commitNote(itemId, noteInput.value ?? "");
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
      if (this.inlineEditor?.editingEl) {
        this.inlineEditor.finishEditing(this.inlineEditor.editingEl);
      }
      this.editNext(this.nextShownTaskId(itemId), "end");
    }
    setTimeout(() => {
      this.list.change(
        [{ type: "update", id: itemId, fields: { done: nextDone } }],
        this.list.save((repository, listId) => repository.toggleTask(listId, itemId, nextDone))
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
      const noteInput = this.noteInput(itemId);
      if (noteInput) {
        this.list.commitNote(itemId, noteInput.value ?? "");
      }
      this.openNoteItemIds.delete(itemId);
      this.pendingNoteFocusId = null;
      if (restoreEdit) {
        restoreCaret = "end";
      }
    } else {
      const textEl = this.itemElement(itemId)?.querySelector<HTMLElement>(".text");
      if (textEl && this.inlineEditor?.editingEl === textEl) {
        this.inlineEditor.finishEditing(textEl);
      }
      this.openNoteItemIds.add(itemId);
      this.pendingNoteFocusId = focus ? itemId : null;
    }
    if (restoreCaret) this.editNext(itemId, restoreCaret);
    this.renderFromState(this.state);
  }

  handleItemKeyDown(event: KeyboardEvent) {
    if (!event || event.defaultPrevented) return;
    if (event.isComposing) return;
    if (matchesShortcut(event, SHORTCUTS.toggleNote)) {
      const target = event.target as HTMLElement | null;
      if (target?.classList.contains("task-note-input")) return;
      const itemId = taskIdOf(target);
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
      const isEnd = matchesShortcut(event, SHORTCUTS.jumpToListEnd);
      const shown = (item: TaskItem) => this.isShown(item);
      const targetItem = isEnd
        ? this.state.items.slice().reverse().find(shown)
        : this.state.items.find(shown);
      if (!targetItem) return;
      event.preventDefault();
      this.editTask(targetItem.id, isEnd ? "end" : "start");
      return;
    }
    if (matchesShortcut(event, SHORTCUTS.toggleDone)) {
      const itemId = taskIdOf(event.target);
      if (!itemId) return;
      event.preventDefault();
      this.toggleItemDone(itemId);
      return;
    }
    if (!matchesShortcut(event, SHORTCUTS.moveTask)) return;
    const itemId = taskIdOf(event.target);
    if (!itemId) return;
    const snapshot = this.getItemSnapshot(itemId);
    if (!snapshot) return;
    event.preventDefault();
    this.emit("task-move-request", {
      itemId,
      item: snapshot,
      sourceListId: this.listId,
      trigger: "shortcut",
    });
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
    const itemId = taskIdOf(element);
    if (!itemId) return;
    const newText = text ?? "";
    const stateItem = this.state.items.find((item) => item.id === itemId);
    if (!stateItem) return;
    if (stateItem.text === newText) return;
    this.list.change(
      [{ type: "update", id: itemId, fields: { text: newText } }],
      this.list.save((repository, listId) => repository.updateTask(listId, itemId, { text: newText }))
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
    this.emit("tokensearch", { token });
  }

  handleListKeyDown(event: KeyboardEvent) {
    if (!this._repository) return;
    if (!event || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    const isEditing = Boolean(target?.closest?.("[contenteditable='true']"));
    if (!isEditing) return;
    if (matchesShortcut(event, SHORTCUTS.toggleDone)) {
      const itemId = taskIdOf(target);
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
    const li = (event.target as HTMLElement | null)?.closest("li") ?? null;
    const itemId = itemIdOf(li);
    if (!li || !itemId) return;
    if (this.focusedItemId && this.focusedItemId !== itemId) {
      this.itemElement(this.focusedItemId)?.classList.remove("is-focused");
    }
    this.focusedItemId = itemId;
    li.classList.add("is-focused");
  }

  handleFocusOut(event: FocusEvent) {
    const li = (event.target as HTMLElement | null)?.closest("li");
    if (!li) return;
    const related = event.relatedTarget as HTMLElement | null;
    if (related && li.contains(related)) return;
    const itemId = itemIdOf(li);
    if (itemId && this.focusedItemId === itemId) {
      this.focusedItemId = null;
    }
    li.classList.remove("is-focused");
  }

  handleListDragStart(event: DragEvent) {
    const itemId = taskIdOf(event.target);
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

  /**
   * Editing ended: saves the text if it is not saved yet. Either way the list
   * renders again, as the search and "Show done" did not hide the task while
   * it was edited.
   */
  handleEditCommit({
    element,
    newText,
    previousText,
  }: {
    element: HTMLElement;
    newText: string;
    previousText: string;
  }) {
    const id = taskIdOf(element);
    const item = this.state.items.find((entry) => entry.id === id);
    if (!id || !item || newText === previousText || item.text === newText) {
      this.scheduleSearchRender(0);
      return;
    }
    this.list.change(
      [{ type: "update", id, fields: { text: newText } }],
      this.list.save((repository, listId) => repository.updateTask(listId, id, { text: newText }))
    );
  }

  applyFilter(query: string) {
    const value = typeof query === "string" ? query : "";
    this.searchQuery = value;
    if (!this.listEl) {
      this.renderShell();
    }
    this.renderHeader();
    this.renderCurrentState();
  }

  editingItemId() {
    return taskIdOf(this.inlineEditor?.editingEl ?? null);
  }

  /** The list item of a task, if it is rendered. */
  itemElement(itemId: string) {
    return (
      this.listEl?.querySelector<HTMLLIElement>(
        `li[data-item-id="${escapeSelectorId(itemId)}"]`
      ) ?? null
    );
  }

  noteInput(itemId: string) {
    return this.itemElement(itemId)?.querySelector<HTMLTextAreaElement>(".task-note-input") ?? null;
  }

  /** Tells the app about something that happened: an event that bubbles out. */
  emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /** Emits an event about a change, unless it reports what it did last time. */
  emitChange(name: string, detail: Record<string, unknown>) {
    const key = JSON.stringify(detail);
    if (this.reported.get(name) === key) return;
    this.reported.set(name, key);
    this.emit(name, detail);
  }

  getItemSnapshot(itemId: string) {
    const found = this.state.items.find((item) => item.id === itemId);
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
    this.list.change([{ type: "remove", id: itemId }], saved);
    return true;
  }

  /** Adds a task that moves here from another list, until `saved` settles. */
  prependItem(item: TaskItem, saved: Promise<unknown> | null) {
    if (!item || !item.id) return false;
    const first = this.firstItemId();
    this.list.change(
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
    const textEl = this.itemElement(itemId)?.querySelector<HTMLElement>(".text");
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
    return this.state.items.filter((item) => !item.done).length;
  }

  getSearchMatchCountForQuery(query: string) {
    const tokens = tokenizeSearchQuery(query);
    return this.state.items.filter((item) => this.matchesSearch(item, tokens)).length;
  }

  /**
   * Whether a task shows: the task being edited always does, also when it
   * no longer matches, as when another device ticked it off.
   */
  isShown(item: TaskItem) {
    return (
      item.id === this.editingItemId() ||
      this.matchesSearch(item, tokenizeSearchQuery(this.searchQuery))
    );
  }

  /** The task to continue with when a task goes away: the next shown one below, or else above. */
  nextShownTaskId(itemId: string) {
    const items = this.state.items;
    const index = items.findIndex((item) => item.id === itemId);
    if (index === -1) return null;
    const shown = (item: TaskItem) => this.isShown(item);
    const next = items.slice(index + 1).find(shown) ?? items.slice(0, index).reverse().find(shown);
    return next?.id ?? null;
  }

  /** Whether a task matches a search, and is not done or done tasks show. */
  matchesSearch(item: TaskItem, tokens: string[]) {
    return matchesSearchEntry({
      originalText: item.text,
      noteText: item.note ?? "",
      tokens,
      showDone: this.showDone,
      isDone: item.done,
    });
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
    const itemId = taskIdOf(activeElement);
    if (!itemId) return null;
    const role: "toggle" | "text" | "note" | null =
      activeElement.classList.contains("done-toggle")
        ? "toggle"
        : activeElement.classList.contains("text")
        ? "text"
        : activeElement.classList.contains("task-note-input")
        ? "note"
        : null;
    return role ? { itemId, role } : null;
  }

  /**
   * Restore focus to a previously captured focus state.
   */
  restoreFocus(
    preservedFocus: { itemId: string; role: "toggle" | "text" | "note" } | null,
    { skip }: { skip?: boolean } = {}
  ) {
    if (skip || !preservedFocus) return;
    const targetLi = this.itemElement(preservedFocus.itemId);
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
      this.list.connect(this._repository, this.listId);
      return;
    }
    this.listIdentifier = String(value);
    this.dataset.listId = this.listIdentifier;
    this.list.connect(this._repository, this.listId);
  }

  get listRepository() {
    return this._repository;
  }

  set listRepository(value) {
    if (this._repository === value) return;
    this._repository = value ?? null;
    this.list.connect(this._repository, this.listId);
  }

  get searchMode() {
    return this._searchMode;
  }

  set searchMode(value) {
    const next = Boolean(value);
    if (next === this._searchMode) return;
    this._searchMode = next;
    if (this.shellRendered) {
      this.renderHeader();
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
