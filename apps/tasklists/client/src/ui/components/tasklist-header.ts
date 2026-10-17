import { html, render } from "lit";
import { live } from "lit/directives/live.js";
import { flattenToPlainText, handlePlainTextPaste } from "../../shared/plain-text-input.js";
import { listsPanel, searchRow } from "../state/lists-panel.js";
import { listsSwitcher, searchToggle } from "./lists-switcher.js";
import "./sync-status.js";

type HeaderState = {
  title: string;
  showDone: boolean;
  searchMode: boolean;
  /** Why the last save failed. */
  error: { message: string } | null;
};

type HeaderHandlers = Partial<{
  /** The title changes: as it is typed, and back when editing is cancelled. */
  onRename: (title: string) => void;
  onAddTask: () => void;
  onShowDoneChange: (showDone: boolean) => void;
  onDismissError: () => void;
}>;

/**
 * The header of a task list: its title, renamed in place, "Add", "Show done",
 * whether changes reach the server, and why the last save failed. In search
 * mode the title is a read-only label and "Add" is hidden; "Show done" stays,
 * so matching done tasks can be shown.
 *
 * On narrow screens the title is the switcher that opens the lists, so it is
 * renamed with the pencil button only, and a search button follows it.
 */
class TaskListHeaderElement extends HTMLElement {
  private state: HeaderState;
  private handlers: HeaderHandlers;
  /** The title when editing started, restored on Escape; null when not editing. */
  private titleBeforeEdit: string | null;
  private unsubscribers: (() => void)[] = [];

  constructor() {
    super();
    this.state = { title: "", showDone: false, searchMode: false, error: null };
    this.handlers = {};
    this.titleBeforeEdit = null;
  }

  connectedCallback() {
    this.classList.add("tasklist-header");
    this.unsubscribers = [
      listsPanel.subscribe(() => this.renderView()),
      searchRow.subscribe(() => this.renderView()),
    ];
    this.renderView();
  }

  disconnectedCallback() {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }

  setHandlers(handlers: HeaderHandlers) {
    this.handlers = handlers ?? {};
  }

  setState(next: Partial<HeaderState>) {
    this.state = { ...this.state, ...next };
    const titleEl = this.titleEl;
    // The title changed elsewhere, as on another device, while it is edited.
    if (this.editing && titleEl && (titleEl.textContent ?? "").trim() !== this.state.title) {
      titleEl.textContent = this.state.title;
      placeCursorAtEnd(titleEl);
    }
    this.renderView();
  }

  private get editing() {
    return this.titleBeforeEdit !== null;
  }

  private get titleEl() {
    return this.querySelector<HTMLElement>(".tasklist-title");
  }

  private startEditing() {
    if (this.editing || this.state.searchMode) return;
    this.titleBeforeEdit = this.state.title;
    this.renderView();
    const titleEl = this.titleEl;
    if (!titleEl) return;
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private stopEditing({ restoreFocus }: { restoreFocus: boolean }) {
    this.titleBeforeEdit = null;
    this.renderView();
    if (restoreFocus) this.titleEl?.focus();
  }

  /** Keeps the edited title; an empty one is not a title, so it cancels. */
  private commit({ restoreFocus = true } = {}) {
    if (!this.editing) return;
    const title = (this.titleEl?.textContent ?? "").trim();
    if (!title.length) {
      this.cancel({ restoreFocus });
      return;
    }
    this.stopEditing({ restoreFocus });
    if (title !== this.state.title) this.handlers.onRename?.(title);
  }

  private cancel({ restoreFocus = true } = {}) {
    const original = this.titleBeforeEdit;
    if (original === null) return;
    this.stopEditing({ restoreFocus });
    if (original !== this.state.title) this.handlers.onRename?.(original);
  }

  /** The title is renamed as it is typed. */
  private handleTitleInput(event: Event) {
    if (!this.editing) return;
    const titleEl = event.target as HTMLElement;
    flattenToPlainText(titleEl);
    const title = (titleEl.textContent ?? "").trim();
    if (title.length && title !== this.state.title) this.handlers.onRename?.(title);
  }

  private handleTitleKeyDown(event: KeyboardEvent) {
    if (this.state.searchMode) return;
    if (this.editing) {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancel();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      this.startEditing();
    }
  }

  private renderView() {
    const { title, showDone, searchMode, error } = this.state;
    const editing = this.editing;
    // While editing, the title element holds what is typed.
    const titleText = editing ? this.titleEl?.textContent ?? title : title;
    const titleTemplate = searchMode
      ? html`
          <div class="tasklist-title-wrapper">
            <h2 class="tasklist-title" .textContent=${titleText}></h2>
          </div>
        `
      : html`
          <div class="tasklist-title-wrapper">
            <h2
              class=${`tasklist-title${editing ? " is-editing" : ""}`}
              tabindex="0"
              contenteditable=${editing ? "true" : null}
              spellcheck=${editing ? "false" : null}
              role=${editing ? "textbox" : null}
              aria-multiline=${editing ? "false" : null}
              aria-label=${editing ? "List title" : "Click to edit list title"}
              title=${editing ? null : "Click to rename"}
              @click=${this.startEditing}
              @input=${this.handleTitleInput}
              @paste=${handlePlainTextPaste}
              @keydown=${this.handleTitleKeyDown}
              @blur=${() => this.commit({ restoreFocus: false })}
              .textContent=${live(titleText)}
            ></h2>
            ${editing
              ? null
              : html`
                  <h2 class="tasklist-switcher-heading">${listsSwitcher(title)}</h2>
                  <button
                    type="button"
                    class="tasklist-rename-button"
                    data-role="rename-list"
                    aria-label="Rename list"
                    title="Rename list"
                    @click=${this.startEditing}
                  ></button>
                  ${searchToggle()}
                `}
            <a4-sync-status class="tasklist-sync-status"></a4-sync-status>
          </div>
        `;
    render(
      html`
        ${error
          ? html`
              <div class="tasklist-header-error" role="alert">
                <span class="tasklist-header-error-message">${error.message}</span>
                <button
                  type="button"
                  class="tasklist-header-error-dismiss"
                  @click=${() => this.handlers.onDismissError?.()}
                >
                  Dismiss
                </button>
              </div>
            `
          : null}
        ${titleTemplate}
        <div class="tasklist-controls">
          ${searchMode
            ? null
            : html`
                <button
                  type="button"
                  class="iconlabel"
                  aria-label="Add task"
                  data-role="tasklist-add"
                  @click=${() => this.handlers.onAddTask?.()}
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
              ?checked=${showDone}
              @change=${(event: Event) =>
                this.handlers.onShowDoneChange?.((event.target as HTMLInputElement).checked)}
            />
          </label>
        </div>
      `,
      this,
      { host: this }
    );
  }
}

function placeCursorAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

customElements.define("a4-tasklist-header", TaskListHeaderElement);

export type { TaskListHeaderElement };
