import type { TaskItem, TaskListState } from "../../types/domain.js";

/**
 * A change the user made to a list that the repository has not saved yet.
 *
 * A list shows the repository's state with its pending changes applied on
 * top. A repository snapshot taken before a change was saved then never
 * hides it, and changes from other devices show as soon as they arrive.
 * Inserts and moves name the neighbours the repository is asked for.
 */
export type PendingChange =
  | { type: "insert"; item: TaskItem; afterId: string | null; beforeId: string | null }
  | { type: "remove"; id: string }
  | { type: "update"; id: string; fields: Partial<Pick<TaskItem, "text" | "done" | "note">> }
  | { type: "move"; id: string; afterId: string | null; beforeId: string | null }
  | { type: "rename"; title: string };

/**
 * Where an item goes: after `afterId`, or else before `beforeId`. Without
 * either neighbour it goes to the top, unless it was asked to follow an item
 * that is gone, then to the end.
 */
function placement(items: TaskItem[], afterId: string | null, beforeId: string | null) {
  const after = afterId ? items.findIndex((item) => item.id === afterId) : -1;
  if (after !== -1) return after + 1;
  const before = beforeId ? items.findIndex((item) => item.id === beforeId) : -1;
  if (before !== -1) return before;
  return afterId ? items.length : 0;
}

// Applying a change again changes nothing more: the repository's state can
// already include a change whose save has not reported back yet.
function applyChange(state: TaskListState, change: PendingChange): TaskListState {
  switch (change.type) {
    case "insert": {
      if (state.items.some((item) => item.id === change.item.id)) return state;
      const items = state.items.slice();
      items.splice(placement(items, change.afterId, change.beforeId), 0, { ...change.item });
      return { ...state, items };
    }
    case "remove":
      return { ...state, items: state.items.filter((item) => item.id !== change.id) };
    case "update":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === change.id ? { ...item, ...change.fields } : item
        ),
      };
    case "move": {
      const moved = state.items.find((item) => item.id === change.id);
      if (!moved) return state;
      const items = state.items.filter((item) => item.id !== change.id);
      items.splice(placement(items, change.afterId, change.beforeId), 0, moved);
      return { ...state, items };
    }
    case "rename":
      return { ...state, title: change.title };
  }
}

/** The state with the changes applied in order. */
export function applyPendingChanges(state: TaskListState, changes: PendingChange[]) {
  return changes.reduce(applyChange, state);
}
