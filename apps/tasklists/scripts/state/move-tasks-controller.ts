import { APP_ACTIONS, selectors } from "./app-store.js";

class MoveTasksController {
  [key: string]: any;

  constructor({
    registry,
    repository,
    moveDialog,
    store,
    formatMatchCount,
    formatTotalCount,
  }: any = {}) {
    this.registry = registry;
    this.repository = repository;
    this.moveDialog = moveDialog ?? null;
    this.store = store;
    this.formatMatchCount = formatMatchCount;
    this.formatTotalCount = formatTotalCount;
  }

  handleSidebarDrop(payload, targetListId) {
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

  handleTaskMoveRequest(event) {
    const detail = event.detail ?? {};
    const sourceListId =
      detail.sourceListId ?? event.currentTarget?.listId ?? null;
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
        const listData = selectors.getList(state, rec.id) ?? {};
        const total = listData.totalCount ?? rec.element.getTotalItemCount();
        const matches =
          listData.matchCount ?? rec.element.getSearchMatchCount();
        return {
          id: rec.id,
          name: listData.name ?? rec.name,
          countLabel:
            searchActive && this.formatMatchCount
              ? this.formatMatchCount(matches)
              : this.formatTotalCount
              ? this.formatTotalCount(total)
              : `${total}`,
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

  moveTask(sourceListId, targetListId, itemId, options: any = {}) {
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
    this.dispatchMetrics(sourceRecord);
    this.dispatchMetrics(targetRecord);
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

  dispatchMetrics(record) {
    if (!record) return;
    const total = record.element.getTotalItemCount();
    const matchCount = record.element.getSearchMatchCount();
    this.store?.dispatch?.({
      type: APP_ACTIONS.updateListMetrics,
      payload: { id: record.id, totalCount: total, matchCount },
    });
  }
}

export { MoveTasksController };
