import { ensureActorId } from "../domain/crdt/ids.js";
import type { ListStorage } from "../types/storage.js";
import type { SyncOp, SyncScope, SyncState } from "../types/sync.js";
import type { ListsOperation, TaskListOperation } from "../types/crdt.js";

type FetchFn = typeof fetch;

type SyncEngineOptions = {
  storage: ListStorage;
  baseUrl: string;
  pollIntervalMs?: number;
  fetchFn?: FetchFn;
  onRemoteOps?: (ops: SyncOp[]) => Promise<void> | void;
  clientId?: string;
};

type SyncPushResponse = {
  serverSeq?: number;
};

type SyncPullResponse = {
  serverSeq?: number;
  ops?: SyncOp[];
};

type SyncBootstrapResponse = SyncPullResponse;

const DEFAULT_POLL_INTERVAL_MS = 2000;

export class SyncEngine {
  private storage: ListStorage;
  private baseUrl: string;
  private pollIntervalMs: number;
  private fetchFn: FetchFn;
  private onRemoteOps: ((ops: SyncOp[]) => Promise<void> | void) | null;
  private state: SyncState;
  private outbox: SyncOp[];
  private timer: ReturnType<typeof setTimeout> | null;
  private isPolling: boolean;
  private isActive: boolean;
  private syncQueue: Promise<void>;
  private defaultClientId: string | null;

  constructor(options: SyncEngineOptions) {
    this.storage = options.storage;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.pollIntervalMs =
      typeof options.pollIntervalMs === "number" && options.pollIntervalMs > 0
        ? Math.floor(options.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS;
    this.fetchFn =
      options.fetchFn ?? globalThis.fetch?.bind(globalThis);
    this.onRemoteOps = options.onRemoteOps ?? null;
    this.state = { clientId: "", lastServerSeq: 0 };
    this.outbox = [];
    this.timer = null;
    this.syncQueue = Promise.resolve();
    this.defaultClientId = options.clientId ?? null;
    this.isPolling = false;
    this.isActive = false;
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
    };
    if (!this.state.clientId) {
      this.state.clientId = this.defaultClientId || ensureActorId();
      await this.storage.persistSyncState(this.state);
    }
    this.outbox = Array.isArray(outbox) ? outbox : [];
  }

  async bootstrapIfNeeded(applyOps: (ops: SyncOp[]) => Promise<void>) {
    if (this.outbox.length > 0) return;
    if (this.state.lastServerSeq > 0) return;
    if (!applyOps) return;
    const response = await this.fetchFn(`${this.baseUrl}/sync/bootstrap`, {
      method: "GET",
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SyncBootstrapResponse;
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
    if (this.timer != null) return;
    this.isActive = true;
    void this.poll();
  }

  stop() {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.isActive = false;
  }

  private async poll() {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      await this.syncOnce();
    } finally {
      this.isPolling = false;
      if (!this.isActive) {
        return;
      }
      if (this.timer != null) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => {
        void this.poll();
      }, this.pollIntervalMs);
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
    const response = await this.fetchFn(`${this.baseUrl}/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: this.state.clientId, ops: this.outbox }),
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SyncPushResponse;
    parseServerSeq(payload.serverSeq);
    this.outbox = [];
    await this.storage.persistOutbox(this.outbox);
  }

  private async pullRemoteOps() {
    const response = await this.fetchFn(
      `${this.baseUrl}/sync/pull?since=${this.state.lastServerSeq}&clientId=${encodeURIComponent(
        this.state.clientId
      )}`,
      { method: "GET" }
    );
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as SyncPullResponse;
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
}

function parseServerSeq(value: unknown) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}
