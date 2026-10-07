import "fake-indexeddb/auto";
import type * as fc from "fast-check";
import { createListStorage } from "../../../src/storage/list-storage.js";
import type { ListStorage } from "../../../src/types/storage.js";

/**
 * Opens the real IndexedDB storage (on fake-indexeddb in Node) and holds back
 * each save until the scheduler releases it, so tests explore the orders in
 * which saves complete. Loads are not held back.
 */
export async function openScheduledStorage(
  dbName: string,
  scheduler: fc.Scheduler
): Promise<ListStorage> {
  const storage = await createListStorage({ dbName, requestPersistence: false });
  const held =
    <Args extends unknown[]>(name: string, save: (...args: Args) => Promise<void>) =>
    async (...args: Args) => {
      await scheduler.schedule(Promise.resolve(), name);
      return save(...args);
    };
  return {
    ready: () => storage.ready(),
    clear: () => storage.clear(),
    loadAllLists: () => storage.loadAllLists(),
    loadList: (listId) => storage.loadList(listId),
    loadRegistry: () => storage.loadRegistry(),
    loadSyncState: () => storage.loadSyncState(),
    loadOutbox: () => storage.loadOutbox(),
    persistSyncState: held("sync state", (state) => storage.persistSyncState(state)),
    persistOutbox: held("outbox", (ops) => storage.persistOutbox(ops)),
    persistOperations: held("list", (listId, operations, options) =>
      storage.persistOperations(listId, operations, options)
    ),
    persistRegistry: held("registry", (options) => storage.persistRegistry(options)),
  };
}
