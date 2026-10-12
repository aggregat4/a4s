import { selectors } from "./app-store.js";
import type { AppAction } from "./app-store.js";
import {
  formatMatchCount,
  formatTotalCount,
} from "../../shared/format-utils.js";
import type { ListElement } from "../components/main-pane.js";
import type { ListId, TaskItem, TaskListState } from "../../types/domain.js";

type MoveDialog = {
  open?: (options: {
    sourceListId: ListId;
    itemId: string;
    task: TaskItem;
    trigger: string;
    targets: Array<{ id: ListId; name: string; countLabel: string }>;
    restoreFocus: (() => void) | null;
    onConfirm: (payload: { targetListId: ListId }) => void;
    onCancel: () => void;
  }) => void;
};

/** The rendered lists. */
type Lists = {
  listElement: (id: ListId) => ListElement | null;
  flashList: (id: ListId) => void;
};

type Repository = {
  moveTask: (
    sourceListId: ListId,
    targetListId: ListId,
    itemId: string,
    options?: { snapshot?: TaskItem; beforeId?: string; afterId?: string }
  ) => Promise<unknown> | null;
  getListState: (listId: ListId) => TaskListState | null;
};

type AppStore = {
  getState: () => ReturnType<typeof selectors.getState>;
  dispatch: (action: AppAction) => void;
};

class MoveTasksController {
  private lists: Lists;
  private repository: Repository | null;
  private moveDialog: MoveDialog | null;
  private store: AppStore;
  constructor({
    lists,
    repository,
    moveDialog,
    store,
  }: {
    lists: Lists;
    repository?: Repository | null;
    moveDialog?: MoveDialog | null;
    store: AppStore;
  }) {
    this.lists = lists;
    this.repository = repository ?? null;
    this.moveDialog = moveDialog ?? null;
    this.store = store;
  }

  handleSidebarDrop(
    payload: { sourceListId?: ListId; itemId?: string; item?: TaskItem },
    targetListId: ListId
  ) {
    const sourceListId = payload?.sourceListId;
    const itemId = payload?.itemId;
    const item = payload?.item ?? undefined;
    if (!sourceListId || !targetListId || !itemId) return;
    if (sourceListId === targetListId) return;
    this.moveTask(sourceListId, targetListId, itemId, {
      snapshot: item,
      focus: false,
    });
  }

  handleTaskMoveRequest(event: Event) {
    const customEvent = event as CustomEvent<{
      sourceListId?: ListId;
      itemId?: string;
      item?: TaskItem;
      trigger?: string;
    }>;
    const detail = customEvent.detail ?? {};
    const sourceListId = detail.sourceListId ?? null;
    const itemId = detail.itemId ?? null;
    if (!sourceListId || !itemId) return;
    const source = this.lists.listElement(sourceListId);
    if (!source) return;
    const snapshot = detail.item ?? source.getItemSnapshot(itemId);
    if (!snapshot) return;
    const state = this.store.getState();
    const searchActive = selectors.isSearchMode(state);
    const targets = selectors
      .getListOrder(state)
      .filter((id) => id !== sourceListId)
      .map((id) => {
        const listData = selectors.getList(state, id);
        const repoState = this.repository?.getListState?.(id);
        const total = (repoState?.items ?? []).filter((item) => !item?.done)
          .length;
        const matches = total; // Simplified - in search mode we calculate separately
        return {
          id,
          name: listData?.name ?? "Untitled List",
          countLabel: searchActive
            ? formatMatchCount(matches)
            : formatTotalCount(total),
        };
      });
    if (!targets.length) return;
    const restoreFocus = () => {
      source.focusItem(itemId);
    };
    this.moveDialog?.open?.({
      sourceListId,
      itemId,
      task: snapshot,
      trigger: detail.trigger ?? "button",
      targets,
      restoreFocus: detail.trigger === "shortcut" ? restoreFocus : null,
      onConfirm: ({ targetListId }) => {
        this.moveTask(sourceListId, targetListId, itemId, {
          snapshot,
          focus: detail.trigger === "shortcut",
        });
      },
      onCancel: () => {
        if (detail.trigger === "shortcut") {
          restoreFocus();
        }
      },
    });
  }

  moveTask(
    sourceListId: ListId,
    targetListId: ListId,
    itemId: string,
    options: {
      snapshot?: TaskItem;
      focus?: boolean;
      beforeId?: string;
      afterId?: string;
    } = {}
  ) {
    if (!itemId || sourceListId === targetListId) return;
    const source = this.lists.listElement(sourceListId);
    const target = this.lists.listElement(targetListId);
    if (!source || !target) return;
    const snapshot = options.snapshot ?? source.getItemSnapshot(itemId);
    if (!snapshot) return;
    source.cancelActiveDrag?.();
    const fallbackBeforeId = target.firstItemId?.() ?? undefined;
    if (!source.getItemSnapshot(itemId)) return;
    // Both lists show the move until the repository has saved it.
    const saved = this.repository
      ? this.repository.moveTask(sourceListId, targetListId, itemId, {
          snapshot,
          beforeId: options.beforeId ?? fallbackBeforeId,
          afterId: options.afterId,
        })
      : null;
    source.removeItemById(itemId, saved);
    target.prependItem(snapshot, saved);
    if (options.focus) {
      target.focusItem(itemId);
    }
    this.lists.flashList(targetListId);
  }
}

export { MoveTasksController };
