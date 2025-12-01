import { createStore } from "./list-store.js";

const APP_ACTIONS = {
  setRegistry: "app/setRegistry",
  setOrder: "app/setOrder",
  setActiveList: "app/setActiveList",
  setPendingActiveList: "app/setPendingActiveList",
  setSearchQuery: "app/setSearchQuery",
  updateListMetrics: "app/updateListMetrics",
  updateListName: "app/updateListName",
};

const initialState = {
  lists: {}, // id -> { id, name, totalCount, matchCount }
  order: [],
  activeListId: null,
  pendingActiveListId: null,
  searchQuery: "",
};

const normalizeLists = (lists = []) =>
  lists.reduce((acc, entry) => {
    if (!entry || typeof entry.id !== "string") return acc;
    acc[entry.id] = {
      id: entry.id,
      name:
        typeof entry.name === "string" && entry.name.length
          ? entry.name
          : "Untitled List",
      totalCount:
        typeof entry.totalCount === "number" &&
        Number.isFinite(entry.totalCount)
          ? entry.totalCount
          : 0,
      matchCount:
        typeof entry.matchCount === "number" &&
        Number.isFinite(entry.matchCount)
          ? entry.matchCount
          : 0,
    };
    return acc;
  }, {});

const filterOrder = (order = [], lists = {}) =>
  order.filter((id) => typeof id === "string" && id in lists);

const ensureActive = (state) => {
  if (state.activeListId && state.lists[state.activeListId]) {
    return state;
  }
  const nextActive = state.order[0] ?? null;
  return { ...state, activeListId: nextActive };
};

const appReducer = (state = initialState, action = {}) => {
  switch (action.type) {
    case APP_ACTIONS.setRegistry: {
      const payload = action.payload ?? {};
      const lists = normalizeLists(payload.lists);
      const order = filterOrder(payload.order, lists);
      const pendingActive =
        typeof payload.pendingActiveListId === "string" &&
        lists[payload.pendingActiveListId]
          ? null
          : payload.pendingActiveListId ?? null;
      const activeCandidate =
        typeof payload.activeListId === "string" && lists[payload.activeListId]
          ? payload.activeListId
          : state.activeListId;
      const nextState = {
        ...state,
        lists,
        order,
        pendingActiveListId: pendingActive,
        activeListId: activeCandidate,
      };
      return ensureActive(nextState);
    }
    case APP_ACTIONS.setOrder: {
      const nextOrder = filterOrder(action.payload?.order, state.lists);
      if (nextOrder.length === state.order.length) {
        const same = nextOrder.every((id, idx) => id === state.order[idx]);
        if (same) return state;
      }
      return ensureActive({ ...state, order: nextOrder });
    }
    case APP_ACTIONS.setActiveList: {
      const nextId = action.payload?.id ?? null;
      if (nextId === null) {
        return { ...state, activeListId: null };
      }
      if (!state.lists[nextId]) return state;
      if (state.activeListId === nextId) return state;
      return { ...state, activeListId: nextId };
    }
    case APP_ACTIONS.setPendingActiveList: {
      const next = action.payload?.id ?? null;
      if (state.pendingActiveListId === next) return state;
      return { ...state, pendingActiveListId: next };
    }
    case APP_ACTIONS.setSearchQuery: {
      const query =
        typeof action.payload?.query === "string" ? action.payload.query : "";
      if (query === state.searchQuery) return state;
      return { ...state, searchQuery: query };
    }
    case APP_ACTIONS.updateListMetrics: {
      const { id, totalCount, matchCount } = action.payload ?? {};
      if (!state.lists[id]) return state;
      const current = state.lists[id];
      const nextMetrics = {
        totalCount:
          typeof totalCount === "number" && Number.isFinite(totalCount)
            ? totalCount
            : current.totalCount,
        matchCount:
          typeof matchCount === "number" && Number.isFinite(matchCount)
            ? matchCount
            : current.matchCount,
      };
      if (
        nextMetrics.totalCount === current.totalCount &&
        nextMetrics.matchCount === current.matchCount
      ) {
        return state;
      }
      return {
        ...state,
        lists: {
          ...state.lists,
          [id]: { ...current, ...nextMetrics },
        },
      };
    }
    case APP_ACTIONS.updateListName: {
      const { id, name } = action.payload ?? {};
      if (!state.lists[id]) return state;
      const nextName =
        typeof name === "string" && name.trim().length
          ? name.trim()
          : "Untitled List";
      if (state.lists[id].name === nextName) return state;
      return {
        ...state,
        lists: {
          ...state.lists,
          [id]: { ...state.lists[id], name: nextName },
        },
      };
    }
    default:
      return state;
  }
};

const createAppStore = (preloadedState) =>
  createStore(appReducer, preloadedState);

const selectors = {
  getState: (state) => state,
  getListOrder: (state) => state.order,
  getActiveListId: (state) => state.activeListId,
  getPendingActiveListId: (state) => state.pendingActiveListId,
  getSearchQuery: (state) => state.searchQuery,
  isSearchMode: (state) => (state.searchQuery ?? "").trim().length > 0,
  getList: (state, id) => state.lists[id] ?? null,
  getSidebarListData: (state) =>
    state.order
      .map((id) => state.lists[id])
      .filter(Boolean)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        totalCount: entry.totalCount,
        matchCount: entry.matchCount,
      })),
};

export { APP_ACTIONS, createAppStore, selectors };
