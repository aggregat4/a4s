import { TaskListCRDT } from "../domain/crdt/task-list-crdt.js";
import type { ListsCRDT } from "../domain/crdt/lists-crdt.js";
import type { ListState, ListId } from "../types/domain.js";
import type {
  HydratedListRecord,
  HydrationResult,
  ListStorage,
} from "../types/storage.js";

function ensureListFactory(
  factory?: (listId: ListId, initialState?: ListState | null) => TaskListCRDT
) {
  if (typeof factory === "function") return factory;
  return (_listId: ListId, initialState: ListState | null = null) =>
    new TaskListCRDT({
      title: initialState?.title ?? "",
      titleUpdatedAt: initialState?.titleUpdatedAt ?? 0,
    });
}

export async function hydrateFromStorage({
  storage,
  listsCrdt,
  createListCrdt,
}: {
  storage: ListStorage;
  listsCrdt: ListsCRDT;
  createListCrdt?: (listId: ListId, initialState?: ListState | null) => TaskListCRDT;
}): Promise<HydrationResult> {
  if (!storage || typeof storage.loadRegistry !== "function") {
    throw new Error(
      "hydrateFromStorage requires a storage instance with loadRegistry"
    );
  }
  if (!listsCrdt || typeof listsCrdt.resetFromState !== "function") {
    throw new Error("hydrateFromStorage requires a valid ListsCRDT instance");
  }
  const listFactory = ensureListFactory(createListCrdt);

  await storage.ready?.();
  const registryPayload = await storage.loadRegistry();
  if (registryPayload?.state) {
    listsCrdt.resetFromState(registryPayload.state);
  } else {
    listsCrdt.resetFromState({ entries: [], clock: 0 });
  }

  const listPayloads = await storage.loadAllLists();
  const listMap = new Map<ListId, HydratedListRecord>();
  listPayloads.forEach((record) => {
    const listId = record.listId;
    const instance = listFactory(listId, record.state);
    if (record.state) {
      instance.resetFromState(record.state);
    }
    listMap.set(listId, {
      crdt: instance,
      state: record.state,
      updatedAt: record.updatedAt ?? null,
    });
  });

  return {
    lists: listMap,
    registryState: registryPayload?.state ?? null,
    registryUpdatedAt: registryPayload?.updatedAt ?? null,
  };
}
