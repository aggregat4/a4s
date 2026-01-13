import type { ListId } from "../../types/domain.js";

type SidebarListEntry = {
  id: ListId;
  name: string;
  totalCount: number;
  matchCount: number;
};

type SidebarElement = {
  setHandlers?: (handlers: Record<string, unknown>) => void;
  setLists?: (
    lists: Array<
      SidebarListEntry & {
        countLabel: string;
      }
    >,
    options: { activeListId: ListId | null; searchQuery: string }
  ) => void;
};

class SidebarCoordinator {
  private sidebar: SidebarElement | null;

  constructor({ sidebarElement }: { sidebarElement?: SidebarElement | null } = {}) {
    this.sidebar = sidebarElement ?? null;
  }

  wireHandlers(handlers: Record<string, unknown> = {}) {
    this.sidebar?.setHandlers?.(handlers);
  }

  renderSidebar(
    listData: SidebarListEntry[] = [],
    {
      activeListId,
      searchQuery,
      searchMode,
    }: { activeListId: ListId | null; searchQuery: string; searchMode: boolean } = {
      activeListId: null,
      searchQuery: "",
      searchMode: false,
    }
  ) {
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

  formatMatchCount(count: number) {
    if (!count) return "No matches";
    return count === 1 ? "1 match" : `${count} matches`;
  }

  formatTotalCount(count: number) {
    if (!count) return "Empty";
    return count === 1 ? "1" : `${count}`;
  }
}

export { SidebarCoordinator };
