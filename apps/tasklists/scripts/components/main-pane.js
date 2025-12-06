import { html, render } from "../../vendor/lit-html.js";

class MainPaneElement extends HTMLElement {
  constructor() {
    super();
    this.shellRendered = false;
  }

  connectedCallback() {
    this.classList.add("lists-main");
    if (!this.dataset.role) {
      this.dataset.role = "main";
    }
    this.renderShell();
  }

  renderShell() {
    if (this.shellRendered) {
      return;
    }
    render(
      html`
        <header class="lists-main-header">
          <h2 class="lists-main-title" data-role="active-list-title"></h2>
        </header>
        <div class="lists-container" data-role="lists-container"></div>
      `,
      this
    );
    this.shellRendered = true;
  }
}

customElements.define("a4-main-pane", MainPaneElement);
