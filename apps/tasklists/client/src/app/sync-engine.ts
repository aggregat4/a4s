import { ensureActorId } from "../domain/crdt/ids.js";
import type { ListStorage } from "../types/storage.js";
import type { SyncOp, SyncScope, SyncState } from "../types/sync.js";
import type { ListsOperation, TaskListOperation } from "../types/crdt.js";

type FetchFn = typeof fetch;

type SyncEngineOptions = {
  storage: ListStorage;
  baseUrl: string;
  requestTimeoutMs?: number;
  fetchFn?: FetchFn;
  eventSourceFactory?: (url: string) => EventSource;
  onRemoteOps?: (ops: SyncOp[]) => Promise<void> | void;
  onSnapshot?: (payload: { datasetGenerationKey: string; snapshot: string }) => Promise<void> | void;
  onConnectionError?: (error: unknown) => void;
  clientId?: string;
  pauseWhenOffline?: boolean;
};

type SyncPushResponse = {
  serverSeq?: number;
  datasetGenerationKey?: string;
};

type SyncPullResponse = {
  serverSeq?: number;
  ops?: SyncOp[];
  datasetGenerationKey?: string;
  snapshot?: string;
};

type SyncBootstrapResponse = SyncPullResponse;

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class SyncEngine {
  private storage: ListStorage;
  private baseUrl: string;
  private requestTimeoutMs: number;
  private fetchFn: FetchFn;
  private eventSourceFactory: ((url: string) => EventSource) | null;
  private onRemoteOps: ((ops: SyncOp[]) => Promise<void> | void) | null;
  private onSnapshot: ((payload: { datasetGenerationKey: string; snapshot: string }) => Promise<void> | void) | null;
  private onConnectionError: ((error: unknown) => void) | null;
  private state: SyncState;
  private outbox: SyncOp[];
  private eventSource: EventSource | null;
  private isActive: boolean;
  private syncQueue: Promise<void>;
  private defaultClientId: string | null;
  private pauseWhenOffline: boolean;
  private handleOnline: (() => void) | null;
  private handleOffline: (() => void) | null;
  private handleVisibilityChange: (() => void) | null;
  private flushTimer: ReturnType<typeof setTimeout> | null;
  private readonly flushDebounceMs = 300;

  constructor(options: SyncEngineOptions) {
    this.storage = options.storage;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.requestTimeoutMs =
      typeof options.requestTimeoutMs === "number" && options.requestTimeoutMs > 0
        ? Math.floor(options.requestTimeoutMs)
        : DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn =
      options.fetchFn ?? globalThis.fetch?.bind(globalThis);
    this.eventSourceFactory = options.eventSourceFactory ?? null;
    this.onRemoteOps = options.onRemoteOps ?? null;
    this.onSnapshot = options.onSnapshot ?? null;
    this.onConnectionError = options.onConnectionError ?? null;
    this.state = { clientId: "", lastServerSeq: 0, datasetGenerationKey: "" };
    this.outbox = [];
    this.eventSource = null;
    this.syncQueue = Promise.resolve();
    this.defaultClientId = options.clientId ?? null;
    this.isActive = false;
    this.pauseWhenOffline = options.pauseWhenOffline !== false;
    this.handleOnline = null;
    this.handleOffline = null;
    this.handleVisibilityChange = null;
    this.flushTimer = null;
  }

  async initialize() {
    const [state, outbox] = await Promise.all([
      this.storage.loadSyncState(),
      this.storage.loadOutbox(),
    ]);
    this.state = {
      clientId: state.clientId ?? "",
      lastServerSeq: Number.isFinite(state.lastServerSeq)
        ? Math.max(0, Math.floor(state.lastServerSeq))
        : 0,
      datasetGenerationKey: typeof state.datasetGenerationKey === "string" ? state.datasetGenerationKey : "",
    };
    if (!this.state.clientId) {
      this.state.clientId = this.defaultClientId || ensureActorId();
      await this.storage.persistSyncState(this.state);
    }
    this.outbox = Array.isArray(outbox) ? outbox : [];
  }

  async bootstrapIfNeeded(applyOps: (ops: SyncOp[]) => Promise<void>) {
    if (this.state.lastServerSeq > 0 && this.state.datasetGenerationKey) return;
    if (!applyOps) return;
    const response = await this.safeFetch(`${this.baseUrl}/sync/bootstrap`, {
      method: "GET",
    });
    if (!response) {
      return;
    }
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SyncBootstrapResponse;
    const hadDatasetGenerationKey = Boolean(this.state.datasetGenerationKey);
    if (!hadDatasetGenerationKey) {
      const datasetGenerationKey = parseDatasetGenerationKey(
        payload.datasetGenerationKey
      );
      if (datasetGenerationKey) {
        this.state.datasetGenerationKey = datasetGenerationKey;
        const nextSeq = parseServerSeq(payload.serverSeq);
        if (nextSeq >= this.state.lastServerSeq) {
          this.state.lastServerSeq = nextSeq;
        }
        await this.storage.persistSyncState(this.state);
        const snapshot =
          typeof payload.snapshot === "string" ? payload.snapshot : "";
        if (snapshot && this.onSnapshot) {
          await this.onSnapshot({ datasetGenerationKey, snapshot });
        }
      }
    }
    if (hadDatasetGenerationKey) {
      const resetApplied = await this.handleSnapshotResponse(payload);
      if (resetApplied) {
        return;
      }
    }
    const ops = Array.isArray(payload.ops) ? payload.ops : [];
    if (ops.length > 0) {
      await applyOps(ops);
    }
    const nextSeq = parseServerSeq(payload.serverSeq);
    if (nextSeq >= this.state.lastServerSeq) {
      this.state.lastServerSeq = nextSeq;
      await this.storage.persistSyncState(this.state);
    }
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this.bindOnlineListeners();
    this.bindVisibilityListener();
    if (this.pauseWhenOffline && !this.isOnline()) {
      return;
    }
    this.connectEvents();
  }

  stop() {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.disconnectEvents();
    this.isActive = false;
    this.unbindOnlineListeners();
    this.unbindVisibilityListener();
  }

  private isOnline(): boolean {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  }

  private bindOnlineListeners() {
    if (!this.pauseWhenOffline) return;
    if (typeof window === "undefined") return;
    if (this.handleOnline) return;

    this.handleOnline = () => {
      if (!this.isActive) return;
      this.disconnectEvents();
      void this.syncOnce();
      this.connectEvents();
    };

    this.handleOffline = () => {
      this.disconnectEvents();
    };

    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
  }

  private unbindOnlineListeners() {
    if (!this.handleOnline || !this.handleOffline) return;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    this.handleOnline = null;
    this.handleOffline = null;
  }

  private bindVisibilityListener() {
    if (typeof document === "undefined") return;
    if (this.handleVisibilityChange) return;

    this.handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && this.isActive) {
        void this.syncOnce();
      }
    };
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private unbindVisibilityListener() {
    if (!this.handleVisibilityChange) return;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.handleVisibilityChange = null;
  }

  private connectEvents() {
    if (this.eventSource) return;

    const url = `${this.baseUrl}/sync/events?datasetGenerationKey=${encodeURIComponent(this.state.datasetGenerationKey)}`;
    let es: EventSource;
    if (this.eventSourceFactory) {
      es = this.eventSourceFactory(url);
    } else if (typeof EventSource !== "undefined") {
      es = new EventSource(url);
    } else {
      return;
    }

    this.eventSource = es;
    this.eventSource.addEventListener("ops", () => {
      void this.syncOnce();
    });
    this.eventSource.addEventListener("open", () => {
      // Sync on connect and reconnect to catch up on missed ops.
      void this.syncOnce();
    });
  }

  private disconnectEvents() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  enqueueOps(scope: SyncScope, resourceId: string, ops: (ListsOperation | TaskListOperation)[]) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    const nextOps = ops.map((op) => ({
      scope,
      resourceId,
      actor: op.actor,
      clock: op.clock,
      payload: op,
    }));
    this.outbox.push(...nextOps);
    void this.storage.persistOutbox(this.outbox);
    if (this.isActive && (!this.pauseWhenOffline || this.isOnline())) {
      if (this.flushTimer != null) {
        clearTimeout(this.flushTimer);
      }
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushOnce();
      }, this.flushDebounceMs);
    }
  }

  async flushOnce() {
    this.syncQueue = this.syncQueue.then(() => this.flushOutbox(), () => this.flushOutbox());
    return this.syncQueue;
  }

  async syncOnce() {
    this.syncQueue = this.syncQueue.then(() => this.syncInternal(), () => this.syncInternal());
    return this.syncQueue;
  }

  private async syncInternal() {
    await this.flushOutbox();
    await this.pullRemoteOps();
  }

  private async flushOutbox() {
    if (this.outbox.length === 0) return;
    const sentOps = this.outbox.slice();
    const response = await this.safeFetch(`${this.baseUrl}/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.state.clientId,
        datasetGenerationKey: this.state.datasetGenerationKey ?? "",
        ops: sentOps,
      }),
    });
    if (!response) {
      return;
    }
    if (response.status === 409) {
      await this.handleSnapshotResponse(await response.json());
      return;
    }
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SyncPushResponse;
    if (payload.datasetGenerationKey) {
      this.state.datasetGenerationKey = payload.datasetGenerationKey;
    }
    const nextSeq = parseServerSeq(payload.serverSeq);
    if (nextSeq >= this.state.lastServerSeq) {
      this.state.lastServerSeq = nextSeq;
    }
    this.outbox = this.outbox.slice(sentOps.length);
    await this.storage.persistOutbox(this.outbox);
    await this.storage.persistSyncState(this.state);
  }

  private async pullRemoteOps() {
    const response = await this.safeFetch(
      `${this.baseUrl}/sync/pull?since=${this.state.lastServerSeq}&clientId=${encodeURIComponent(
        this.state.clientId
      )}&datasetGenerationKey=${encodeURIComponent(this.state.datasetGenerationKey ?? "")}`,
      { method: "GET" }
    );
    if (!response) {
      return;
    }
    if (response.status === 409) {
      await this.handleSnapshotResponse(await response.json());
      return;
    }
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SyncPullResponse;
    if (payload.datasetGenerationKey) {
      this.state.datasetGenerationKey = payload.datasetGenerationKey;
    }
    const nextSeq = parseServerSeq(payload.serverSeq);
    if (nextSeq >= this.state.lastServerSeq) {
      this.state.lastServerSeq = nextSeq;
      await this.storage.persistSyncState(this.state);
    }
    const ops = Array.isArray(payload.ops) ? payload.ops : [];
    if (ops.length > 0 && this.onRemoteOps) {
      await this.onRemoteOps(ops);
    }
  }

  async resetWithSnapshot(snapshot: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    if (!snapshot || typeof snapshot !== "string") {
      return { ok: false, error: "Snapshot payload is required." };
    }
    const datasetGenerationKey = crypto.randomUUID();
    const response = await this.safeFetch(`${this.baseUrl}/sync/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.state.clientId,
        datasetGenerationKey,
        snapshot,
      }),
    });
    if (!response) {
      return { ok: false, error: "Sync server is unavailable. Please try again." };
    }
    if (!response.ok) {
      const status = response.status;
      let message = "Failed to publish snapshot to the server.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload?.error) {
          message = payload.error;
        }
      } catch {
        try {
          const text = await response.text();
          if (text) {
            message = text;
          }
        } catch {}
      }
      if (status === 409) {
        message = "Server rejected the snapshot because the dataset generation key already exists.";
      }
      return { ok: false, error: message, status };
    }
    const payload = (await response.json()) as SyncPushResponse;
    this.state.datasetGenerationKey = payload.datasetGenerationKey ?? datasetGenerationKey;
    this.state.lastServerSeq = parseServerSeq(payload.serverSeq);
    this.outbox = [];
    await this.storage.persistOutbox(this.outbox);
    await this.storage.persistSyncState(this.state);
    return { ok: true };
  }

  private async handleSnapshotResponse(payload: SyncPullResponse) {
    const datasetGenerationKey = parseDatasetGenerationKey(payload?.datasetGenerationKey);
    const snapshot = typeof payload?.snapshot === "string" ? payload.snapshot : "";
    if (!datasetGenerationKey) {
      return false;
    }
    const changed = datasetGenerationKey !== this.state.datasetGenerationKey;
    if (changed) {
      this.state.datasetGenerationKey = datasetGenerationKey;
      this.state.lastServerSeq = parseServerSeq(payload?.serverSeq);
      this.outbox = [];
      await this.storage.persistOutbox(this.outbox);
      await this.storage.persistSyncState(this.state);
    }
    if (!snapshot || !this.onSnapshot || !changed) {
      return false;
    }
    await this.onSnapshot({ datasetGenerationKey, snapshot });
    return true;
  }

  private async safeFetch(
    url: string,
    init: RequestInit
  ): Promise<Response | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status === 401 && typeof window !== "undefined") {
        try {
          window.location.assign("/auth/login");
        } catch {}
      }
      return response;
    } catch (err) {
      clearTimeout(timeout);
      this.onConnectionError?.(err);
      return null;
    }
  }
}

function parseServerSeq(value: unknown) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function parseDatasetGenerationKey(value: unknown) {
  return typeof value === "string" && value.length ? value : "";
}
