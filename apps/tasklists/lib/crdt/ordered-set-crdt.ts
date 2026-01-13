import { ensureActorId, LamportClock } from "./ids.js";
import {
  between,
  clonePosition,
  comparePositions,
  normalizePosition,
} from "./position.js";
import type {
  OrderedSetEntry,
  OrderedSetSnapshot,
  Position,
} from "../../types/domain.js";
import type {
  OrderedSetExport,
  OrderedSetOperation,
} from "../../types/crdt.js";

export const ORDERED_SET_OPERATIONS = {
  insert: "insert",
  remove: "remove",
  move: "move",
  update: "update",
} as const;

function makeOperationKey(operation: { actor?: string; clock?: number }) {
  const actor = typeof operation?.actor === "string" ? operation.actor : "";
  const clock = Number.isFinite(operation?.clock)
    ? Math.floor(operation.clock)
    : 0;
  return `${actor}:${clock}`;
}

function shallowClone<T>(value: T): T {
  if (value == null) return value as T;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value) as T;
    } catch (err) {
      // Fallback to manual clone.
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => shallowClone(entry)) as T;
  }
  if (typeof value === "object") {
    return { ...(value as Record<string, unknown>) } as T;
  }
  return value;
}

function shallowEqual(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    if ((a || {})[key] !== (b || {})[key]) {
      return false;
    }
  }
  return true;
}

/**
 * OrderedSetCRDT tracks a position-aware set of records that replicates across peers
 * using Lamport-clocked operations. Callers typically:
 *   1. Construct an instance (optionally injecting an actor id / Lamport clock) and,
 *      when resuming from storage, hydrate state with `importRecords`.
 *   2. Perform local mutations through the `generate*` helpers. These advance the local
 *      Lamport clock, apply the mutation immediately, and return the operation alongside
 *      the new snapshot so the op can be persisted or broadcast.
 *   3. Feed remote (or locally generated) operations back through `applyOperation`.
 *      The method dispatches into the `apply*` routines, using Lamport ordering and the
 *      seen-op cache to keep applications idempotent and commutative.
 *
 * The `apply*` methods remain public because replication layers, tests, and storage
 * consumers occasionally need to replay a single operation type directly (e.g. when
 * rebuilding state from a log). They share the same validation path used by the
 * higher-level helpers, so treating them as public API keeps the replication contract
 * explicit while avoiding duplicate logic.
 */
export class OrderedSetCRDT<TData extends Record<string, unknown> = Record<string, unknown>> {
  actorId: string;
  clock: LamportClock;
  items: Map<string, OrderedSetEntry<TData>>;
  seenOps: Set<string>;
  _snapshotCache: OrderedSetSnapshot<TData> | null;

  constructor(options: { actorId?: string; clock?: LamportClock; identityOptions?: { storageKey?: string; storage?: Storage } } = {}) {
    this.actorId = options.actorId ?? ensureActorId(options.identityOptions);
    this.clock =
      options.clock instanceof LamportClock
        ? options.clock
        : new LamportClock();
    this.items = new Map();
    this.seenOps = new Set();
    this._snapshotCache = null;
  }

  getClockValue() {
    return this.clock.value();
  }

  invalidateSnapshotCache() {
    this._snapshotCache = null;
  }

  sanitizeInsertPayload(
    data?: Partial<TData>,
    context: { existingData?: TData } = {}
  ) {
    if (!data || typeof data !== "object") return {} as Partial<TData>;
    return { ...data };
  }

  sanitizeUpdatePayload(
    data?: Partial<TData>,
    context: { existingData?: TData } = {}
  ) {
    if (!data || typeof data !== "object") return {} as Partial<TData>;
    return { ...data };
  }

  sanitizeSnapshotData(data: TData): TData {
    return this.cloneData(data);
  }

  cloneData<T extends Partial<TData>>(data: T): T {
    return shallowClone(data);
  }

  mergeInsertData(existingData: TData, insertData: Partial<TData>): TData {
    return this.mergeUpdateData(existingData, insertData);
  }

  mergeUpdateData(existingData: TData, updateData: Partial<TData>): TData {
    return { ...(existingData || {}), ...(updateData || {}) } as TData;
  }

  areDataEqual(a: TData, b: TData) {
    return shallowEqual(a, b);
  }

  sanitizeSnapshotEntry(entry: OrderedSetEntry<TData>) {
    if (!entry || typeof entry.id !== "string" || !entry.id.length) return null;
    const pos = normalizePosition(entry.pos);
    if (!pos.length) return null;
    const data = this.sanitizeSnapshotData(entry.data);
    return {
      id: entry.id,
      pos: pos as Position,
      data: data as TData,
      createdAt: Number.isFinite(entry.createdAt)
        ? Math.floor(entry.createdAt)
        : 0,
      updatedAt: Number.isFinite(entry.updatedAt)
        ? Math.floor(entry.updatedAt)
        : 0,
      deletedAt: Number.isFinite(entry.deletedAt)
        ? Math.floor(entry.deletedAt)
        : null,
    };
  }

