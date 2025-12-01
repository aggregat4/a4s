import { html, render } from "../../vendor/lit-html.js";
import { generateListId } from "./list-store.js";

class ListRegistry {
  constructor({ listsContainer, repository, eventHandlers = {} } = {}) {
    this.listsContainer = listsContainer ?? null;
    this.repository = repository ?? null;
    this.eventHandlers = eventHandlers;
    this.records = new Map();
    this.listOrder = [];
    this.activeListId = null;
  }

  setEventHandlers(eventHandlers = {}) {
    this.eventHandlers = eventHandlers;
  }

  getRecord(listId) {
    return this.records.get(listId) ?? null;
  }

  getRecordsInOrder() {
    return this.listOrder.map((id) => this.records.get(id)).filter(Boolean);
  }

  has(listId) {
    return this.records.has(listId);
  }

  getActiveListId() {
    return this.activeListId;
  }

  clearActiveListId() {
    this.activeListId = null;
  }

  setActiveListId(listId) {
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

  createList(config, { makeActive = false } = {}) {
    if (!this.listsContainer) return null;
    const id = config.id ?? generateListId("list");
    const state = {
      title:
        typeof config.title === "string" && config.title.length
          ? config.title
          : "",
      items: Array.isArray(config.items) ? config.items : [],
    };
    const displayName = state.title.length ? state.title : "Untitled List";
    const existing = this.records.get(id);
    if (existing) {
      existing.name = displayName;
      existing.element.listRepository = this.repository;
      existing.element.initialState = {
        title: state.title,
        items: Array.isArray(state.items)
          ? state.items.map((item) => ({ ...item }))
          : [],
      };
      if (makeActive) {
        this.activeListId = id;
      }
      return existing;
    }

    const wrapper = document.createElement("section");
    wrapper.className = "list-section";
    wrapper.dataset.listId = id;

    const items = Array.isArray(config.items)
      ? config.items.map((item) => ({ ...item }))
      : [];

    render(html` <a4-tasklist></a4-tasklist> `, wrapper);
    this.listsContainer.appendChild(wrapper);

    const listElement = wrapper.querySelector("a4-tasklist");
    if (!listElement) {
      wrapper.remove();
      return null;
    }
    listElement.listId = id;
    listElement.listRepository = this.repository;
    listElement.initialState = {
      title: state.title,
      items,
    };

    const record = {
      id,
      name: displayName,
      element: listElement,
      wrapper,
      totalCount: listElement.getTotalItemCount(),
      matchCount: listElement.getSearchMatchCount(),
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

  removeList(listId) {
    const record = this.records.get(listId);
    if (!record) return;
    const element = record.element;
    element?.dispose?.();
    this.unregisterListEvents(record);
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
      record.flashTimer = null;
    }
    record.wrapper.remove();
    this.records.delete(listId);
    this.listOrder = this.listOrder.filter((id) => id !== listId);
    if (this.activeListId === listId) {
      this.activeListId = null;
    }
  }

  setListOrder(order = []) {
    this.listOrder = order.filter((id) => this.records.has(id));
  }

  appendWrappersInOrder() {
    if (!this.listsContainer) return;
    this.listOrder.forEach((id) => {
      const record = this.records.get(id);
      if (record) {
        this.listsContainer.appendChild(record.wrapper);
      }
    });
  }

  refreshMetrics(record) {
    if (!record) return;
    record.totalCount = record.element.getTotalItemCount();
    record.matchCount = record.element.getSearchMatchCount();
  }

  updateListVisibility({ searchMode }) {
    this.listOrder.forEach((id) => {
      const record = this.records.get(id);
      if (!record) return;
      const isActive = id === this.activeListId;
      const shouldShow = searchMode || isActive;
      record.wrapper.classList.toggle("is-visible", shouldShow);
      record.wrapper.classList.toggle("is-active", isActive);
    });
  }

  flashList(listId) {
    const record = this.records.get(listId);
    if (!record) return;
    if (record.flashTimer) {
      clearTimeout(record.flashTimer);
    }
    record.wrapper.classList.add("list-section--flash");
    record.flashTimer = setTimeout(() => {
      record.wrapper.classList.remove("list-section--flash");
      record.flashTimer = null;
    }, 600);
  }

  getSidebarListData({ searchMode, formatMatchCount, formatTotalCount }) {
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

  registerListEvents(record) {
    const element = record?.element;
    if (!element || !this.eventHandlers) return;
    const {
      onTaskMoveRequest,
      onItemCountChange,
      onSearchResultsChange,
      onListFocus,
      onListTitleChange,
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
  }

  unregisterListEvents(record) {
    const element = record?.element;
    if (!element || !this.eventHandlers) return;
    const {
      onTaskMoveRequest,
      onItemCountChange,
      onSearchResultsChange,
      onListFocus,
      onListTitleChange,
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
  }

  getRecordIds() {
    return Array.from(this.records.keys());
  }

  getListOrder() {
    return [...this.listOrder];
  }
}

export { ListRegistry };
