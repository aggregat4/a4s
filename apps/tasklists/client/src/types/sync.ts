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
 * Coarse connectivity surfaced to the UI. `disconnected` covers both an
 * offline browser and a sync server that can't be reached; it is sticky
 * until a successful flush/pull confirms `connected`. The sidebar also
 * forces `disconnected` when `navigator.onLine` is false, so the indicator
 * stays accurate even if the engine has been torn down.
 */
export type SyncStatus = "connected" | "disconnected";
