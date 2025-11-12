import { TaskListCRDT } from "../crdt/task-list-crdt.js";

function generateItemId(listId) {
  return `${listId}-item-${crypto.randomUUID()}`;
}

function ensureListFactory(factory) {
  if (typeof factory === "function") return factory;
  return (listId, initialState = {}) =>
    new TaskListCRDT({
      title: initialState.title ?? "",
      titleUpdatedAt: initialState.titleUpdatedAt ?? 0,
    });
}

export async function hydrateFromStorage({
  storage,
  listsCrdt,
  createListCrdt,
} = {}) {
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

export async function seedDefaultsIfEmpty({
  storage,
  listsCrdt,
  createListCrdt,
  seedConfigs = [],
} = {}) {
  if (!storage || typeof storage.loadRegistry !== "function") {
    throw new Error("seedDefaultsIfEmpty requires a storage instance");
  }
  if (!listsCrdt || typeof listsCrdt.generateCreate !== "function") {
    throw new Error("seedDefaultsIfEmpty requires a valid ListsCRDT instance");
  }
  if (!Array.isArray(seedConfigs) || !seedConfigs.length) {
    return false;
  }

  await storage.ready?.();
  const [registryPayload, listPayloads] = await Promise.all([
    storage.loadRegistry(),
    storage.loadAllLists(),
  ]);

  const hasExistingData =
    (registryPayload?.state?.entries?.length ?? 0) > 0 ||
    (registryPayload?.operations?.length ?? 0) > 0 ||
    listPayloads.length > 0;
  if (hasExistingData) {
    return false;
  }

  const listFactory = ensureListFactory(createListCrdt);
  const registryOps = [];
  const persistPromises = [];
  let previousListId = null;

  seedConfigs.forEach((seedConfig, index) => {
    const listId =
      typeof seedConfig.id === "string" && seedConfig.id.length
        ? seedConfig.id
        : `seed-list-${crypto.randomUUID()}`;
    const listInstance = listFactory(listId, {
      title: seedConfig.title ?? "",
      titleUpdatedAt: 0,
    });
    listInstance.resetFromState({
      title: seedConfig.title ?? "",
      titleUpdatedAt: 0,
      clock: 0,
      entries: [],
    });

    const listOps = [];
    const renameResult = listInstance.generateRename(seedConfig.title ?? "");
    if (renameResult?.op) {
      listOps.push(renameResult.op);
    }

    let previousItemId = null;
    (seedConfig.items || []).forEach((item, itemIndex) => {
      const itemId =
        typeof item.id === "string" && item.id.length
          ? item.id
          : generateItemId(listId);
      const insertResult = listInstance.generateInsert({
        itemId,
        text: typeof item.text === "string" ? item.text : "",
        done: Boolean(item.done),
        afterId: previousItemId,
      });
      if (insertResult?.op) {
        listOps.push(insertResult.op);
      }
      previousItemId = itemId;
    });

    persistPromises.push(
      storage.persistOperations(listId, listOps, {
        snapshot: listInstance.exportState(),
      })
    );

    const createResult = listsCrdt.generateCreate({
      listId,
      title: seedConfig.title ?? "",
      afterId: previousListId,
    });
    if (createResult?.op) {
      registryOps.push(createResult.op);
    }
    previousListId = listId;
  });

  await Promise.all(persistPromises);
  await storage.persistRegistry({
    operations: registryOps,
    snapshot: listsCrdt.exportState(),
  });
  return true;
}
