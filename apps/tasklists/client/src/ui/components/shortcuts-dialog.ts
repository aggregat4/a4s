import { html, render } from "lit";
import { SHORTCUTS, formatShortcutParts } from "../state/shortcuts.js";

type ShortcutEntry = (typeof SHORTCUTS)[keyof typeof SHORTCUTS];

type ShortcutGroup = {
  category: string;
  items: ShortcutEntry[];
};

const groupShortcutsByCategory = (shortcuts: ShortcutEntry[]): ShortcutGroup[] => {
  const groups: ShortcutGroup[] = [];
  const indexByCategory = new Map<string, number>();
  for (const shortcut of shortcuts) {
    const category = shortcut.category ?? "Other";
    let index = indexByCategory.get(category);
    if (index === undefined) {
      index = groups.length;
      indexByCategory.set(category, index);
      groups.push({ category, items: [] });
    }
    groups[index].items.push(shortcut);
  }
  return groups;
};

class ShortcutsDialog extends HTMLElement {
  private closeButton: HTMLButtonElement | null;
  private isOpen: boolean;
  private restoreFocus: (() => void) | null;
  private shellRendered: boolean;

  constructor() {
    super();
    this.closeButton = null;
    this.isOpen = false;
    this.restoreFocus = null;
    this.shellRendered = false;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleBackdropClick = this.handleBackdropClick.bind(this);
  }

  connectedCallback() {
    this.renderShell();
    this.cacheElements();
  }

  disconnectedCallback() {
    // no-op; event listeners are bound via the template
  }

  renderShell() {
    this.classList.add("shortcuts-dialog");
    if (!this.dataset.role) {
      this.dataset.role = "shortcuts-dialog";
    }
    if (!this.hasAttribute("hidden")) {
      this.hidden = true;
    }
    this.setAttribute("aria-hidden", this.hidden ? "true" : "false");
    if (this.shellRendered) {
      return;
    }
    const hasExistingStructure =
      this.querySelector("[data-role='shortcuts-dialog-close']") !== null;
    if (hasExistingStructure) {
      this.shellRendered = true;
      return;
    }
    const groups = groupShortcutsByCategory(Object.values(SHORTCUTS));
    render(
      html`
        <div
          class="shortcuts-dialog-backdrop"
          data-role="shortcuts-dialog-backdrop"
          @click=${this.handleBackdropClick}
        ></div>
        <div
          class="shortcuts-dialog-content"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-dialog-title"
          tabindex="-1"
          @keydown=${this.handleKeyDown}
        >
          <div class="shortcuts-dialog-header">
            <h2 id="shortcuts-dialog-title" class="shortcuts-dialog-title">
              Keyboard shortcuts
            </h2>
            <button
              type="button"
              class="shortcuts-dialog-close"
              data-role="shortcuts-dialog-close"
              @click=${this.handleClose}
            >
              Close
            </button>
          </div>
          <div class="shortcuts-dialog-body">
            ${groups.map(
              (group) => html`
                <section class="shortcuts-dialog-group">
                  <h3 class="shortcuts-dialog-group-title">${group.category}</h3>
                  <dl class="shortcuts-dialog-list">
                    ${group.items.map(
                      (item) => html`
                        <div class="shortcuts-dialog-row">
                          <dt class="shortcuts-dialog-keys">
                            ${formatShortcutParts(item).map(
                              (part) =>
                                html`<kbd class="shortcuts-dialog-key"
                                  >${part}</kbd
                                >`
                            )}
                          </dt>
                          <dd class="shortcuts-dialog-desc">
                            ${item.description}
                          </dd>
                        </div>
                      `
                    )}
                  </dl>
                </section>
              `
            )}
          </div>
          <p class="shortcuts-dialog-hint">
            Press
            ${formatShortcutParts(SHORTCUTS.help).map(
              (part) => html`<kbd class="shortcuts-dialog-key">${part}</kbd>`
            )}
            or <kbd class="shortcuts-dialog-key">Esc</kbd> to close.
          </p>
        </div>
      `,
      this
    );
    this.shellRendered = true;
    this.cacheElements();
  }

  cacheElements() {
    this.closeButton =
      this.querySelector("[data-role='shortcuts-dialog-close']") ?? null;
  }

  open() {
    this.renderShell();
    this.cacheElements();
    // Capture the currently focused element so closing can return to it,
    // including a contenteditable task the user was editing.
    const active = document.activeElement as HTMLElement | null;
    this.restoreFocus =
      active && active !== document.body
        ? () => {
            try {
              active.focus();
            } catch (err) {
              // ignore focus errors
            }
          }
        : null;
    this.hidden = false;
    this.setAttribute("aria-hidden", "false");
    this.isOpen = true;
    requestAnimationFrame(() => {
      this.closeButton?.focus();
    });
  }

  close({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    if (!this.isOpen) {
      if (!restoreFocus) {
        this.restoreFocus = null;
      }
      return;
    }
    this.isOpen = false;
    this.hidden = true;
    this.setAttribute("aria-hidden", "true");
    const restore = this.restoreFocus;
    this.restoreFocus = null;
    if (restoreFocus && restore) {
      restore();
    }
  }

  toggle() {
    if (this.isOpen) {
      this.close({ restoreFocus: true });
    } else {
      this.open();
    }
  }

  handleClose() {
    this.close({ restoreFocus: true });
  }

  handleBackdropClick() {
    this.handleClose();
  }

  handleKeyDown(event: KeyboardEvent) {
    if (!this.isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.handleClose();
      return;
    }
    if (event.key === "Tab") {
      // The dialog has a single focusable control; keep focus trapped inside.
      event.preventDefault();
      this.closeButton?.focus();
    }
  }
}

customElements.define("a4-shortcuts-dialog", ShortcutsDialog);
