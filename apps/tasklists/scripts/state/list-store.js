export const cloneListState = (source) => ({
  title: typeof source?.title === "string" ? source.title : "",
  items: Array.isArray(source?.items)
    ? source.items.map((item, index) => ({
        id:
          typeof item?.id === "string" && item.id.length
            ? item.id
            : `item-${index}`,
        text: typeof item?.text === "string" ? item.text : "",
        done: Boolean(item?.done),
      }))
    : [],
});

export const generateItemId = () => `task-${crypto.randomUUID()}`;
export const generateListId = (prefix = "list") => `${prefix}-${crypto.randomUUID()}`;

export const LIST_ACTIONS = {
  setTitle: "list/setTitle",
  setItemDone: "list/setItemDone",
  updateItemText: "list/updateItemText",
  reorderItems: "list/reorderItems",
  replaceAll: "list/replaceAll",
  insertItem: "list/insertItem",
  removeItem: "list/removeItem",
};

export const listReducer = (state = { title: "", items: [] }, action = {}) => {
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
      const unchanged = nextItems.every((item, index) => item === state.items[index]);
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
    default:
      return state;
  }
};

export const createStore = (reducer, preloadedState) => {
  let currentState =
    typeof preloadedState === "undefined"
      ? reducer(undefined, { type: "@@INIT" })
      : reducer(preloadedState, { type: "@@INIT" });
  let listeners = new Set();

  return {
    getState: () => currentState,
    dispatch(action) {
      const nextState = reducer(currentState, action);
      if (nextState !== currentState) {
        currentState = nextState;
        listeners.forEach((fn) => fn());
      }
      return action;
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
