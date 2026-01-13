import { TaskListCRDT } from "../crdt/task-list-crdt.js";

function generateItemId(listId) {
  return `${listId}-item-${crypto.randomUUID()}`;
}

function ensureListFactory(factory) {
  if (typeof factory === "function") return factory;
  return (listId, initialState: any = {}) =>
    new TaskListCRDT({
      title: initialState.title ?? "",
      titleUpdatedAt: initialState.titleUpdatedAt ?? 0,
    });
}

export async function hydrateFromStorage({
  storage,
  listsCrdt,
  createListCrdt,
}: any = {}) {
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
  const listMap = new Map();
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
