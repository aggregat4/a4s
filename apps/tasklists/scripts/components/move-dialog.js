import { html, render } from "../../vendor/lit-html.js";

class KeyboardMoveDialog extends HTMLElement {
  constructor() {
    super();
    this.backdropEl = null;
    this.contentEl = null;
    this.optionsListEl = null;
    this.cancelButton = null;
    this.optionButtons = [];
    this.isOpen = false;
    this.currentContext = null;
    this.listenersAttached = false;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleCancel = this.handleCancel.bind(this);
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
    this.handleOptionClick = this.handleOptionClick.bind(this);
  }

  connectedCallback() {
    this.cacheElements();
    this.attachListeners();
  }

  disconnectedCallback() {
    this.detachListeners();
  }

  cacheElements() {
    this.backdropEl =
      this.querySelector("[data-role='move-dialog-backdrop']") ?? null;
    this.contentEl = this.querySelector(".move-dialog__content") ?? null;
    this.optionsListEl =
      this.querySelector("[data-role='move-dialog-options']") ?? null;
    this.cancelButton =
      this.querySelector("[data-role='move-dialog-cancel']") ?? null;
  }

  attachListeners() {
    if (this.listenersAttached) return;
    this.cancelButton?.addEventListener("click", this.handleCancel);
    this.backdropEl?.addEventListener("click", this.handleBackdropClick);
    this.listenersAttached = true;
  }

  detachListeners() {
    this.cancelButton?.removeEventListener("click", this.handleCancel);
    this.backdropEl?.removeEventListener("click", this.handleBackdropClick);
    this.listenersAttached = false;
  }

  open(options = {}) {
    if (!this.optionsListEl) return;
    const targets = Array.isArray(options.targets) ? options.targets : [];
    if (!targets.length) return;
    this.close({ restoreFocus: false });
    this.currentContext = { ...options };
    this.renderOptions(targets);
    this.hidden = false;
    this.setAttribute("aria-hidden", "false");
    this.isOpen = true;
    this.contentEl?.addEventListener("keydown", this.handleKeyDown);
    requestAnimationFrame(() => {
      if (this.optionButtons[0]) {
        this.optionButtons[0].focus();
      } else if (this.cancelButton) {
        this.cancelButton.focus();
      }
    });
  }

  renderOptions(targets) {
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
      this.optionsListEl.querySelectorAll(".move-dialog__option")
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

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) {
      if (!restoreFocus) {
        this.currentContext = null;
      }
      return;
    }
    this.isOpen = false;
    this.contentEl?.removeEventListener("keydown", this.handleKeyDown);
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

  handleOptionClick(event) {
    const button = event.currentTarget;
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

  handleKeyDown(event) {
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
      const currentIndex = focusables.indexOf(document.activeElement);
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
      const currentIndex = focusables.indexOf(document.activeElement);
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = focusables.length - 1;
      if (nextIndex >= focusables.length) nextIndex = 0;
      focusables[nextIndex].focus();
    }
  }

  getFocusableElements() {
    const focusables = [];
    this.optionButtons.forEach((button) => focusables.push(button));
    if (this.cancelButton) {
      focusables.push(this.cancelButton);
    }
    return focusables;
  }
}

customElements.define("a4-move-dialog", KeyboardMoveDialog);

export { KeyboardMoveDialog };
export default KeyboardMoveDialog;
