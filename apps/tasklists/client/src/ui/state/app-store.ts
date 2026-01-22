import { createStore } from "./list-store.js";
import type { ListId } from "../../types/domain.js";

const APP_ACTIONS = {
  setRegistry: "app/setRegistry",
  setOrder: "app/setOrder",
  setActiveList: "app/setActiveList",
  setPendingActiveList: "app/setPendingActiveList",
  setSearchQuery: "app/setSearchQuery",
  updateListMetrics: "app/updateListMetrics",
  updateListName: "app/updateListName",
  upsertList: "app/upsertList",
} as const;

type ListSummary = {
  id: ListId;
  name: string;
  totalCount: number;
  matchCount: number;
};

type AppState = {
  lists: Record<ListId, ListSummary>;
  order: ListId[];
  activeListId: ListId | null;
  pendingActiveListId: ListId | null;
  searchQuery: string;
};

const initialState: AppState = {
  lists: {},
  order: [],
  activeListId: null,
  pendingActiveListId: null,
  searchQuery: "",
};

const normalizeLists = (lists: Array<Partial<ListSummary>> = []) =>
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
  }, {} as Record<ListId, ListSummary>);

const filterOrder = (order: Array<ListId | string> = [], lists: AppState["lists"] = {}) =>
  order.filter((id) => typeof id === "string" && id in lists);

const ensureActive = (state: AppState): AppState => {
  if (state.activeListId && state.lists[state.activeListId]) {
    return state;
  }
  const nextActive = state.order[0] ?? null;
  return { ...state, activeListId: nextActive };
};

type AppAction =
  | {
      type: typeof APP_ACTIONS.setRegistry;
      payload?: {
        lists?: Array<Partial<ListSummary>>;
        order?: ListId[];
        activeListId?: ListId | null;
        pendingActiveListId?: ListId | null;
      };
    }
  | { type: typeof APP_ACTIONS.setOrder; payload?: { order?: ListId[] } }
  | { type: typeof APP_ACTIONS.setActiveList; payload?: { id?: ListId | null } }
  | {
      type: typeof APP_ACTIONS.setPendingActiveList;
      payload?: { id?: ListId | null };
    }
  | { type: typeof APP_ACTIONS.setSearchQuery; payload?: { query?: string } }
  | {
      type: typeof APP_ACTIONS.updateListMetrics;
      payload?: { id?: ListId; totalCount?: number; matchCount?: number };
    }
  | {
      type: typeof APP_ACTIONS.updateListName;
      payload?: { id?: ListId; name?: string };
    }
  | {
      type: typeof APP_ACTIONS.upsertList;
      payload?: Partial<ListSummary> & { id?: ListId };
    }
  | { type: "@@INIT"; payload?: unknown };

const appReducer = (
  state: AppState = initialState,
  action: AppAction = { type: "@@INIT" }
) => {
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
    case APP_ACTIONS.upsertList: {
      const payload = action.payload ?? {};
      const id = payload.id ?? null;
      if (!id) return state;
      const current = state.lists[id];
      const nextName =
        typeof payload.name === "string" && payload.name.trim().length
          ? payload.name.trim()
          : current?.name ?? "Untitled List";
      const nextTotal =
        typeof payload.totalCount === "number" &&
        Number.isFinite(payload.totalCount)
          ? payload.totalCount
          : current?.totalCount ?? 0;
      const nextMatches =
        typeof payload.matchCount === "number" &&
        Number.isFinite(payload.matchCount)
          ? payload.matchCount
          : current?.matchCount ?? 0;
      if (current) {
        if (
          current.name === nextName &&
          current.totalCount === nextTotal &&
          current.matchCount === nextMatches
        ) {
          return state;
        }
        return {
          ...state,
          lists: {
            ...state.lists,
            [id]: {
              id,
              name: nextName,
              totalCount: nextTotal,
              matchCount: nextMatches,
            },
          },
        };
      }
      return {
        ...state,
        lists: {
          ...state.lists,
          [id]: {
            id,
            name: nextName,
            totalCount: nextTotal,
            matchCount: nextMatches,
          },
        },
      };
    }
    default:
      return state;
  }
};

const createAppStore = (preloadedState?: AppState) =>
  createStore(appReducer, preloadedState);

const selectors = {
  getState: (state: AppState) => state,
  getListOrder: (state: AppState) => state.order,
  getActiveListId: (state: AppState) => state.activeListId,
  getPendingActiveListId: (state: AppState) => state.pendingActiveListId,
  getSearchQuery: (state: AppState) => state.searchQuery,
  isSearchMode: (state: AppState) => (state.searchQuery ?? "").trim().length > 0,
  getList: (state: AppState, id: ListId) => state.lists[id] ?? null,
  getSidebarListData: (state: AppState) =>
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
