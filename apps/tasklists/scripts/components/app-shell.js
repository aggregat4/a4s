import { html, render } from "../../vendor/lit-html.js";
import "./sidebar.js";
import "./main-pane.js";
import "./move-dialog.js";

class ListsAppShellElement extends HTMLElement {
  constructor() {
    super();
    this.shellRendered = false;
  }

  connectedCallback() {
    this.classList.add("lists-app");
    if (!this.dataset.role) {
      this.dataset.role = "lists-app";
    }
    this.renderShell();
  }

  renderShell() {
    if (this.shellRendered) {
      return;
    }
    render(
      html`
        <a4-sidebar class="lists-sidebar" data-role="sidebar"></a4-sidebar>
        <a4-main-pane class="lists-main" data-role="main"></a4-main-pane>
        <a4-move-dialog
          class="move-dialog"
          data-role="move-dialog"
          hidden
        ></a4-move-dialog>
      `,
      this
    );
    this.shellRendered = true;
  }
}

customElements.define("a4-lists-app", ListsAppShellElement);
