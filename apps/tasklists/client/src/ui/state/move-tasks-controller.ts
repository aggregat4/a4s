import { selectors } from "./app-store.js";
import {
  formatMatchCount,
  formatTotalCount,
} from "../../shared/format-utils.js";
import type { ListId, TaskItem, TaskListState } from "../../types/domain.js";

type ListRecord = {
  id: ListId;
  element: {
    getTotalItemCount: () => number;
    getSearchMatchCount: () => number;
    focusItem: (id: string) => void;
    getItemSnapshot: (id: string) => TaskItem | null;
    removeItemById: (id: string) => boolean;
    prependItem: (item: TaskItem) => void;
    cancelActiveDrag?: () => void;
    store?: { getState?: () => TaskListState };
  };
};

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

type RegistryController = {
  getRecord: (id: ListId) => ListRecord | null;
  flashList: (id: ListId) => void;
  has: (id: ListId) => boolean;
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
  dispatch: (action: { type: string; payload?: unknown }) => void;
};

class MoveTasksController {
  private registry: RegistryController;
  private repository: Repository | null;
  private moveDialog: MoveDialog | null;
  private store: AppStore;
  constructor({
    registry,
    repository,
    moveDialog,
    store,
  }: {
    registry: RegistryController;
    repository?: Repository | null;
    moveDialog?: MoveDialog | null;
    store: AppStore;
  }) {
    this.registry = registry;
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
    const item = payload?.item ?? null;
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
    const sourceListId =
      detail.sourceListId ??
      (event.currentTarget as { listId?: ListId } | null)?.listId ??
      null;
    const itemId = detail.itemId ?? null;
    if (!sourceListId || !itemId) return;
    const record = this.registry.getRecord(sourceListId);
    if (!record) return;
    const snapshot = detail.item ?? record.element.getItemSnapshot(itemId);
    if (!snapshot) return;
    const state = this.store.getState();
    const searchActive = selectors.isSearchMode(state);
    const targets = selectors
      .getListOrder(state)
      .map((id) => this.registry.getRecord(id))
      .filter((rec) => rec && rec.id !== sourceListId)
      .map((rec) => {
        const listData = selectors.getList(state, rec.id);
        const repoState = this.repository?.getListState?.(rec.id);
        const total = (repoState?.items ?? []).filter((item) => !item?.done)
          .length;
        const matches = total; // Simplified - in search mode we calculate separately
        return {
          id: rec.id,
          name: listData?.name ?? "Untitled List",
          countLabel: searchActive
            ? formatMatchCount(matches)
            : formatTotalCount(total),
        };
      });
    if (!targets.length) return;
    const restoreFocus = () => {
      record.element.focusItem(itemId);
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
    const sourceRecord = this.registry.getRecord(sourceListId);
    const targetRecord = this.registry.getRecord(targetListId);
    if (!sourceRecord || !targetRecord) return;
    const snapshot =
      options.snapshot ?? sourceRecord.element.getItemSnapshot(itemId);
    if (!snapshot) return;
    sourceRecord.element.cancelActiveDrag?.();
    const targetStateBefore = targetRecord.element.store?.getState?.();
    const fallbackBeforeId = Array.isArray(targetStateBefore?.items)
      ? targetStateBefore.items[0]?.id ?? undefined
      : undefined;
    const removed = sourceRecord.element.removeItemById(itemId);
    if (!removed) return;
    targetRecord.element.prependItem(snapshot);
    if (options.focus) {
      targetRecord.element.focusItem(itemId);
    }
    this.registry.flashList(targetListId);

    if (this.repository) {
      const beforeId = options.beforeId ?? fallbackBeforeId;
      const promise = this.repository.moveTask(
        sourceListId,
        targetListId,
        itemId,
        {
          snapshot,
          beforeId,
          afterId: options.afterId,
        }
      );
      this.runRepositoryOperation(promise);
    }
  }

  runRepositoryOperation(promise) {
    if (!promise || typeof promise.then !== "function") return;
    promise.catch(() => {});
  }
}

export { MoveTasksController };
