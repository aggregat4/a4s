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
  datasetGenerationKey: string;
};

/**
 * Coarse sync lifecycle surfaced to the UI. `saving` collapses both
 * pending (debounced) and in-flight flushes; `error` is sticky until the
 * next successful flush clears it.
 */
export type SyncStatus = "idle" | "saving" | "error";
