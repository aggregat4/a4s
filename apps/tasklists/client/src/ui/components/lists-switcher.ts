import { html } from "lit";
import { listsPanel, searchRow } from "../state/lists-panel.js";

/** The id of the sidebar, which the switcher opens on narrow screens. */
export const LISTS_PANEL_ID = "lists-panel";

/** The id of the search row in the sidebar, which the search button opens. */
export const SEARCH_ROW_ID = "search-row";

/**
 * The list title as a button on narrow screens: it opens the sidebar, with
 * the search, the lists and the options, below it. Components rendering it
 * re-render when the panel opens or closes, see `listsPanel.subscribe`.
 */
export function listsSwitcher(label: string) {
  const open = listsPanel.isOpen();
  return html`<button
    type="button"
    class="lists-switcher"
    data-role="lists-switcher"
    aria-expanded=${open ? "true" : "false"}
    aria-controls=${LISTS_PANEL_ID}
    @click=${() => listsPanel.toggle()}
  >
    <span class="lists-switcher-label">${label}</span>
    <svg
      class="lists-switcher-chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  </button>`;
}

/**
 * The search button at the end of the header on narrow screens: it opens the
 * search row under it. Components rendering it re-render when the row opens
 * or closes, see `searchRow.subscribe`.
 */
export function searchToggle() {
  const open = searchRow.isOpen();
  return html`<button
    type="button"
    class="search-toggle"
    data-role="search-toggle"
    aria-label="Search"
    title="Search"
    aria-expanded=${open ? "true" : "false"}
    aria-controls=${SEARCH_ROW_ID}
    @click=${() => searchRow.toggle()}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="7"></circle>
      <path d="m20 20-3.5-3.5"></path>
    </svg>
  </button>`;
}
