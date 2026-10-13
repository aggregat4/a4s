import type { ListRepository } from "../../app/list-repository.js";
import type { ListId } from "../../types/domain.js";
import { placement } from "./pending-changes.js";
import { PendingState } from "./pending-state.js";

/** A list as the sidebar and the main pane name it. */
export type ListEntry = { id: ListId; title: string };

/** A change the user made to the lists that the repository has not saved yet. */
export type ListsChange =
  | { type: "remove"; id: ListId }
  | { type: "move"; id: ListId; afterId: ListId | null; beforeId: ListId | null }
  | { type: "rename"; id: ListId; title: string };

// Applying a change again changes nothing more: the repository's lists can
// already include a change whose save has not reported back yet.
export function applyListsChange(lists: ListEntry[], change: ListsChange): ListEntry[] {
  switch (change.type) {
    case "remove":
      return lists.filter((list) => list.id !== change.id);
    case "move": {
      const moved = lists.find((list) => list.id === change.id);
      if (!moved) return lists;
      const next = lists.filter((list) => list.id !== change.id);
      next.splice(placement(next, change.afterId, change.beforeId), 0, moved);
      return next;
    }
    case "rename":
      return lists.map((list) => (list.id === change.id ? { ...list, title: change.title } : list));
  }
}

/**
 * The lists as the user sees them: the repository's lists, in order and with
 * their titles, with the user's changes it has not saved yet on top (see
 * `PendingState`). A change whose save fails is dropped.
 *
 * A new list shows once the repository has it: its element shows the
 * repository's state of the list, which has no title before then.
 */
export class ListsState {
  private state: PendingState<ListEntry[], ListsChange>;
  private repository: ListRepository | null;

  constructor(onChange: () => void) {
    this.repository = null;
    this.state = new PendingState({
      empty: () => [],
      apply: applyListsChange,
      read: () => this.read(),
      onChange,
    });
  }

  /** The lists as the user sees them. */
  get shown() {
    return this.state.shown();
  }

  /** Follows the lists of a repository. */
  async connect(repository: ListRepository) {
    this.repository = repository;
    await repository.initialize();
    repository.subscribeRegistry(() => this.state.setSaved(this.read() ?? []), {
      emitCurrent: false,
    });
    this.state.setSaved(this.read() ?? []);
  }

  remove(id: ListId) {
    this.state.change([{ type: "remove", id }], this.repository?.removeList(id) ?? null);
  }

  /** Moves a list between two others. */
  move(id: ListId, afterId: ListId | null, beforeId: ListId | null) {
    this.state.change(
      [{ type: "move", id, afterId, beforeId }],
      this.repository?.reorderList(id, { afterId, beforeId }) ?? null
    );
  }

  /** A rename the list itself asked the repository for, until `saved` settles. */
  rename(id: ListId, title: string, saved: Promise<unknown> | null) {
    this.state.change([{ type: "rename", id, title }], saved);
  }

  private read(): ListEntry[] | null {
    const repository = this.repository;
    if (!repository) return null;
    return repository.getRegistrySnapshot().map((entry) => ({
      id: entry.id,
      title: repository.getListState(entry.id).title,
    }));
  }
}
