class SidebarCoordinator {
  [key: string]: any;

  constructor({ sidebarElement }: any = {}) {
    this.sidebar = sidebarElement ?? null;
  }

  wireHandlers(handlers: any = {}) {
    this.sidebar?.setHandlers?.(handlers);
  }

  renderSidebar(listData = [], { activeListId, searchQuery, searchMode }: any = {}) {
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
