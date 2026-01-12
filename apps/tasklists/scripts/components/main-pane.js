import { html, render } from "../../vendor/lit-html.js";

class MainPaneElement extends HTMLElement {
  constructor() {
    super();
    this.shellRendered = false;
    this.headerEl = null;
    this.titleEl = null;
    this.listContainer = null;
    this.currentTitle = "";
    this.searchMode = false;
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
        <header class="lists-main-header"></header>
        <div class="lists-container" data-role="lists-container"></div>
      `,
      this
    );
    this.headerEl = this.querySelector(".lists-main-header");
    this.listContainer = this.querySelector("[data-role='lists-container']");
    this.renderHeader();
    this.shellRendered = true;
  }

  renderHeader() {
    if (!this.headerEl) return;
    render(
      html`
        <h2 class="lists-main-title" data-role="active-list-title">
          ${this.currentTitle}
        </h2>
      `,
      this.headerEl
    );
    this.titleEl =
      this.headerEl.querySelector("[data-role='active-list-title']") ?? null;
  }

  setTitle(title) {
    const next = typeof title === "string" ? title : "";
    if (next === this.currentTitle) return;
    this.currentTitle = next;
    this.renderHeader();
  }

  setSearchMode(enabled) {
    const next = Boolean(enabled);
    if (next === this.searchMode) return;
    this.searchMode = next;
    this.classList.toggle("search-mode", next);
  }

  getListsContainer() {
    return this.listContainer;
  }
}

customElements.define("a4-main-pane", MainPaneElement);
