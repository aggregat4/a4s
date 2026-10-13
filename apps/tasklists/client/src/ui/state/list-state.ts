import type { ListRepository } from "../../app/list-repository.js";
import type { ListId, TaskListState } from "../../types/domain.js";
import { cloneListState, normalizeHeaderError } from "./list-store.js";
import { applyChange } from "./pending-changes.js";
import type { PendingChange } from "./pending-changes.js";
import { PendingState } from "./pending-state.js";

type Request = (repository: ListRepository, listId: ListId) => Promise<unknown>;

const SAVE_FAILED = "Sync failed. Please check your connection and retry.";

/**
 * A list as the user sees it: the repository's latest state of the list,
 * with the user's changes it has not saved yet applied on top (see
 * `PendingState`), and the notes being typed.
 */
export class ListState {
  /** The list as the user sees it, with why the last save failed. */
  shown: TaskListState;
  private state: PendingState<TaskListState, PendingChange>;
  /** Notes being typed, which are saved when the note loses focus. */
  private noteDrafts: Map<string, string>;
  private repository: ListRepository | null;
  private listId: ListId | null;
  private unsubscribe: (() => void) | null;
  /** Called whenever what is shown changes. */
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.state = new PendingState({
      empty: () => ({ title: "", items: [] }),
      apply: applyChange,
      read: () =>
        this.repository && this.listId
          ? cloneListState(this.repository.getListState(this.listId))
          : null,
      onChange: () => this.update(),
    });
    this.noteDrafts = new Map();
    this.repository = null;
    this.listId = null;
    this.unsubscribe = null;
    this.onChange = onChange;
    this.shown = this.compute();
  }

  /** The list as the repository last reported it, if it did. */
  get savedState() {
    return this.state.savedState;
  }

  /** Takes the repository's state of the list. */
  setSaved(state: TaskListState) {
    this.state.setSaved(cloneListState(state));
  }

  /** Follows a list in a repository, or nothing when either is missing. */
  connect(repository: ListRepository | null, listId: ListId | null) {
    this.disconnect();
    this.repository = repository;
    this.listId = listId;
    if (!repository || !listId) return;
    if (!repository.isInitialized()) {
      void repository.initialize().then(() => {
        if (this.repository === repository && this.listId === listId) {
          this.connect(repository, listId);
        }
      });
      return;
    }
    this.setSaved(repository.getListState(listId));
    this.unsubscribe = repository.subscribeList(listId, (state) => this.setSaved(state), {
      emitCurrent: false,
    });
  }

  disconnect() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Asks the repository for a change to the list, if there is one. */
  save(request: Request) {
    return this.repository && this.listId ? request(this.repository, this.listId) : null;
  }

  /**
   * Shows a change of the user right away, on top of the repository's state
   * until `saved` settles. Without a repository the change is final.
   */
  change(changes: PendingChange[], saved: Promise<unknown> | null) {
    this.state.change(changes, saved);
  }

  /** A note being typed: shown, but saved only when committed. */
  draftNote(itemId: string, note: string) {
    this.noteDrafts.set(itemId, note);
    this.shown = this.compute();
  }

  /** Saves a note that was typed, if it changed. */
  commitNote(itemId: string, note: string) {
    this.noteDrafts.delete(itemId);
    const item = this.state.shown().items.find((entry) => entry.id === itemId);
    if (!item || (item.note ?? "") === note) return;
    this.change(
      [{ type: "update", id: itemId, fields: { note } }],
      this.save((repository, listId) => repository.updateTask(listId, itemId, { note }))
    );
  }

  dismissError() {
    this.state.dismissFailure();
  }

  private compute(): TaskListState {
    const drafts: PendingChange[] = [...this.noteDrafts].map(([id, note]) => ({
      type: "update",
      id,
      fields: { note },
    }));
    const failure = this.state.failure;
    return {
      ...this.state.shown(drafts),
      headerError: failure ? normalizeHeaderError({ message: failure.message || SAVE_FAILED }) : null,
    };
  }

  private update() {
    this.shown = this.compute();
    this.onChange();
  }
}
