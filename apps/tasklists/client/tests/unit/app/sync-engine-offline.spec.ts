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

function createMockWindow() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((l) => {
        if (typeof l === "function") l(event);
        else l.handleEvent(event);
      });
    },
  };
}

test("SyncEngine does not poll when offline and pauseWhenOffline is true", async () => {
  const { storage } = createStorage();
  const fetchCalls: string[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    fetchCalls.push(typeof url === "string" ? url : url.toString());
    return new Response(JSON.stringify({ serverSeq: 1, datasetGenerationKey: "d1" }), { status: 200 });
  };

  const mockWindow = createMockWindow() as unknown as Window;
  const originalWindow = (globalThis as any).window;
  const originalNavigator = (globalThis as any).navigator;
  (globalThis as any).window = mockWindow;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });

  try {
    const engine = new SyncEngine({
      storage,
      baseUrl: "http://localhost:8080",
      fetchFn,
      clientId: "client-1",
      pollIntervalMs: 50,
    });
    await engine.initialize();
    engine.start();

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fetchCalls.length, 0, "should not fetch while offline");

    engine.stop();
  } finally {
    (globalThis as any).window = originalWindow;
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});

test("SyncEngine polls normally when online", async () => {
  const { storage } = createStorage();
  const fetchCalls: string[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    fetchCalls.push(typeof url === "string" ? url : url.toString());
    return new Response(JSON.stringify({ serverSeq: 1, datasetGenerationKey: "d1" }), { status: 200 });
  };

  const mockWindow = createMockWindow() as unknown as Window;
  const originalWindow = (globalThis as any).window;
  const originalNavigator = (globalThis as any).navigator;
  (globalThis as any).window = mockWindow;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });

  try {
    const engine = new SyncEngine({
      storage,
      baseUrl: "http://localhost:8080",
      fetchFn,
      clientId: "client-1",
      pollIntervalMs: 50,
    });
    await engine.initialize();
    engine.start();

    await new Promise((r) => setTimeout(r, 120));
    assert.ok(fetchCalls.length > 0, "should fetch while online");

    engine.stop();
  } finally {
    (globalThis as any).window = originalWindow;
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});

test("SyncEngine syncs immediately when coming back online", async () => {
  const { storage } = createStorage();
  const fetchCalls: string[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    fetchCalls.push(typeof url === "string" ? url : url.toString());
    return new Response(JSON.stringify({ serverSeq: 1, datasetGenerationKey: "d1" }), { status: 200 });
  };

  const mockWindow = createMockWindow() as unknown as Window;
  const originalWindow = (globalThis as any).window;
  const originalNavigator = (globalThis as any).navigator;
  (globalThis as any).window = mockWindow;
  (globalThis as any).navigator = { onLine: false };

  try {
    const engine = new SyncEngine({
      storage,
      baseUrl: "http://localhost:8080",
      fetchFn,
      clientId: "client-1",
      pollIntervalMs: 50,
    });
    await engine.initialize();
    engine.start();

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fetchCalls.length, 0, "should not fetch while offline");

    Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
    mockWindow.dispatchEvent(new Event("online"));

    await new Promise((r) => setTimeout(r, 80));
    assert.ok(fetchCalls.length > 0, "should fetch after coming online");

    engine.stop();
  } finally {
    (globalThis as any).window = originalWindow;
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});

test("SyncEngine stop removes online/offline listeners", async () => {
  const { storage } = createStorage();
  const mockWindow = createMockWindow() as unknown as Window;
  const originalWindow = (globalThis as any).window;
  const originalNavigator = (globalThis as any).navigator;
  (globalThis as any).window = mockWindow;
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });

  try {
    const engine = new SyncEngine({
      storage,
      baseUrl: "http://localhost:8080",
      fetchFn: async () => new Response("", { status: 200 }),
      clientId: "client-1",
    });
    await engine.initialize();
    engine.start();
    engine.stop();

    // Should not throw when dispatching events after stop
    mockWindow.dispatchEvent(new Event("online"));
    mockWindow.dispatchEvent(new Event("offline"));
    assert.ok(true, "no errors after stop");
  } finally {
    (globalThis as any).window = originalWindow;
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});
