import { html, render } from "lit";
import {
  connectionStatus,
  type ConnectionState,
} from "../state/connection-status.js";

const MESSAGES: Record<Exclude<ConnectionState, "connected">, string> = {
  offline: "Offline. Changes are saved on this device.",
  unreachable: "Can’t reach the server. Changes are saved on this device.",
};

const cloudOffIcon = html`<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="m2 2 20 20"></path>
  <path d="M5.8 5.8A7 7 0 0 0 9 19h8.5c.6 0 1.2-.1 1.7-.3"></path>
  <path d="M22 15.5A4.5 4.5 0 0 0 17.5 11h-1.8A7 7 0 0 0 9.4 5.1"></path>
</svg>`;

/**
 * A line under the list title saying that changes are not reaching the
 * server. It is empty while they are: being connected is the normal state.
 * The element stays in the page as a live region, so screen readers hear the
 * change when it appears.
 */
class SyncStatusElement extends HTMLElement {
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    this.classList.add("sync-status");
    this.setAttribute("role", "status");
    this.unsubscribe = connectionStatus.subscribe(() => this.renderView());
    this.renderView();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private renderView() {
    const state = connectionStatus.current();
    this.dataset.state = state;
    render(
      state === "connected"
        ? null
        : html`${cloudOffIcon}<span>${MESSAGES[state]}</span>`,
      this
    );
  }
}

customElements.define("a4-sync-status", SyncStatusElement);
