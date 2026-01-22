import type { TaskItem, TaskListState } from "../../types/domain.js";

type HeaderError = { message: string; code?: string } | null;

const normalizeHeaderError = (value: unknown): HeaderError => {
  if (!value) return null;
  const message =
    typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : null;
  if (!message) return null;
  const code =
    typeof (value as { code?: unknown }).code === "string"
      ? (value as { code: string }).code
      : null;
  return code ? { message, code } : { message };
};

export const cloneListState = (source: unknown): TaskListState => ({
  title:
    typeof (source as { title?: unknown })?.title === "string"
      ? (source as { title: string }).title
      : "",
  items: Array.isArray((source as { items?: TaskItem[] })?.items)
    ? (source as { items: TaskItem[] }).items.map((item, index) => ({
        id:
          typeof item?.id === "string" && item.id.length
            ? item.id
            : `item-${index}`,
        text: typeof item?.text === "string" ? item.text : "",
        done: Boolean(item?.done),
      }))
    : [],
  headerError: normalizeHeaderError(
    (source as { headerError?: HeaderError | null })?.headerError
  ),
});

export const generateItemId = () => `task-${crypto.randomUUID()}`;
export const generateListId = (prefix = "list") =>
  `${prefix}-${crypto.randomUUID()}`;

export const LIST_ACTIONS = {
  setTitle: "list/setTitle",
  setItemDone: "list/setItemDone",
  updateItemText: "list/updateItemText",
  reorderItems: "list/reorderItems",
  replaceAll: "list/replaceAll",
  insertItem: "list/insertItem",
  removeItem: "list/removeItem",
  setHeaderError: "list/setHeaderError",
  clearHeaderError: "list/clearHeaderError",
} as const;

type ListAction =
  | { type: typeof LIST_ACTIONS.setTitle; payload?: { title?: string } }
  | {
      type: typeof LIST_ACTIONS.setItemDone;
      payload?: { id?: string; done?: boolean };
    }
  | {
      type: typeof LIST_ACTIONS.updateItemText;
      payload?: { id?: string; text?: string };
    }
  | {
      type: typeof LIST_ACTIONS.reorderItems;
      payload?: { order?: string[] };
    }
  | {
      type: typeof LIST_ACTIONS.replaceAll;
      payload?: TaskListState | null;
    }
  | {
      type: typeof LIST_ACTIONS.insertItem;
      payload?: {
        index?: number;
        item?: Partial<TaskItem> | null;
      };
    }
  | {
      type: typeof LIST_ACTIONS.removeItem;
      payload?: { id?: string };
    }
  | {
      type: typeof LIST_ACTIONS.setHeaderError;
      payload?: HeaderError | null;
    }
  | { type: typeof LIST_ACTIONS.clearHeaderError; payload?: unknown }
  | { type: "@@INIT"; payload?: unknown };

export const listReducer = (
  state: TaskListState = { title: "", items: [], headerError: null },
  action: ListAction = { type: "@@INIT" }
) => {
  switch (action.type) {
    case LIST_ACTIONS.setTitle: {
      const nextTitle =
        typeof action.payload?.title === "string"
          ? action.payload.title
          : state.title;
      if (nextTitle === state.title) return state;
      return { ...state, title: nextTitle };
    }
    case LIST_ACTIONS.setItemDone: {
      const { id, done } = action.payload ?? {};
      if (!id) return state;
      const targetDone = Boolean(done);
      let changed = false;
      const nextItems = state.items.map((item) => {
        if (item.id !== id) return item;
        if (item.done === targetDone) return item;
        changed = true;
        return { ...item, done: targetDone };
      });
      return changed ? { ...state, items: nextItems } : state;
    }
    case LIST_ACTIONS.updateItemText: {
      const { id, text } = action.payload ?? {};
      if (!id || typeof text !== "string") return state;
      const nextText = text;
      let changed = false;
      const nextItems = state.items.map((item) => {
        if (item.id !== id) return item;
        if (item.text === nextText) return item;
        changed = true;
        return { ...item, text: nextText };
      });
      return changed ? { ...state, items: nextItems } : state;
    }
    case LIST_ACTIONS.reorderItems: {
      const order = Array.isArray(action.payload?.order)
        ? action.payload.order
        : null;
      if (!order || !order.length) return state;
      if (order.length !== state.items.length) return state;
      const itemMap = new Map(state.items.map((item) => [item.id, item]));
      const nextItems = order.map((id) => itemMap.get(id)).filter(Boolean);
      if (nextItems.length !== state.items.length) return state;
      const unchanged = nextItems.every(
        (item, index) => item === state.items[index]
      );
      if (unchanged) return state;
      return { ...state, items: nextItems };
    }
    case LIST_ACTIONS.insertItem: {
      const { index, item } = action.payload ?? {};
      if (!item || typeof item.id !== "string" || !item.id.length) return state;
      if (state.items.some((existing) => existing.id === item.id)) return state;
      const insertionIndex = Number.isInteger(index)
        ? Math.max(0, Math.min(index, state.items.length))
        : state.items.length;
      const nextItem = {
        id: item.id,
        text: typeof item.text === "string" ? item.text : "",
        done: Boolean(item.done),
      };
      const nextItems = state.items.slice();
      nextItems.splice(insertionIndex, 0, nextItem);
      return { ...state, items: nextItems };
    }
    case LIST_ACTIONS.removeItem: {
      const { id } = action.payload ?? {};
      if (typeof id !== "string" || !id.length) return state;
      const nextItems = state.items.filter((item) => item.id !== id);
      if (nextItems.length === state.items.length) return state;
      return { ...state, items: nextItems };
    }
    case LIST_ACTIONS.replaceAll: {
      const payload = action.payload;
      if (!payload) return state;
      const next = cloneListState(payload);
      return next;
    }
    case LIST_ACTIONS.setHeaderError: {
      const nextError = normalizeHeaderError(action.payload);
      if (!nextError && !state.headerError) return state;
      if (
        nextError &&
        state.headerError &&
        nextError.message === state.headerError.message &&
        nextError.code === state.headerError.code
      ) {
        return state;
      }
      return { ...state, headerError: nextError };
    }
    case LIST_ACTIONS.clearHeaderError: {
      if (!state.headerError) return state;
      return { ...state, headerError: null };
    }
    default:
      return state;
  }
};

export const createStore = <State, Action extends { type: string }>(
  reducer: (state: State | undefined, action: Action) => State,
  preloadedState?: State
) => {
  let currentState =
    typeof preloadedState === "undefined"
      ? reducer(undefined, { type: "@@INIT" } as Action)
      : reducer(preloadedState, { type: "@@INIT" } as Action);
  let listeners = new Set<() => void>();

  return {
    getState: () => currentState,
    dispatch(action: Action) {
      const nextState = reducer(currentState, action);
      if (nextState !== currentState) {
        currentState = nextState;
        listeners.forEach((fn) => fn());
      }
      return action;
    },
    subscribe(listener: () => void) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