  importRecords(entries: OrderedSetSnapshot<TData> = []) {
    this.items.clear();
    this.seenOps.clear();
    entries.forEach((entry) => {
      const record = this.sanitizeSnapshotEntry(entry);
      if (record) {
        this.items.set(record.id, record);
      }
    });
    this.invalidateSnapshotCache();
  }

  getItem(id: string): OrderedSetEntry<TData> | null {
    const record = this.items.get(id);
    if (!record) return null;
    return {
      id: record.id,
      pos: clonePosition(record.pos),
      data: this.cloneData(record.data),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    };
  }

  getSnapshot(options: { includeDeleted?: boolean } = {}): OrderedSetSnapshot<TData> {
    const includeDeleted = Boolean(options.includeDeleted);
    if (!includeDeleted && Array.isArray(this._snapshotCache)) {
      return this._snapshotCache.map((item) => ({
        ...item,
        pos: clonePosition(item.pos),
        data: this.cloneData(item.data),
      }));
    }

    const records = Array.from(this.items.values());
    const entries = records
      .filter((record) => includeDeleted || record.deletedAt == null)
      .map((record) => ({
        id: record.id,
        pos: clonePosition(record.pos),
        data: this.cloneData(record.data),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
      }))
      .sort((a, b) => comparePositions(a.pos, b.pos));

    if (!includeDeleted) {
      this._snapshotCache = entries.map((item) => ({
        id: item.id,
        pos: clonePosition(item.pos),
        data: this.cloneData(item.data),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        deletedAt: item.deletedAt,
      }));
    }

    return entries;
  }

  exportState(): OrderedSetExport<TData> {
    return {
      clock: this.getClockValue(),
      entries: this.getSnapshot({ includeDeleted: true }),
    };
  }

  applyOperation(operation: OrderedSetOperation<TData>) {
    if (!operation || typeof operation !== "object") return false;
    const opKey = makeOperationKey(operation);
    if (this.seenOps.has(opKey)) {
      return false;
    }

    const clock = Number.isFinite(operation.clock)
      ? Math.floor(operation.clock)
      : 0;
    if (clock > 0) {
      this.clock.merge(clock);
    }

    let changed = false;
    switch (operation.type) {
      case ORDERED_SET_OPERATIONS.insert:
        changed = this.applyInsert(operation);
        break;
      case ORDERED_SET_OPERATIONS.remove:
        changed = this.applyRemove(operation);
        break;
      case ORDERED_SET_OPERATIONS.move:
        changed = this.applyMove(operation);
        break;
      case ORDERED_SET_OPERATIONS.update:
        changed = this.applyUpdate(operation);
        break;
      default:
        changed = false;
    }

    this.seenOps.add(opKey);
    if (changed) {
      this.invalidateSnapshotCache();
    }
    return changed;
  }

  applyInsert(operation: OrderedSetOperation<TData>) {
    const itemId = operation.itemId;
    if (typeof itemId !== "string" || !itemId.length) return false;
    // Look up the existing record so the insert can revive tombstones,
    // merge concurrent payload data, or avoid duplicating an item that
    // already exists.
    const existing = this.items.get(itemId);
    const position = normalizePosition(operation.payload?.pos);
    if (!position.length && !existing) return false;
    const clock = Number.isFinite(operation.clock)
      ? Math.floor(operation.clock)
      : 0;
    const payloadData = this.sanitizeInsertPayload(operation.payload?.data, {
      existingData: existing?.data,
    }) as TData;

    if (!existing) {
      this.items.set(itemId, {
        id: itemId,
        pos: position.length
          ? position
          : between(null, null, { actor: this.actorId }),
        data: payloadData,
        createdAt: clock,
        updatedAt: clock,
        deletedAt: null,
      });
      return true;
    }

    let mutated = false;

    if (position.length) {
      const samePosition = comparePositions(position, existing.pos) === 0;
      if (!samePosition) {
        existing.pos = position;
        mutated = true;
      }
    }

    if (existing.deletedAt != null && clock > existing.deletedAt) {
      existing.deletedAt = null;
      mutated = true;
    }

    if (clock > existing.updatedAt) {
      const merged = this.mergeInsertData(existing.data, payloadData);
      if (!this.areDataEqual(existing.data, merged)) {
        existing.data = merged;
        mutated = true;
      }
      if (mutated) {
        existing.updatedAt = clock;
      }
    }

    return mutated;
  }

  applyRemove(operation: OrderedSetOperation<TData>) {
    const itemId = operation.itemId;
    if (typeof itemId !== "string" || !itemId.length) return false;
    const record = this.items.get(itemId);
    if (!record) return false;
    const clock = Number.isFinite(operation.clock)
      ? Math.floor(operation.clock)
      : 0;
    if (record.deletedAt != null && clock <= record.deletedAt) return false;
    record.deletedAt = clock;
    if (clock > record.updatedAt) {
      record.updatedAt = clock;
    }
    return true;
  }

