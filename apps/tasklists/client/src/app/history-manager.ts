import type { HistoryEntry, HistoryScope } from "./history-types.js";

const isListScope = (
  scope: HistoryScope
): scope is { type: "list"; listId: string } => scope.type === "list";

type HistoryAvailability = { canUndo: boolean; canRedo: boolean };

class HistoryManager {
  private undoStack: HistoryEntry[];
  private redoStack: HistoryEntry[];
  private coalesceWindowMs: number;
  private listeners: Set<(state: HistoryAvailability) => void>;
  private lastNotified: HistoryAvailability | null;

  constructor({ windowMs = 1000 }: { windowMs?: number } = {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.coalesceWindowMs = windowMs;
    this.listeners = new Set();
    this.lastNotified = null;
  }

  getAvailability(): HistoryAvailability {
    return { canUndo: this.canUndo(), canRedo: this.canRedo() };
  }

  /** Calls the listener now and whenever undo or redo availability changes. */
  subscribe(listener: (state: HistoryAvailability) => void) {
    this.listeners.add(listener);
    listener(this.getAvailability());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const state = this.getAvailability();
    if (
      this.lastNotified &&
      this.lastNotified.canUndo === state.canUndo &&
      this.lastNotified.canRedo === state.canRedo
    ) {
      return;
    }
    this.lastNotified = state;
    this.listeners.forEach((listener) => listener(state));
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.notify();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  record(entry: HistoryEntry) {
    if (!entry) return;
    if (this.redoStack.length) {
      this.redoStack = [];
    }
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && this.canCoalesce(last, entry)) {
      this.undoStack[this.undoStack.length - 1] = {
        ...last,
        forwardOps: entry.forwardOps,
        label: entry.label ?? last.label,
        actor: entry.actor ?? last.actor,
        timestamp: entry.timestamp,
      };
      this.notify();
      return;
    }
    this.undoStack.push(entry);
    this.notify();
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    this.notify();
    return entry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    this.notify();
    return entry;
  }

  private canCoalesce(previous: HistoryEntry, next: HistoryEntry) {
    if (!next.coalesceKey || !previous.coalesceKey) return false;
    if (next.coalesceKey !== previous.coalesceKey) return false;
    if (!this.isSameScope(previous.scope, next.scope)) return false;
    if (next.timestamp - previous.timestamp > this.coalesceWindowMs) return false;
    return true;
  }

  private isSameScope(a: HistoryScope, b: HistoryScope) {
    if (a.type === "registry" || b.type === "registry") {
      return a.type === b.type;
    }
    if (!isListScope(a) || !isListScope(b)) return false;
    return a.listId === b.listId;
  }
}

export { HistoryManager };
export type { HistoryAvailability };
