import { generateListId, cloneListState } from "./list-store.js";
import type { ListId, TaskItem, TaskListState } from "../../types/domain.js";

type ListElement = HTMLElement & {
  initialState?: TaskListState;
  getTotalItemCount: () => number;
  getSearchMatchCount: () => number;
  applyFilter?: (query: string) => void;
  showDone?: boolean;
  searchQuery?: string;
  focusItem: (id: string) => void;
  getItemSnapshot: (id: string) => TaskItem | null;
  removeItemById: (id: string) => boolean;
  prependItem: (item: TaskItem) => void;
  cancelActiveDrag?: () => void;
  store?: { getState?: () => TaskListState };
  dispose?: () => void;
};

type ListRecord = {
  id: ListId;
  title: string;
  name: string;
  initialState: TaskListState;
  element: ListElement | null;
  wrapper: HTMLElement | null;
  boundElement: ListElement | null;
  stateVersion: number;
  appliedStateVersion: number;
  totalCount: number;
  matchCount: number;
  flashTimer: ReturnType<typeof setTimeout> | null;
};

type ListConfig = {
  id?: ListId;
  title?: string;
  items?: TaskItem[];
};

type ListEventHandlers = Partial<{
  onTaskMoveRequest: (event: Event) => void;
  onItemCountChange: (event: Event) => void;
  onSearchResultsChange: (event: Event) => void;
  onListFocus: (event: Event) => void;
  onListTitleChange: (event: Event) => void;
  onSearchClear: (event: Event) => void;
  onShowDoneChange: (event: Event) => void;
}>;

class ListRegistry {
  private eventHandlers: ListEventHandlers;
  private records: Map<ListId, ListRecord>;
  private listOrder: ListId[];
  private activeListId: ListId | null;

  constructor({
    repository: _repository,
    eventHandlers = {},
  }: {
    repository?: { createList?: (options: ListConfig) => void } | null;
    eventHandlers?: ListEventHandlers;
  } = {}) {
    this.eventHandlers = eventHandlers;
    this.records = new Map();
    this.listOrder = [];
    this.activeListId = null;
  }

  setEventHandlers(eventHandlers: ListEventHandlers = {}) {
    this.eventHandlers = eventHandlers;
  }

  getRecord(listId: ListId) {
    return this.records.get(listId) ?? null;
  }

  getRecordsInOrder() {
    return this.listOrder.map((id) => this.records.get(id)).filter(Boolean);
  }

  has(listId: ListId) {
    return this.records.has(listId);
  }

  getActiveListId() {
    return this.activeListId;
  }

  clearActiveListId() {
    this.activeListId = null;
  }

  setActiveListId(listId: ListId | null) {
    if (!listId) {
      this.clearActiveListId();
      return;
    }
    if (!this.records.has(listId)) return;
    this.activeListId = listId;
  }

  ensureActiveListId() {
    if (this.activeListId && this.records.has(this.activeListId)) {
      return this.activeListId;
    }
    const fallback = this.listOrder.find((id) => this.records.has(id)) ?? null;
    this.activeListId = fallback ?? null;
    return this.activeListId;
  }

  createList(config: ListConfig, { makeActive = false }: { makeActive?: boolean } = {}) {
    const id = config.id ?? generateListId("list");
    const state = cloneListState({
      title:
        typeof config.title === "string" && config.title.length
          ? config.title
          : "",
      items: Array.isArray(config.items) ? config.items : [],
    });
    const displayName = state.title.length ? state.title : "Untitled List";
    const totalCountFromState = Array.isArray(state.items)
      ? state.items.filter((item) => !item?.done).length
      : 0;
    const existing = this.records.get(id);
    if (existing) {
      existing.name = displayName;
      existing.title = state.title;
      existing.initialState = state;
      existing.stateVersion = (existing.stateVersion ?? 0) + 1;
      if (existing.element) {
        existing.totalCount = existing.element.getTotalItemCount();
        existing.matchCount = existing.element.getSearchMatchCount();
      } else {
        existing.totalCount = totalCountFromState;
        existing.matchCount = totalCountFromState;
      }
      if (makeActive) {
        this.activeListId = id;
      }
      return existing;
    }

    const record: ListRecord = {
      id,
      title: state.title,
      name: displayName,
      initialState: state,
      element: null,
      wrapper: null,
      boundElement: null,
      stateVersion: 1,
      appliedStateVersion: 0,
      totalCount: totalCountFromState,
      matchCount: totalCountFromState,
      flashTimer: null,
    };

    this.records.set(id, record);
    this.registerListEvents(record);
    if (!this.listOrder.includes(id)) {
      this.listOrder.push(id);
    }

    if (makeActive || !this.activeListId) {
      this.activeListId = id;
    }
    return record;
  }

