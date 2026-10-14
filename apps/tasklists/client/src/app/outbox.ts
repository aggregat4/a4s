import type { ListsOperation, TaskListOperation } from "../types/crdt.js";
import type { ListStorage } from "../types/storage.js";
import type { SyncOp, SyncScope } from "../types/sync.js";

/**
 * This device's operations that the sync server has not confirmed yet, kept
 * in storage so they survive a restart and a time without sync.
 *
 * It is the only writer of the stored outbox. Each change here saves the
 * whole outbox, after the saves before it, so what is stored always ends up
 * as the outbox here is. Two writers that each saved a copy of their own
 * overwrote each other's operations, as when sync turned on while a change
 * was being saved.
 */
export class Outbox {
  private ops: SyncOp[];
  private loading: Promise<void> | null;
  private saving: Promise<void>;

  constructor(private readonly storage: ListStorage) {
    this.ops = [];
    this.loading = null;
    this.saving = Promise.resolve();
  }

  /** Reads the stored outbox, once; operations added before then come after it. */
  load() {
    this.loading ??= this.storage.loadOutbox().then((stored) => {
      this.ops = [...(Array.isArray(stored) ? stored : []), ...this.ops];
    });
    return this.loading;
  }

  get size() {
    return this.ops.length;
  }

  /** The operations not confirmed yet, oldest first. */
  pending() {
    return this.ops.slice();
  }

  /** Adds local operations on a list, or on the registry. */
  add(scope: SyncScope, resourceId: string, ops: (ListsOperation | TaskListOperation)[]) {
    const added: SyncOp[] = ops
      .map((op) => ({ scope, resourceId, actor: op.actor, clock: op.clock, payload: op }))
      .filter(
        (op) =>
          typeof op.actor === "string" &&
          op.actor.length > 0 &&
          Number.isFinite(op.clock) &&
          op.clock > 0
      );
    if (added.length === 0) return this.saved();
    this.ops.push(...added);
    return this.save();
  }

  /** Drops operations the server confirmed; ones added since stay. */
  confirm(sent: SyncOp[]) {
    const confirmed = new Set(sent);
    this.ops = this.ops.filter((op) => !confirmed.has(op));
    return this.save();
  }

  clear() {
    this.ops = [];
    return this.save();
  }

  /** Settles once everything so far is stored. */
  saved() {
    return this.saving;
  }

  private save() {
    const next = this.saving
      .catch(() => {})
      .then(() => this.load())
      .then(() => this.storage.persistOutbox(this.ops.slice()));
    this.saving = next;
    return next;
  }
}
