import { html, render } from "lit";
import type { ListId, TaskItem } from "../../types/domain.js";

type MoveTarget = {
  id: ListId;
  name: string;
  countLabel?: string;
};

type MoveDialogContext = {
  sourceListId: ListId;
  itemId: string;
  task: TaskItem;
  trigger: string;
  targets: MoveTarget[];
  restoreFocus?: (() => void) | null;
  onConfirm?: (payload: MoveDialogContext & { targetListId: ListId }) => void;
  onCancel?: (payload: MoveDialogContext) => void;
};

class KeyboardMoveDialog extends HTMLElement {
  private optionsListEl: HTMLElement | null;
  private cancelButton: HTMLButtonElement | null;
  private optionButtons: HTMLButtonElement[];
  private isOpen: boolean;
  private currentContext: MoveDialogContext | null;
  private shellRendered: boolean;

  constructor() {
    super();
    this.optionsListEl = null;
    this.cancelButton = null;
    this.optionButtons = [];
    this.isOpen = false;
    this.currentContext = null;
    this.shellRendered = false;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleCancel = this.handleCancel.bind(this);
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
    this.handleOptionClick = this.handleOptionClick.bind(this);
  }

  connectedCallback() {
    this.renderShell();
    this.cacheElements();
  }

  disconnectedCallback() {
    // no-op; event listeners are bound via the template
  }

  renderShell() {
    this.classList.add("move-dialog");
    if (!this.dataset.role) {
      this.dataset.role = "move-dialog";
    }
    if (!this.hasAttribute("hidden")) {
      this.hidden = true;
    }
    this.setAttribute("aria-hidden", this.hidden ? "true" : "false");
    if (this.shellRendered) {
      return;
    }
    const hasExistingStructure =
      this.querySelector("[data-role='move-dialog-options']") !== null;
    if (hasExistingStructure) {
      this.shellRendered = true;
      return;
    }
    render(
      html`
        <div
          class="move-dialog__backdrop"
          data-role="move-dialog-backdrop"
          @click=${this.handleBackdropClick}
        ></div>
        <div
          class="move-dialog__content"
          role="dialog"
          aria-modal="true"
          aria-labelledby="move-dialog-title"
          aria-describedby="move-dialog-description"
          tabindex="-1"
          @keydown=${this.handleKeyDown}
        >
          <h2 id="move-dialog-title" class="move-dialog__title">Move Task</h2>
          <p id="move-dialog-description" class="move-dialog__description">
            Select a destination list for this task. Use the arrow keys to
            choose, then press Enter.
          </p>
          <ul class="move-dialog__options" data-role="move-dialog-options"></ul>
          <div class="move-dialog__actions">
            <button
              type="button"
              class="move-dialog__cancel"
              data-role="move-dialog-cancel"
              @click=${this.handleCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      `,
      this
    );
    this.shellRendered = true;
    this.cacheElements();
  }

  cacheElements() {
    this.optionsListEl =
      this.querySelector("[data-role='move-dialog-options']") ?? null;
    this.cancelButton =
      this.querySelector("[data-role='move-dialog-cancel']") ?? null;
  }

  open(options: MoveDialogContext) {
    this.renderShell();
    this.cacheElements();
    if (!this.optionsListEl) return;
    const targets = Array.isArray(options.targets) ? options.targets : [];
    if (!targets.length) return;
    this.close({ restoreFocus: false });
    this.currentContext = { ...options };
    this.renderOptions(targets);
    this.hidden = false;
    this.setAttribute("aria-hidden", "false");
    this.isOpen = true;
    requestAnimationFrame(() => {
      if (this.optionButtons[0]) {
        this.optionButtons[0].focus();
      } else if (this.cancelButton) {
        this.cancelButton.focus();
      }
    });
  }

  renderOptions(targets: MoveTarget[]) {
    if (!this.optionsListEl) {
      this.optionButtons = [];
      return;
    }
    render(
      html`${targets.map(
        (target) => html`
          <li>
            <button
              type="button"
              class="move-dialog__option"
              data-list-id=${target.id}
              @click=${this.handleOptionClick}
            >
              <span class="move-dialog__option-name">${target.name}</span>
              <span class="move-dialog__option-count"
                >${target.countLabel ?? ""}</span
              >
            </button>
          </li>
        `
      )}`,
      this.optionsListEl
    );
    this.optionButtons = Array.from(
      this.optionsListEl.querySelectorAll<HTMLButtonElement>(".move-dialog__option")
    );
  }

  clearOptions() {
    if (!this.optionsListEl) {
      this.optionButtons = [];
      return;
    }
    render(html``, this.optionsListEl);
    this.optionButtons = [];
  }

  close({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    if (!this.isOpen) {
      if (!restoreFocus) {
        this.currentContext = null;
      }
      return;
    }
    this.isOpen = false;
    this.clearOptions();
    this.hidden = true;
    this.setAttribute("aria-hidden", "true");
    const context = this.currentContext;
    this.currentContext = null;
    if (restoreFocus && context?.restoreFocus) {
      try {
        context.restoreFocus();
      } catch (err) {
        // ignore focus errors
      }
    }
  }

  handleOptionClick(event: Event) {
    const button = event.currentTarget as HTMLElement | null;
    const listId = button?.dataset?.listId;
    if (!listId) return;
    const context = this.currentContext;
    if (!context) return;
    this.close({ restoreFocus: false });
    context.onConfirm?.({ ...context, targetListId: listId });
  }

  handleCancel() {
    const context = this.currentContext;
    context?.onCancel?.(context);
    this.close({ restoreFocus: true });
  }

  handleBackdropClick() {
    this.handleCancel();
  }

  handleKeyDown(event: KeyboardEvent) {
    if (!this.isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.handleCancel();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const forward = event.key === "ArrowDown" ? 1 : -1;
      const focusables = this.getFocusableElements();
      if (!focusables.length) return;
      event.preventDefault();
      const currentIndex = focusables.indexOf(
        document.activeElement as HTMLElement | null
      );
      let nextIndex = currentIndex + forward;
      if (nextIndex < 0) nextIndex = focusables.length - 1;
      if (nextIndex >= focusables.length) nextIndex = 0;
      focusables[nextIndex].focus();
      return;
    }
    if (event.key === "Tab") {
      const focusables = this.getFocusableElements();
      if (!focusables.length) return;
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      const currentIndex = focusables.indexOf(
        document.activeElement as HTMLElement | null
      );
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = focusables.length - 1;
      if (nextIndex >= focusables.length) nextIndex = 0;
      focusables[nextIndex].focus();
    }
  }

  getFocusableElements() {
    const focusables: HTMLElement[] = [];
    this.optionButtons.forEach((button) => focusables.push(button));
    if (this.cancelButton) {
      focusables.push(this.cancelButton);
    }
    return focusables;
  }
}

customElements.define("a4-move-dialog", KeyboardMoveDialog);
