import type { ListsOperation, TaskListOperation } from "./crdt.js";

export type SyncScope = "registry" | "list";

export type SyncOp = {
  scope: SyncScope;
  resourceId: string;
  actor: string;
  clock: number;
  payload: ListsOperation | TaskListOperation;
  serverSeq?: number;
};

export type SyncState = {
  clientId: string;
  lastServerSeq: number;
};