  applyMove(operation: OrderedSetOperation<TData>) {
    const itemId = operation.itemId;
    if (typeof itemId !== "string" || !itemId.length) return false;
    const record = this.items.get(itemId);
    if (!record || record.deletedAt != null) return false;
    const position = normalizePosition(operation.payload?.pos);
    if (!position.length) return false;
    const clock = Number.isFinite(operation.clock)
      ? Math.floor(operation.clock)
      : 0;
    if (clock <= record.updatedAt) return false;
    if (comparePositions(position, record.pos) === 0) {
      return false;
    }
    record.pos = position;
    record.updatedAt = clock;
    return true;
  }

  applyUpdate(operation: OrderedSetOperation<TData>) {
    const itemId = operation.itemId;
    if (typeof itemId !== "string" || !itemId.length) return false;
    const record = this.items.get(itemId);
    if (!record || record.deletedAt != null) return false;
    const clock = Number.isFinite(operation.clock)
      ? Math.floor(operation.clock)
      : 0;
    if (clock <= record.updatedAt) return false;
    const updatePayload = this.sanitizeUpdatePayload(operation.payload?.data, {
      existingData: record.data,
    });
    if (!updatePayload || Object.keys(updatePayload).length === 0) {
      return false;
    }
    const merged = this.mergeUpdateData(record.data, updatePayload);
    if (this.areDataEqual(record.data, merged)) {
      return false;
    }
    record.data = merged;
    record.updatedAt = clock;
    return true;
  }

  nextClock(remoteTime?: number) {
    return this.clock.tick(remoteTime);
  }

  ensurePositionBetween(leftId?: string | null, rightId?: string | null) {
    const left = leftId ? this.items.get(leftId) : null;
    const right = rightId ? this.items.get(rightId) : null;
    const leftPos = left ? left.pos : null;
    const rightPos = right ? right.pos : null;
    return between(leftPos, rightPos, { actor: this.actorId });
  }

  generateInsert(options: {
    itemId: string;
    data?: Partial<TData>;
    position?: Position | null;
    afterId?: string | null;
    beforeId?: string | null;
  }) {
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    if (!itemId) {
      throw new Error("generateInsert requires an itemId");
    }
    const position =
      options.position && normalizePosition(options.position).length
        ? normalizePosition(options.position)
        : this.ensurePositionBetween(options.afterId, options.beforeId);
    const payloadData = this.sanitizeInsertPayload(options.data) as TData;
    const clock = this.nextClock();
    const op = {
      type: ORDERED_SET_OPERATIONS.insert,
      itemId,
      payload: {
        data: this.cloneData(payloadData),
        pos: clonePosition(position),
      },
      clock,
      actor: this.actorId,
    };
    this.applyOperation(op);
    return { op, snapshot: this.getSnapshot() };
  }

  generateUpdate(options: { itemId: string; data: Partial<TData> }) {
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    if (!itemId) {
      throw new Error("generateUpdate requires an itemId");
    }
    if (!this.items.has(itemId)) {
      throw new Error(`Cannot update missing item "${itemId}"`);
    }
    const payloadData = this.sanitizeUpdatePayload(options.data, {
      existingData: this.items.get(itemId)?.data,
    });
    if (!payloadData || Object.keys(payloadData).length === 0) {
      throw new Error("generateUpdate requires at least one data field");
    }
    const clock = this.nextClock();
    const op = {
      type: ORDERED_SET_OPERATIONS.update,
      itemId,
      payload: {
        data: this.cloneData(payloadData),
      },
      clock,
      actor: this.actorId,
    };
    this.applyOperation(op);
    return { op, snapshot: this.getSnapshot() };
  }

  generateMove(options: {
    itemId: string;
    position?: Position | null;
    afterId?: string | null;
    beforeId?: string | null;
  }) {
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    if (!itemId) {
      throw new Error("generateMove requires an itemId");
    }
    if (!this.items.has(itemId)) {
      throw new Error(`Cannot move missing item "${itemId}"`);
    }
    const position =
      options.position && normalizePosition(options.position).length
        ? normalizePosition(options.position)
        : this.ensurePositionBetween(options.afterId, options.beforeId);
    const clock = this.nextClock();
    const op = {
      type: ORDERED_SET_OPERATIONS.move,
      itemId,
      payload: {
        pos: clonePosition(position),
      },
      clock,
      actor: this.actorId,
    };
    this.applyOperation(op);
    return { op, snapshot: this.getSnapshot() };
  }

  generateRemove(itemId: string) {
    if (typeof itemId !== "string" || !this.items.has(itemId)) {
      throw new Error(`Cannot remove missing item "${itemId}"`);
    }
    const clock = this.nextClock();
    const op = {
      type: ORDERED_SET_OPERATIONS.remove,
      itemId,
      clock,
      actor: this.actorId,
    };
    this.applyOperation(op);
    return { op, snapshot: this.getSnapshot() };
  }
}
