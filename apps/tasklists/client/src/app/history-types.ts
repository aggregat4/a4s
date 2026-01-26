import type { ListId, TaskItem, Position, TaskUpdateInput } from "../types/domain.js";

type HistoryScope =
  | { type: "registry" }
  | { type: "list"; listId: ListId };

type HistoryOp =
  | {
      type: "createList";
      listId: ListId;
      title: string;
      items?: TaskItem[];
      afterId?: ListId | null;
      beforeId?: ListId | null;
      position?: Position | null;
    }
  | {
      type: "removeList";
      listId: ListId;
    }
  | {
      type: "renameList";
      listId: ListId;
      title: string;
    }
  | {
      type: "reorderList";
      listId: ListId;
      afterId?: ListId | null;
      beforeId?: ListId | null;
      position?: Position | null;
    }
  | {
      type: "insertTask";
      listId: ListId;
      itemId: string;
      text: string;
      done: boolean;
      note?: string;
      afterId?: string | null;
      beforeId?: string | null;
      position?: Position | null;
    }
  | {
      type: "removeTask";
      listId: ListId;
      itemId: string;
    }
  | {
      type: "updateTask";
      listId: ListId;
      itemId: string;
      payload: TaskUpdateInput;
    }
  | {
      type: "moveTaskWithinList";
      listId: ListId;
      itemId: string;
      afterId?: string | null;
      beforeId?: string | null;
      position?: Position | null;
    }
  | {
      type: "moveTask";
      sourceListId: ListId;
      targetListId: ListId;
      itemId: string;
      snapshot: TaskItem;
      afterId?: string | null;
      beforeId?: string | null;
      position?: Position | null;
    };

type HistoryEntry = {
  scope: HistoryScope;
  forwardOps: HistoryOp[];
  inverseOps: HistoryOp[];
  label?: string;
  actor?: string;
  timestamp: number;
  coalesceKey?: string;
};

export type { HistoryEntry, HistoryOp, HistoryScope };
