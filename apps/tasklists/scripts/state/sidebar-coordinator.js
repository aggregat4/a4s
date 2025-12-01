class SidebarCoordinator {
  constructor({ sidebarElement } = {}) {
    this.sidebar = sidebarElement ?? null;
  }

  wireHandlers(handlers = {}) {
    this.sidebar?.setHandlers?.(handlers);
  }

  renderSidebar(listData = [], { activeListId, searchQuery, searchMode }) {
    const data = listData.map((entry) => ({
      ...entry,
      countLabel: searchMode
        ? this.formatMatchCount(entry.matchCount)
        : this.formatTotalCount(entry.totalCount),
    }));
    this.sidebar?.setLists?.(data, {
      activeListId,
      searchQuery,
    });
  }

  formatMatchCount(count) {
    if (!count) return "No matches";
    return count === 1 ? "1 match" : `${count} matches`;
  }

  formatTotalCount(count) {
    if (!count) return "Empty";
    return count === 1 ? "1" : `${count}`;
  }
}

export { SidebarCoordinator };
