import type { OrderedSetEntry, Position } from "./domain.js";

type OrderedSetOperationType = "insert" | "remove" | "move" | "update";

export type OrderedSetOperation<TData> = {
  type: OrderedSetOperationType;
  itemId: string;
  actor: string;
  clock: number;
  payload?: {
    data?: Partial<TData>;
    pos?: Position | null;
  };
};

type OrderedSetSnapshotResult<TData> = Array<OrderedSetEntry<TData>>;

export type OrderedSetExport<TData> = {
  clock: number;
  entries: OrderedSetSnapshotResult<TData>;
};

type ListsOperationType =
  | "createList"
  | "removeList"
  | "reorderList"
  | "renameList";

export type ListsOperation = {
  type: ListsOperationType;
  listId?: string;
  itemId?: string;
  actor: string;
  clock: number;
  payload?: {
    title?: string;
    pos?: Position | null;
  };
};

type TaskListOperationType =
  | OrderedSetOperationType
  | "renameList";

export type TaskListOperation = {
  type: TaskListOperationType;
  itemId?: string;
  listId?: string;
  actor: string;
  clock: number;
  payload?: {
    title?: string;
    text?: string;
    done?: boolean;
    note?: string;
    data?: { text?: string; done?: boolean; note?: string };
    pos?: Position | null;
  };
};
