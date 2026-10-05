import { html } from "lit";

// Curved-arrow icons for the undo and redo buttons in the sidebar and the
// mobile toolbar. They inherit the button's text color.
const undoIcon = html`<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="M9 14 4 9l5-5"></path>
  <path d="M4 9h11a5 5 0 0 1 0 10h-3"></path>
</svg>`;

const redoIcon = html`<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="m15 14 5-5-5-5"></path>
  <path d="M20 9H9a5 5 0 0 0 0 10h3"></path>
</svg>`;

export { undoIcon, redoIcon };
