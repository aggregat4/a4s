import { html, render } from "lit";

/**
 * A4InlineEdit - A simple inline text editing component.
 *
 * Click to edit, Enter to save, Escape to cancel.
 * Single-line text only.
 *
 * @fires edit-start - When editing begins
 * @fires edit-end - When editing ends (regardless of commit/cancel)
 * @fires commit - When changes are committed (Enter or blur)
 *   detail: { value: string, previousValue: string }
 * @fires cancel - When changes are cancelled (Escape)
 *   detail: { previousValue: string }
 * @fires input - On every input event during editing
 *   detail: { value: string }
 */
class A4InlineEditElement extends HTMLElement {
  private _value: string;
  private _editing: boolean;
  private _previousValue: string;
  private _placeholder: string;
  private _label: string;

  static get observedAttributes() {
    return ["value", "placeholder", "label"];
  }

  constructor() {
    super();
    this._value = "";
    this._editing = false;
    this._previousValue = "";
    this._placeholder = "";
    this._label = "";

    this.handleClick = this.handleClick.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleInput = this.handleInput.bind(this);
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = v ?? "";
    if (!this._editing) {
      this.render();
    }
  }

  get editing() {
    return this._editing;
  }

  get placeholder() {
    return this._placeholder;
  }

  set placeholder(v) {
    this._placeholder = v ?? "";
    if (!this._editing) {
      this.render();
    }
  }

  get label() {
    return this._label;
  }

  set label(v) {
    this._label = v ?? "";
    this.render();
  }

  attributeChangedCallback(
    name: string,
    _oldValue: string | null,
    newValue: string | null
  ) {
    switch (name) {
      case "value":
        this.value = newValue ?? "";
        break;
      case "placeholder":
        this._placeholder = newValue ?? "";
        if (!this._editing) {
          this.render();
        }
        break;
      case "label":
        this._label = newValue ?? "";
        this.render();
        break;
    }
  }

  connectedCallback() {
    this.render();
  }

  private handleClick() {
    if (this._editing) return;
    this.startEditing();
  }

  private startEditing() {
    this._editing = true;
    this._previousValue = this._value;

    this.dispatchEvent(
      new CustomEvent("edit-start", {
        bubbles: true,
        composed: true,
      })
    );

    this.render();

    // Focus and select all text
    const element = this.querySelector("[contenteditable='true']") as
      | HTMLElement
      | undefined;
    if (element) {
      element.focus();
      const selection = document.getSelection();
      if (selection && element.firstChild) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  private finishEditing() {
    if (!this._editing) return;
    this._editing = false;

    this.dispatchEvent(
      new CustomEvent("edit-end", {
        bubbles: true,
        composed: true,
      })
    );

    this.render();
  }

  private commit() {
    const element = this.querySelector("[contenteditable='true']") as
      | HTMLElement
      | undefined;
    const newValue = element?.textContent?.trim() ?? "";

    // Update internal value
    this._value = newValue.length ? newValue : this._previousValue;

    this.dispatchEvent(
      new CustomEvent("commit", {
        detail: {
          value: this._value,
          previousValue: this._previousValue,
        },
        bubbles: true,
        composed: true,
      })
    );

    this.finishEditing();
  }

  private cancel() {
    this._value = this._previousValue;

    this.dispatchEvent(
      new CustomEvent("cancel", {
        detail: {
          previousValue: this._previousValue,
        },
        bubbles: true,
        composed: true,
      })
    );

    this.finishEditing();
  }

  private handleBlur() {
    // Commit on blur (same behavior as pressing Enter)
    this.commit();
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.cancel();
    }
  }

  private handleInput() {
    const element = this.querySelector("[contenteditable='true']") as
      | HTMLElement
      | undefined;
    const value = element?.textContent ?? "";

    this.dispatchEvent(
      new CustomEvent("input", {
        detail: { value },
        bubbles: true,
        composed: true,
      })
    );
  }

  private render() {
    if (this._editing) {
      render(
        html`
          <span
            class="inline-edit inline-edit--editing"
            contenteditable="true"
            spellcheck="false"
            role="textbox"
            aria-label=${this._label || "Edit text"}
            @blur=${this.handleBlur}
            @keydown=${this.handleKeyDown}
            @input=${this.handleInput}
          >
            ${this._value}
          </span>
        `,
        this
      );
    } else {
      const displayValue = this._value || this._placeholder;
      const hasValue = !!this._value;

      render(
        html`
          <span
            class="inline-edit inline-edit--display${hasValue
              ? ""
              : " inline-edit--placeholder"}"
            role=${hasValue ? "heading" : "button"}
            aria-label=${this._label ||
            (hasValue ? "Click to edit" : this._placeholder)}
            title=${hasValue ? "Click to rename" : ""}
            @click=${this.handleClick}
          >
            ${displayValue}
          </span>
        `,
        this
      );
    }
  }
}

customElements.define("a4-inline-edit", A4InlineEditElement);
