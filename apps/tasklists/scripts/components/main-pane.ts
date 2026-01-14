import { html, render } from "../../vendor/lit-html.js";
import type { ListId } from "../../types/domain.js";
import type { ListRepository } from "../../lib/app/list-repository.js";

type ListRecord = {
  id: ListId;
};

class MainPaneElement extends HTMLElement {
  private shellRendered: boolean;
  private headerEl: HTMLElement | null;
  private listContainer: HTMLElement | null;
  private currentTitle: string;
  private searchMode: boolean;
  private currentLists: ListRecord[];
  private activeListId: ListId | null;
  private listRepository: ListRepository | null;

  constructor() {
    super();
    this.shellRendered = false;
    this.headerEl = null;
    this.listContainer = null;
    this.currentTitle = "";
    this.searchMode = false;
    this.currentLists = [];
    this.activeListId = null;
    this.listRepository = null;
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
  }

  setTitle(title: string) {
    const next = typeof title === "string" ? title : "";
    if (next === this.currentTitle) return;
    this.currentTitle = next;
    this.renderHeader();
  }

  setSearchMode(enabled: boolean) {
    const next = Boolean(enabled);
    if (next === this.searchMode) return;
    this.searchMode = next;
    this.classList.toggle("search-mode", next);
  }

  renderLists(
    lists: ListRecord[],
    {
      activeListId,
      searchMode,
      repository,
    }: {
      activeListId?: ListId | null;
      searchMode?: boolean;
      repository?: ListRepository | null;
    } = {}
  ) {
    if (!this.listContainer) {
      this.renderShell();
    }
    if (!this.listContainer) return;
    this.currentLists = Array.isArray(lists) ? lists : [];
    if (activeListId !== undefined) {
      this.activeListId = activeListId ?? null;
    }
    if (searchMode !== undefined) {
      this.setSearchMode(searchMode);
    }
    if (repository !== undefined) {
      this.listRepository = repository ?? null;
    }
    const sections = this.currentLists.map((record) => {
      const listId = record?.id;
      if (!listId) return null;
      const isActive = listId === this.activeListId;
      const isVisible = this.searchMode || isActive;
      const classes = `list-section${isVisible ? " is-visible" : ""}${
        isActive ? " is-active" : ""
      }`;
      return html`
        <section class=${classes} data-list-id=${listId}>
          <a4-tasklist
            .listId=${listId}
            .listRepository=${this.listRepository}
          ></a4-tasklist>
        </section>
      `;
    });
    render(html`${sections}`, this.listContainer);
  }

  getListsContainer() {
    return this.listContainer;
  }
}

customElements.define("a4-main-pane", MainPaneElement);
