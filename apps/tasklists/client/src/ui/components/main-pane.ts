import { html, render } from "lit";
import type { ListId, TaskItem } from "../../types/domain.js";
import type { ListRepository } from "../../app/list-repository.js";
import { listsPanel, searchRow } from "../state/lists-panel.js";
import { listsSwitcher, searchToggle } from "./lists-switcher.js";
import "./sync-status.js";

/** What the app asks of a rendered list. */
export type ListElement = HTMLElement & {
  getTotalItemCount: () => number;
  getSearchMatchCountForQuery?: (query: string) => number;
  applyFilter?: (query: string) => void;
  showDone?: boolean;
  searchQuery?: string;
  focusItem: (id: string) => void;
  getItemSnapshot: (id: string) => TaskItem | null;
  removeItemById: (id: string, saved: Promise<unknown> | null) => boolean;
  prependItem: (item: TaskItem, saved: Promise<unknown> | null) => void;
  addTask?: () => void;
  setShowDone?: (value: boolean) => void;
  cancelActiveDrag?: () => void;
  firstItemId?: () => string | null;
};

type ListRecord = {
  id: ListId;
};

/** How long a list flashes; see `.list-section-flash` in styles.css. */
const FLASH_MS = 800;

class MainPaneElement extends HTMLElement {
  private shellRendered: boolean;
  private headerEl: HTMLElement | null;
  private listContainer: HTMLElement | null;
  private currentTitle: string;
  private searchMode: boolean;
  private currentLists: ListRecord[];
  private activeListId: ListId | null;
  private listRepository: ListRepository | null;
  private flashTimers: WeakMap<HTMLElement, ReturnType<typeof setTimeout>>;

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
    this.flashTimers = new WeakMap();
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
    listsPanel.subscribe(() => this.renderHeader());
    searchRow.subscribe(() => this.renderHeader());
    this.shellRendered = true;
  }

  renderHeader() {
    if (!this.headerEl) return;
    render(
      html`
        <h2 class="lists-main-title" data-role="active-list-title">
          ${this.currentTitle}
        </h2>
        <h2 class="lists-main-switcher-heading">${listsSwitcher(this.currentTitle)}</h2>
        ${searchToggle()}
        <a4-sync-status class="lists-main-sync-status"></a4-sync-status>
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
            .searchMode=${this.searchMode}
          ></a4-tasklist>
        </section>
      `;
    });
    render(html`${sections}`, this.listContainer);
  }

  /** The section showing a list, once rendered. */
  section(listId: ListId) {
    return (
      this.listContainer?.querySelector<HTMLElement>(
        `section[data-list-id="${CSS.escape(listId)}"]`
      ) ?? null
    );
  }

  /** The element showing a list, once rendered. */
  listElement(listId: ListId) {
    return this.section(listId)?.querySelector<ListElement>("a4-tasklist") ?? null;
  }

  /** The rendered lists, in order. */
  listElements() {
    return Array.from(this.listContainer?.querySelectorAll<ListElement>("a4-tasklist") ?? []);
  }

  /** Highlights a list briefly, as when a task moved to it. */
  flashList(listId: ListId) {
    const section = this.section(listId);
    if (!section) return;
    clearTimeout(this.flashTimers.get(section));
    section.classList.remove("list-section-flash");
    // Reading the layout restarts the animation of a list that is still flashing.
    void section.offsetWidth;
    section.classList.add("list-section-flash");
    // A hidden list never ends its animation, so a timer removes the class.
    this.flashTimers.set(
      section,
      setTimeout(() => section.classList.remove("list-section-flash"), FLASH_MS)
    );
  }
}

customElements.define("a4-main-pane", MainPaneElement);