  removeList(listId: ListId) {
    const record = this.records.get(listId);
    if (!record) return;
    const element = record.element;
    this.unregisterListEvents(record);
    element?.dispose?.();
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
      record.flashTimer = null;
    }
    this.records.delete(listId);
    this.listOrder = this.listOrder.filter((id) => id !== listId);
    if (this.activeListId === listId) {
      this.activeListId = null;
    }
  }

  setListOrder(order: ListId[] = []) {
    this.listOrder = order.filter((id) => this.records.has(id));
  }

  refreshMetrics(record: ListRecord | null) {
    if (!record || !record.element) return;
    record.totalCount = record.element.getTotalItemCount();
    record.matchCount = record.element.getSearchMatchCount();
  }

  flashList(listId: ListId) {
    const record = this.records.get(listId);
    if (!record || !record.wrapper) return;
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
    }
    record.wrapper.classList.add("list-section-flash");
    record.flashTimer = setTimeout(() => {
      record.wrapper.classList.remove("list-section-flash");
      record.flashTimer = null;
    }, 600);
  }

  attachRenderedLists(container: HTMLElement | null) {
    if (!container) return;
    const sections = Array.from(
      container.querySelectorAll<HTMLElement>("section.list-section")
    );
    sections.forEach((section) => {
      const listId = (section as HTMLElement).dataset.listId;
      if (!listId) return;
      const record = this.records.get(listId);
      if (!record) return;
      const listElement = section.querySelector(
        "a4-tasklist"
      ) as ListElement | null;
      if (!listElement) return;
      if (record.boundElement && record.boundElement !== listElement) {
        this.unregisterListEvents(record);
      }
      record.element = listElement;
      record.wrapper = section;
      if (record.boundElement !== listElement) {
        record.boundElement = listElement;
        this.registerListEvents(record);
      }
      if (record.appliedStateVersion !== record.stateVersion) {
        listElement.initialState = record.initialState;
        record.appliedStateVersion = record.stateVersion;
      }
    });
  }

  getSidebarListData({
    searchMode,
    formatMatchCount,
    formatTotalCount,
  }: {
    searchMode: boolean;
    formatMatchCount: (count: number) => string;
    formatTotalCount: (count: number) => string;
  }) {
    return this.listOrder
      .map((id) => {
        const record = this.records.get(id);
        if (!record) return null;
        return {
          id: record.id,
          name: record.name,
          totalCount: record.totalCount,
          matchCount: record.matchCount,
          countLabel: searchMode
            ? formatMatchCount(record.matchCount)
            : formatTotalCount(record.totalCount),
        };
      })
      .filter(Boolean);
  }

  registerListEvents(record: ListRecord) {
    const element = record?.boundElement ?? record?.element;
    if (!element || !this.eventHandlers) return;
    const {
      onTaskMoveRequest,
      onItemCountChange,
      onSearchResultsChange,
      onListFocus,
      onListTitleChange,
      onSearchClear,
      onShowDoneChange,
    } = this.eventHandlers;
    if (onTaskMoveRequest) {
      element.addEventListener("taskMoveRequest", onTaskMoveRequest);
    }
    if (onItemCountChange) {
      element.addEventListener("itemcountchange", onItemCountChange);
    }
    if (onSearchResultsChange) {
      element.addEventListener("searchresultschange", onSearchResultsChange);
    }
    if (onListFocus) {
      element.addEventListener("taskFocus", onListFocus);
    }
    if (onListTitleChange) {
      element.addEventListener("titlechange", onListTitleChange);
    }
    if (onSearchClear) {
      element.addEventListener("clearsearch", onSearchClear);
    }
    if (onShowDoneChange) {
      element.addEventListener("showdonechange", onShowDoneChange);
    }
  }

  unregisterListEvents(record: ListRecord) {
    const element = record?.boundElement ?? record?.element;
    if (!element || !this.eventHandlers) return;
    const {
      onTaskMoveRequest,
      onItemCountChange,
      onSearchResultsChange,
      onListFocus,
      onListTitleChange,
      onSearchClear,
      onShowDoneChange,
    } = this.eventHandlers;
    if (onTaskMoveRequest) {
      element.removeEventListener("taskMoveRequest", onTaskMoveRequest);
    }
    if (onItemCountChange) {
      element.removeEventListener("itemcountchange", onItemCountChange);
    }
    if (onSearchResultsChange) {
      element.removeEventListener("searchresultschange", onSearchResultsChange);
    }
    if (onListFocus) {
      element.removeEventListener("taskFocus", onListFocus);
    }
    if (onListTitleChange) {
      element.removeEventListener("titlechange", onListTitleChange);
    }
    if (onSearchClear) {
      element.removeEventListener("clearsearch", onSearchClear);
    }
    if (onShowDoneChange) {
      element.removeEventListener("showdonechange", onShowDoneChange);
    }
    if (record) {
      record.boundElement = null;
    }
  }

  getRecordIds() {
    return Array.from(this.records.keys());
  }

  getListOrder() {
    return [...this.listOrder];
  }
}

export { ListRegistry };
