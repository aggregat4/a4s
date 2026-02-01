import type { ListId } from "../../types/domain.js";

type SidebarListEntry = {
  id: ListId;
  name: string;
  totalCount: number;
  matchCount: number;
  countLabel: string;
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
    }: { activeListId: ListId | null; searchQuery: string } = {
      activeListId: null,
      searchQuery: "",
    }
  ) {
    this.sidebar?.setLists?.(listData, {
      activeListId,
      searchQuery,
    });
  }
}

export { SidebarCoordinator };
