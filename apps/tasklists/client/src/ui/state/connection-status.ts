import type { SyncStatus } from "../../types/sync.js";

/**
 * What the status line says. `connected` shows nothing; `offline` means the
 * browser has no network; `unreachable` means it has, but changes are not
 * reaching the sync server.
 */
export type ConnectionState = "connected" | "offline" | "unreachable";

type Listener = (state: ConnectionState) => void;

/** A brief drop shows nothing: losing the connection shows after this delay. */
const SHOW_DELAY_MS = 2000;

/**
 * The connection state shown to the user. Browser connectivity drives it
 * first, as it stays correct even when the sync engine has been torn down on
 * a connection error, refined by the engine's own signal so a server that is
 * unreachable while the browser is online reads as unreachable.
 */
class ConnectionStatus {
  private online = true;
  private syncStatus: SyncStatus | null = null;
  private shown: ConnectionState = "connected";
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;
  private listeners = new Set<Listener>();

  current() {
    return this.shown;
  }

  setSyncStatus(status: SyncStatus) {
    if (status === this.syncStatus) return;
    this.syncStatus = status;
    this.update();
  }

  /** Calls the listener on every change; returns the unsubscribe. */
  subscribe(listener: Listener) {
    this.listen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    this.online = navigator.onLine !== false;
    window.addEventListener("online", () => this.handleOnlineChange());
    window.addEventListener("offline", () => this.handleOnlineChange());
    this.update();
  }

  private handleOnlineChange() {
    const next = navigator.onLine !== false;
    if (next === this.online) return;
    this.online = next;
    // Optimistically clear a stale "disconnected" the moment connectivity
    // returns; a still-unreachable server re-asserts it on the next failed
    // flush.
    if (next) this.syncStatus = "connected";
    this.update();
  }

  private actual(): ConnectionState {
    if (!this.online) return "offline";
    return this.syncStatus === "disconnected" ? "unreachable" : "connected";
  }

  private update() {
    const next = this.actual();
    clearTimeout(this.showTimer ?? undefined);
    this.showTimer = null;
    // Coming back, or changing between two ways of being disconnected, shows
    // at once; only losing the connection waits.
    if (next === "connected" || this.shown !== "connected") {
      this.show(next);
      return;
    }
    this.showTimer = setTimeout(() => this.show(next), SHOW_DELAY_MS);
  }

  private show(state: ConnectionState) {
    if (state === this.shown) return;
    this.shown = state;
    this.listeners.forEach((listener) => listener(state));
  }
}

export const connectionStatus = new ConnectionStatus();
