import { TaskListCRDT } from "../crdt/task-list-crdt.js";
import type { ListsCRDT } from "../crdt/lists-crdt.js";
import type { ListState, ListId } from "../../types/domain.js";
import type {
  HydratedListRecord,
  HydrationResult,
  ListStorage,
} from "../../types/storage.js";

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
  (registryPayload?.operations || []).forEach((operation) => {
    listsCrdt.applyOperation?.(operation);
  });

  const listPayloads = await storage.loadAllLists();
  const listMap = new Map<ListId, HydratedListRecord>();
  listPayloads.forEach((record) => {
    const listId = record.listId;
    const instance = listFactory(listId, record.state);
    if (record.state) {
      instance.resetFromState(record.state);
    }
    (record.operations || []).forEach((operation) => {
      instance.applyOperation(operation);
    });
    const clocks = [
      record.state?.clock ?? 0,
      ...(record.operations || []).map((op) =>
        Number.isFinite(op?.clock) ? Math.floor(op.clock) : 0
      ),
    ].filter(Number.isFinite);
    const lastClock = clocks.length ? Math.max(...clocks) : 0;
    listMap.set(listId, {
      crdt: instance,
      state: record.state,
      operations: record.operations || [],
      updatedAt: record.updatedAt ?? null,
      lastClock,
    });
  });

  return {
    lists: listMap,
    registryOperations: registryPayload?.operations || [],
    registryState: registryPayload?.state ?? null,
    registryUpdatedAt: registryPayload?.updatedAt ?? null,
  };
}
