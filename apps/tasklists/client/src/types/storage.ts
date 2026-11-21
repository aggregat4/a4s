import type { ListId, ListState, RegistryState } from "./domain.js";
import type { SyncOp, SyncState } from "./sync.js";

export type PersistedListRecord = {
  listId: ListId;
  state: ListState | null;
  updatedAt: number | null;
};

export type PersistedRegistryRecord = {
  state: RegistryState | null;
  updatedAt: number | null;
};

export type HydratedListRecord = {
  crdt: unknown;
  state: ListState | null;
  updatedAt: number | null;
};

export type HydrationResult = {
  lists: Map<ListId, HydratedListRecord>;
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
  persistList: (listId: ListId, state: ListState) => Promise<void>;
  persistRegistry: (state: RegistryState) => Promise<void>;
};
