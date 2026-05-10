import test from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../../../src/app/sync-engine.js";
import type { ListStorage } from "../../../src/types/storage.js";
import type { SyncOp, SyncState } from "../../../src/types/sync.js";

const createStorage = () => {
  let syncState: SyncState = { clientId: "", lastServerSeq: 0, datasetGenerationKey: "" };
  let outbox: SyncOp[] = [];
  const storage: ListStorage = {
    ready: async () => {},
    clear: async () => {
      syncState = { clientId: "", lastServerSeq: 0, datasetGenerationKey: "" };
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
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : url.toString();
    fetchCalls.push({ url: urlString, body: init?.body as string | undefined });
    if (urlString.includes("/sync/push")) {
      return new Response(JSON.stringify({ serverSeq: 5, datasetGenerationKey: "dataset-1" }), { status: 200 });
    }
    if (urlString.includes("/sync/pull")) {
      return new Response(JSON.stringify({ serverSeq: 5, datasetGenerationKey: "dataset-1", ops: [] }), { status: 200 });
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
  assert.equal(getState().datasetGenerationKey, "dataset-1");
  assert.ok(fetchCalls.some((call) => call.url.includes("/sync/push")));
});

test("SyncEngine bootstraps dataset generation before pushing a persisted outbox", async () => {
  const { storage, getState, getOutbox } = createStorage();
  await storage.persistOutbox([
    {
      scope: "registry",
      resourceId: "registry",
      actor: "actor-1",
      clock: 1,
      payload: {
        type: "createList",
        actor: "actor-1",
        clock: 1,
        itemId: "list-1",
        payload: { title: "Inbox", pos: [] },
      } as any,
    },
  ]);
  const pushBodies: string[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : url.toString();
    if (urlString.includes("/sync/bootstrap")) {
      return new Response(
        JSON.stringify({
          serverSeq: 0,
          datasetGenerationKey: "dataset-1",
          snapshot: "",
          ops: [],
        }),
        { status: 200 }
      );
    }
    if (urlString.includes("/sync/push")) {
      pushBodies.push(init?.body as string);
      return new Response(
        JSON.stringify({ serverSeq: 1, datasetGenerationKey: "dataset-1" }),
        { status: 200 }
      );
    }
    if (urlString.includes("/sync/pull")) {
      return new Response(
        JSON.stringify({
          serverSeq: 1,
          datasetGenerationKey: "dataset-1",
          ops: [],
        }),
        { status: 200 }
      );
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
  await engine.bootstrapIfNeeded(async () => {});
  await engine.syncOnce();

  assert.equal(getOutbox().length, 0);
  assert.equal(getState().datasetGenerationKey, "dataset-1");
  assert.equal(pushBodies.length, 1);
  assert.equal(JSON.parse(pushBodies[0]).datasetGenerationKey, "dataset-1");
});

test("SyncEngine preserves ops enqueued while a push is in flight", async () => {
  const { storage, getOutbox } = createStorage();
  await storage.persistSyncState({
    clientId: "client-1",
    lastServerSeq: 0,
    datasetGenerationKey: "dataset-1",
  });
  const pushedBatches: SyncOp[][] = [];
  let engine: SyncEngine | null = null;
  let enqueueDuringFirstPush = true;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : url.toString();
    if (urlString.includes("/sync/push")) {
      pushedBatches.push(JSON.parse(init?.body as string).ops);
      if (enqueueDuringFirstPush && engine) {
        enqueueDuringFirstPush = false;
        engine.enqueueOps("list", "list-1", [
          {
            type: "remove",
            actor: "actor-1",
            clock: 2,
            itemId: "item-2",
          } as any,
        ]);
      }
      return new Response(
        JSON.stringify({
          serverSeq: pushedBatches.length,
          datasetGenerationKey: "dataset-1",
        }),
        { status: 200 }
      );
    }
    if (urlString.includes("/sync/pull")) {
      return new Response(
        JSON.stringify({
          serverSeq: pushedBatches.length,
          datasetGenerationKey: "dataset-1",
          ops: [],
        }),
        { status: 200 }
      );
    }
    return new Response("", { status: 404 });
  };
  engine = new SyncEngine({
    storage,
    baseUrl: "http://localhost:8080",
    fetchFn,
    clientId: "client-1",
  });

  await engine.initialize();
  engine.enqueueOps("list", "list-1", [
    {
      type: "insert",
      actor: "actor-1",
      clock: 1,
      itemId: "item-1",
    } as any,
  ]);
  await engine.syncOnce();

  assert.equal(pushedBatches.length, 1);
  assert.equal(pushedBatches[0].length, 1);
  assert.equal(pushedBatches[0][0].clock, 1);
  assert.equal(getOutbox().length, 1);
  assert.equal(getOutbox()[0].clock, 2);

  await engine.syncOnce();

  assert.equal(pushedBatches.length, 2);
  assert.equal(pushedBatches[1].length, 1);
  assert.equal(pushedBatches[1][0].clock, 2);
  assert.equal(getOutbox().length, 0);
});

test("SyncEngine applies remote ops", async () => {
  const { storage } = createStorage();
  const received: SyncOp[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    const urlString = typeof url === "string" ? url : url.toString();
    if (urlString.includes("/sync/pull")) {
      return new Response(
        JSON.stringify({
          serverSeq: 3,
          datasetGenerationKey: "dataset-1",
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
    return new Response(JSON.stringify({ serverSeq: 3, datasetGenerationKey: "dataset-1" }), { status: 200 });
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

test("SyncEngine syncs when EventSource receives ops event", async () => {
  const { storage } = createStorage();
  const fetchCalls: string[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    fetchCalls.push(typeof url === "string" ? url : url.toString());
    return new Response(JSON.stringify({ serverSeq: 1, datasetGenerationKey: "d1", ops: [] }), { status: 200 });
  };

  const opsHandlerRef: { fn: (() => void) | null } = { fn: null };
  const eventSourceFactory = (url: string) => {
    const es = new EventTarget() as EventSource;
    (es as any).url = url;
    (es as any).readyState = 0;
    (es as any).close = () => {
      (es as any).readyState = 2;
    };
    queueMicrotask(() => {
      (es as any).readyState = 1;
      es.dispatchEvent(new Event("open"));
    });
    opsHandlerRef.fn = () => {
      es.dispatchEvent(new MessageEvent("ops", { data: "{}" }));
    };
    return es;
  };

  const engine = new SyncEngine({
    storage,
    baseUrl: "http://localhost:8080",
    fetchFn,
    clientId: "client-1",
    eventSourceFactory,
  });
  await engine.initialize();
  engine.start();

  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.length > 0, "should sync on EventSource open");

  const callsBefore = fetchCalls.length;
  opsHandlerRef.fn?.();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fetchCalls.length > callsBefore, "should sync on ops event");

  engine.stop();
});

test("SyncEngine debounces rapid enqueueOps into a single flush", async () => {
  const { storage } = createStorage();
  let pushCalls = 0;
  const fetchFn = async (url: string | URL | Request) => {
    const urlString = typeof url === "string" ? url : url.toString();
    if (urlString.includes("/sync/push")) {
      pushCalls++;
      return new Response(JSON.stringify({ serverSeq: 1, datasetGenerationKey: "d1" }), { status: 200 });
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
  engine.start();

  engine.enqueueOps("list", "list-1", [
    { type: "insert", actor: "actor-1", clock: 1, itemId: "item-1" } as any,
  ]);
  engine.enqueueOps("list", "list-1", [
    { type: "insert", actor: "actor-1", clock: 2, itemId: "item-2" } as any,
  ]);
  engine.enqueueOps("list", "list-1", [
    { type: "insert", actor: "actor-1", clock: 3, itemId: "item-3" } as any,
  ]);

  assert.equal(pushCalls, 0, "should not flush immediately");

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(pushCalls, 1, "should batch rapid enqueues into a single push");

  engine.stop();
});

test("SyncEngine flushOnce updates lastServerSeq without pulling", async () => {
  const { storage, getState } = createStorage();
  const fetchCalls: string[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    const urlString = typeof url === "string" ? url : url.toString();
    fetchCalls.push(urlString);
    if (urlString.includes("/sync/push")) {
      return new Response(JSON.stringify({ serverSeq: 42, datasetGenerationKey: "d1" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  await storage.persistSyncState({ clientId: "client-1", lastServerSeq: 0, datasetGenerationKey: "d1" });
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
  await engine.flushOnce();

  assert.equal(getState().lastServerSeq, 42, "flushOnce should update lastServerSeq from push response");
  assert.ok(fetchCalls.some((u) => u.includes("/sync/push")), "should have pushed");
  assert.ok(!fetchCalls.some((u) => u.includes("/sync/pull")), "should not have pulled");

  engine.stop();
});

test("SyncEngine stop cancels pending debounced flush", async () => {
  const { storage } = createStorage();
  let pushCalls = 0;
  const fetchFn = async (url: string | URL | Request) => {
    const urlString = typeof url === "string" ? url : url.toString();
    if (urlString.includes("/sync/push")) {
      pushCalls++;
    }
    return new Response(JSON.stringify({ serverSeq: 1, datasetGenerationKey: "d1" }), { status: 200 });
  };
  const engine = new SyncEngine({
    storage,
    baseUrl: "http://localhost:8080",
    fetchFn,
    clientId: "client-1",
  });
  await engine.initialize();
  engine.start();

  engine.enqueueOps("list", "list-1", [
    { type: "insert", actor: "actor-1", clock: 1, itemId: "item-1" } as any,
  ]);
  engine.stop();

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(pushCalls, 0, "stop should cancel pending debounced flush");
});
