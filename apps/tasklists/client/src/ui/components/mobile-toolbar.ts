import { html, render } from "lit";
import { live } from "lit/directives/live.js";
import type { HistoryAvailability } from "../../app/history-manager.js";
import { redoIcon, undoIcon } from "./history-icons.js";

type ToolbarState = HistoryAvailability & {
  showDone: boolean;
  searchMode: boolean;
};

type ToolbarHandlers = Partial<{
  onUndo: () => void;
  onRedo: () => void;
  onShowDoneChange: (showDone: boolean) => void;
  onAddTask: () => void;
}>;

/**
 * Bottom toolbar for narrow screens: undo, redo, "Show done" and "Add" for the
 * active list, within reach of the thumb. In search mode only undo and redo
 * remain, as the matching lists keep their own "Show done" in their headers. It is hidden on wider screens, where
 * the sidebar and the list header hold these controls. It is fixed to the
 * bottom of the viewport and shows a shadow while page content continues below
 * it.
 */
class MobileToolbarElement extends HTMLElement {
  private state: ToolbarState;
  private handlers: ToolbarHandlers;
  private resizeObserver: ResizeObserver | null;
  private updateContentBelow: () => void;

  constructor() {
    super();
    this.state = {
      canUndo: false,
      canRedo: false,
      showDone: false,
      searchMode: false,
    };
    this.handlers = {};
    this.resizeObserver = null;
    this.updateContentBelow = this.onLayoutChange.bind(this);
  }

  connectedCallback() {
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "List actions");
    if (!this.dataset.role) {
      this.dataset.role = "mobile-toolbar";
    }
    window.addEventListener("scroll", this.updateContentBelow, { passive: true });
    window.addEventListener("resize", this.updateContentBelow);
    // Content height changes (tasks added, lists switched) without scrolling.
    this.resizeObserver = new ResizeObserver(this.updateContentBelow);
    this.resizeObserver.observe(document.body);
    this.renderView();
    this.onLayoutChange();
  }

  disconnectedCallback() {
    window.removeEventListener("scroll", this.updateContentBelow);
    window.removeEventListener("resize", this.updateContentBelow);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  setHandlers(handlers: ToolbarHandlers) {
    this.handlers = handlers ?? {};
  }

  setState(next: Partial<ToolbarState>) {
    const merged = { ...this.state, ...next };
    if (
      merged.canUndo === this.state.canUndo &&
      merged.canRedo === this.state.canRedo &&
      merged.showDone === this.state.showDone &&
      merged.searchMode === this.state.searchMode
    ) {
      return;
    }
    this.state = merged;
    this.renderView();
  }

  private onLayoutChange() {
    const root = document.documentElement;
    const contentBelow =
      window.scrollY + window.innerHeight < root.scrollHeight - 1;
    this.classList.toggle("has-content-below", contentBelow);
  }

  private renderView() {
    const { canUndo, canRedo, showDone, searchMode } = this.state;
    render(
      html`
        <button
          type="button"
          class="icon-button"
          aria-label="Undo"
          ?disabled=${!canUndo}
          @click=${() => this.handlers.onUndo?.()}
        >
          ${undoIcon}
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="Redo"
          ?disabled=${!canRedo}
          @click=${() => this.handlers.onRedo?.()}
        >
          ${redoIcon}
        </button>
        <label class="mobile-toolbar-show-done" ?hidden=${searchMode}>
          <span>Show done</span>
          <input
            type="checkbox"
            class="switch"
            role="switch"
            .checked=${live(showDone)}
            @change=${(event: Event) =>
              this.handlers.onShowDoneChange?.(
                (event.target as HTMLInputElement).checked
              )}
          />
        </label>
        <button
          type="button"
          class="primary iconlabel mobile-toolbar-add"
          aria-label="Add task"
          ?hidden=${searchMode}
          @click=${() => this.handlers.onAddTask?.()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M7 1h2v6h6v2H9v6H7V9H1V7h6z"></path>
          </svg>
          <span>Add</span>
        </button>
      `,
      this
    );
  }
}

customElements.define("a4-mobile-toolbar", MobileToolbarElement);

export type { ToolbarHandlers, ToolbarState };
