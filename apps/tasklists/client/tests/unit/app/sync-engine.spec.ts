import test from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../../../src/app/sync-engine.js";
import type { ListStorage } from "../../../src/types/storage.js";
import type { SyncOp, SyncState } from "../../../src/types/sync.js";

const createStorage = () => {
  let syncState: SyncState = { clientId: "", lastServerSeq: 0, datasetId: "" };
  let outbox: SyncOp[] = [];
  const storage: ListStorage = {
    ready: async () => {},
    clear: async () => {
      syncState = { clientId: "", lastServerSeq: 0, datasetId: "" };
      outbox = [];
    },
    loadAllLists: async () => [],
    loadList: async (listId: string) => ({ listId, state: null, operations: [], updatedAt: null }),
    loadRegistry: async () => ({ state: null, operations: [], updatedAt: null }),
    loadSyncState: async () => ({ ...syncState }),
    persistSyncState: async (state) => {
      syncState = { ...state };
    },
    loadOutbox: async () => outbox.map((op) => ({ ...op })),
    persistOutbox: async (ops) => {
      outbox = Array.isArray(ops) ? ops.map((op) => ({ ...op })) : [];
    },
    persistOperations: async () => {},
    persistRegistry: async () => {},
  };
  return { storage, getState: () => syncState, getOutbox: () => outbox };
};

test("SyncEngine flushes outbox and updates server seq", async () => {
  const { storage, getState, getOutbox } = createStorage();
  const fetchCalls: Array<{ url: string; body?: string }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body as string | undefined });
    if (url.includes("/sync/push")) {
      return new Response(JSON.stringify({ serverSeq: 5, datasetId: "dataset-1" }), { status: 200 });
    }
    if (url.includes("/sync/pull")) {
      return new Response(JSON.stringify({ serverSeq: 5, datasetId: "dataset-1", ops: [] }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const engine = new SyncEngine({
    storage,
    baseUrl: "http://localhost:8080",
    fetchFn,
    clientId: "client-1",
  });
  await engine.initialize();
  engine.enqueueOps("list", "list-1", [
    { type: "insert", actor: "actor-1", clock: 1, itemId: "item-1" } as any,
  ]);
  await engine.syncOnce();

  assert.equal(getOutbox().length, 0);
  assert.equal(getState().lastServerSeq, 5);
  assert.equal(getState().datasetId, "dataset-1");
  assert.ok(fetchCalls.some((call) => call.url.includes("/sync/push")));
});

test("SyncEngine applies remote ops", async () => {
  const { storage } = createStorage();
  const received: SyncOp[] = [];
  const fetchFn = async (url: string) => {
    if (url.includes("/sync/pull")) {
      return new Response(
        JSON.stringify({
          serverSeq: 3,
          datasetId: "dataset-1",
          ops: [
            {
              scope: "registry",
              resourceId: "registry",
              actor: "actor-1",
              clock: 1,
              payload: { type: "createList", listId: "list-1" },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ serverSeq: 3, datasetId: "dataset-1" }), { status: 200 });
  };

  const engine = new SyncEngine({
    storage,
    baseUrl: "http://localhost:8080",
    fetchFn,
    clientId: "client-1",
    onRemoteOps: async (ops) => {
      received.push(...ops);
    },
  });
  await engine.initialize();
  await engine.syncOnce();

  assert.equal(received.length, 1);
  assert.equal(received[0].scope, "registry");
});
