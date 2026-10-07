import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { ListRepository } from "../../../src/app/list-repository.js";
import { createListStorage } from "../../../src/storage/list-storage.js";
import { createIdentityStorage } from "../helpers/repository-model.js";

type Device = { repository: ListRepository; open: () => Promise<ListRepository>; delivered: number };

let databases = 0;

async function openDevice(): Promise<Device> {
  const dbName = `two-devices-${databases++}`;
  const identity = createIdentityStorage();
  const open = async () => {
    const storage = await createListStorage({ dbName, requestPersistence: false });
    const repository = new ListRepository({
      storageFactory: async () => storage,
      listsCrdtOptions: { identityOptions: { storage: identity } },
    });
    await repository.initialize();
    return repository;
  };
  return { repository: await open(), open, delivered: 0 };
}

/** Delivers what `from` has saved to its outbox since the last delivery. */
async function deliver(from: Device, to: Device) {
  const outbox = await (from.repository as unknown as {
    _storage: { loadOutbox: () => Promise<unknown[]> };
  })._storage.loadOutbox();
  const fresh = outbox.slice(from.delivered);
  from.delivered = outbox.length;
  await to.repository.applyRemoteOps(fresh as never);
}

const titleOf = (device: Device, listId: string) =>
  device.repository.getListState(listId).title;

test("a list restored by undo looks the same on a device that reloaded", async () => {
  const a = await openDevice();
  const b = await openDevice();
  await a.repository.createList({ listId: "list-1", title: "Inbox" });
  await deliver(a, b);

  // An empty title: restoring the list then writes no title of its own.
  await a.repository.renameList("list-1", "");
  await a.repository.removeList("list-1");
  await deliver(a, b);
  b.repository.dispose();
  b.repository = await b.open();

  await a.repository.undo(); // restores the list
  await deliver(a, b);

  assert.equal(titleOf(a, "list-1"), "");
  assert.equal(titleOf(b, "list-1"), titleOf(a, "list-1"));
});
