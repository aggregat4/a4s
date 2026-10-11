import type { ListRepository } from "../../app/list-repository.js";
import type { ListId, TaskListState } from "../../types/domain.js";
import { cloneListState, normalizeHeaderError } from "./list-store.js";
import { applyPendingChanges } from "./pending-changes.js";
import type { PendingChange } from "./pending-changes.js";

type Request = (repository: ListRepository, listId: ListId) => Promise<unknown>;

const SAVE_FAILED = "Sync failed. Please check your connection and retry.";

/**
 * A list as the user sees it: the repository's latest state of the list,
 * with the user's changes it has not saved yet applied on top.
 *
 * The repository saves changes one at a time, and on a slow device it lags
 * behind. Until it has saved a change, its snapshots predate it, so the
 * change stays on top of them; changes from other devices show as soon as
 * they arrive.
 */
export class ListState {
  /** The list as the user sees it, with why the last save failed. */
  shown: TaskListState;
  /** The list as the repository last reported it. */
  private saved: TaskListState | null;
  /** The user's changes the repository has not saved yet, in order. */
  private pending: PendingChange[][];
  /** Notes being typed, which are saved when the note loses focus. */
  private noteDrafts: Map<string, string>;
  private saveError: TaskListState["headerError"];
  private repository: ListRepository | null;
  private listId: ListId | null;
  private unsubscribe: (() => void) | null;
  /** Called whenever what is shown changes. */
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.saved = null;
    this.pending = [];
    this.noteDrafts = new Map();
    this.saveError = null;
    this.repository = null;
    this.listId = null;
    this.unsubscribe = null;
    this.onChange = onChange;
    this.shown = this.compute();
  }

  /** The list as the repository last reported it, if it did. */
  get savedState() {
    return this.saved;
  }

  /** Takes the repository's state of the list. */
  setSaved(state: TaskListState) {
    this.saved = cloneListState(state);
    this.update();
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
    if (!saved) {
      this.saved = applyPendingChanges(this.base(), changes);
      this.update();
      return;
    }
    this.pending.push(changes);
    this.update();
    saved
      .finally(() => {
        this.pending = this.pending.filter((entry) => entry !== changes);
        if (this.repository && this.listId) {
          this.saved = cloneListState(this.repository.getListState(this.listId));
        }
      })
      .then(
        () => this.setSaveError(null),
        (err) => this.setSaveError({ message: err?.message || SAVE_FAILED })
      );
  }

  /** A note being typed: shown, but saved only when committed. */
  draftNote(itemId: string, note: string) {
    this.noteDrafts.set(itemId, note);
    this.shown = this.compute();
  }

  /** Saves a note that was typed, if it changed. */
  commitNote(itemId: string, note: string) {
    this.noteDrafts.delete(itemId);
    const item = applyPendingChanges(this.base(), this.pending.flat()).items.find(
      (entry) => entry.id === itemId
    );
    if (!item || (item.note ?? "") === note) return;
    this.change(
      [{ type: "update", id: itemId, fields: { note } }],
      this.save((repository, listId) => repository.updateTask(listId, itemId, { note }))
    );
  }

  dismissError() {
    this.setSaveError(null);
  }

  private setSaveError(error: unknown) {
    this.saveError = normalizeHeaderError(error);
    this.update();
  }

  private base(): TaskListState {
    return this.saved ?? { title: "", items: [] };
  }

  private compute(): TaskListState {
    const changes = this.pending.flat();
    for (const [id, note] of this.noteDrafts) {
      changes.push({ type: "update", id, fields: { note } });
    }
    return { ...applyPendingChanges(this.base(), changes), headerError: this.saveError };
  }

  private update() {
    this.shown = this.compute();
    this.onChange();
  }
}
