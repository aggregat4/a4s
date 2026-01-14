import type { ListId, ListState, RegistryState } from "./domain.js";
import type { ListsOperation, TaskListOperation } from "./crdt.js";

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
  persistOperations: (
    listId: ListId,
    operations: TaskListOperation[],
    options?: { snapshot?: ListState | null }
  ) => Promise<void>;
  persistRegistry: (options?: {
    operations?: ListsOperation[];
    snapshot?: RegistryState | null;
  }) => Promise<void>;
};
