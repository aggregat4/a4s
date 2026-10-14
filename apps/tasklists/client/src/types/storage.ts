import type { ListId, ListState, RegistryState } from "./domain.js";
import type { ListsOperation, TaskListOperation } from "./crdt.js";
import type { SyncOp, SyncState } from "./sync.js";

export type PersistedListRecord = {
  listId: ListId;
  state: ListState | null;
  operations: TaskListOperation[];
  updatedAt: number | null;
};

export type PersistedRegistryRecord = {
  state: RegistryState | null;
  operations: ListsOperation[];
  updatedAt: number | null;
};

export type HydratedListRecord = {
  crdt: unknown;
  state: ListState | null;
  operations: TaskListOperation[];
  updatedAt: number | null;
  lastClock: number;
};

export type HydrationResult = {
  lists: Map<ListId, HydratedListRecord>;
  registryOperations: ListsOperation[];
  registryState: RegistryState | null;
  registryUpdatedAt: number | null;
};

export type ListStorage = {
  ready: () => Promise<unknown> | void;
  clear: () => Promise<void>;
  loadAllLists: () => Promise<PersistedListRecord[]>;
  loadList: (listId: ListId) => Promise<PersistedListRecord>;
  loadRegistry: () => Promise<PersistedRegistryRecord>;
  loadSyncState: () => Promise<SyncState>;
  persistSyncState: (state: SyncState) => Promise<void>;
  loadOutbox: () => Promise<SyncOp[]>;
  persistOutbox: (ops: SyncOp[]) => Promise<void>;
  /** Saves a list's state; operations an older version stored are removed. */
  persistList: (listId: ListId, state: ListState) => Promise<void>;
  /** Saves the registry's state; operations an older version stored are removed. */
  persistRegistry: (state: RegistryState) => Promise<void>;
};
