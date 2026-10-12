import { generateListId, cloneListState } from "./list-store.js";
import type { ListId, TaskItem, TaskListState } from "../../types/domain.js";

type ListElement = HTMLElement & {
  initialState?: TaskListState;
  getTotalItemCount: () => number;
  getSearchMatchCountForQuery?: (query: string) => number;
  applyFilter?: (query: string) => void;
  showDone?: boolean;
  searchQuery?: string;
  focusItem: (id: string) => void;
  getItemSnapshot: (id: string) => TaskItem | null;
  removeItemById: (id: string, saved: Promise<unknown> | null) => boolean;
  prependItem: (item: TaskItem, saved: Promise<unknown> | null) => void;
  addTask?: () => void;
  setShowDone?: (value: boolean) => void;
  cancelActiveDrag?: () => void;
  firstItemId?: () => string | null;
  dispose?: () => void;
};

export type ListRecord = {
  id: ListId;
  initialState: TaskListState;
  element: ListElement | null;
  wrapper: HTMLElement | null;
  stateVersion: number;
  appliedStateVersion: number;
  flashTimer: ReturnType<typeof setTimeout> | null;
};

type ListConfig = {
  id?: ListId;
  title?: string;
  items?: TaskItem[];
};

class ListRegistry {
  private records: Map<ListId, ListRecord>;
  private listOrder: ListId[];
  private activeListId: ListId | null;

  constructor() {
    this.records = new Map();
    this.listOrder = [];
    this.activeListId = null;
  }

  getRecord(listId: ListId) {
    return this.records.get(listId) ?? null;
  }

  getRecordsInOrder() {
    return this.listOrder
      .map((id) => this.records.get(id))
      .filter((r): r is ListRecord => Boolean(r));
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

  createList(config: ListConfig, { makeActive = false }: { makeActive?: boolean } = {}) {
    const id = config.id ?? generateListId("list");
    const state = cloneListState({
      title:
        typeof config.title === "string" && config.title.length
          ? config.title
          : "",
      items: Array.isArray(config.items) ? config.items : [],
    });
    const existing = this.records.get(id);
    if (existing) {
      existing.initialState = state;
      existing.stateVersion = (existing.stateVersion ?? 0) + 1;
      if (makeActive) {
        this.activeListId = id;
      }
      return existing;
    }

    const record: ListRecord = {
      id,
      initialState: state,
      element: null,
      wrapper: null,
      stateVersion: 1,
      appliedStateVersion: 0,
      flashTimer: null,
    };

    this.records.set(id, record);
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
    record.element?.dispose?.();
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



  flashList(listId: ListId) {
    const record = this.records.get(listId);
    if (!record || !record.wrapper) return;
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
    }
    const wrapper = record.wrapper;
    wrapper.classList.add("list-section-flash");
    record.flashTimer = setTimeout(() => {
      wrapper.classList.remove("list-section-flash");
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
      record.element = listElement;
      record.wrapper = section;
      if (record.appliedStateVersion !== record.stateVersion) {
        listElement.initialState = record.initialState;
        record.appliedStateVersion = record.stateVersion;
      }
    });
  }

  getRecordIds() {
    return Array.from(this.records.keys());
  }

  getListOrder() {
    return [...this.listOrder];
  }
}

export { ListRegistry };
