import { ensureActorId, LamportClock } from "./ids.js";
import {
  between,
  clonePosition,
  comparePositions,
  normalizePosition,
} from "./position.js";
import type {
  EntryVersions,
  OrderedSetEntry,
  OrderedSetSnapshot,
  Position,
  Version,
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
    ? Math.floor(operation?.clock as number)
    : 0;
  return `${actor}:${clock}`;
}

/**
 * Total order over writes: Lamport clock first, then actor id. Plain clock
 * comparison is not enough because two replicas commonly produce operations with
 * the same clock while partitioned. Without the actor tie-break each replica
 * keeps its own write (both reject the other as not newer) and they
 * never converge.
 */
function compareWrites(
  leftClock: number | null | undefined,
  leftActor: string | null | undefined,
  rightClock: number | null | undefined,
  rightActor: string | null | undefined
) {
  const left = Number.isFinite(leftClock) ? Math.floor(leftClock as number) : 0;
  const right = Number.isFinite(rightClock)
    ? Math.floor(rightClock as number)
    : 0;
  if (left !== right) return left < right ? -1 : 1;
  const leftId = typeof leftActor === "string" ? leftActor : "";
  const rightId = typeof rightActor === "string" ? rightActor : "";
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
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

const NO_WRITE: Version = { clock: 0, actor: "" };

function sanitizeVersion(value: unknown): Version {
  const version = value as Partial<Version> | null | undefined;
  return {
    clock: Number.isFinite(version?.clock) ? Math.floor(version!.clock as number) : 0,
    actor: typeof version?.actor === "string" ? version.actor : "",
  };
}

function cloneVersions(versions: EntryVersions): EntryVersions {
  return {
    position: { ...versions.position },
    existence: { ...versions.existence },
    fields: Object.fromEntries(
      Object.entries(versions.fields).map(([field, version]) => [field, { ...version }])
    ),
  };
}

/** Whether a write wins over the one that set a part of an item. */
function wins(clock: number, actor: string, version: Version = NO_WRITE) {
  return compareWrites(clock, actor, version.clock, version.actor) > 0;
}

type ItemRecord<TData> = {
  id: string;
  pos: Position;
  data: TData;
  versions: EntryVersions;
  deletedAt: number | null;
};

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
  items: Map<string, ItemRecord<TData>>;
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
    _context: { existingData?: TData } = {}
  ) {
    if (!data || typeof data !== "object") return {} as Partial<TData>;
    return { ...data };
  }

  sanitizeUpdatePayload(
    data?: Partial<TData>,
    _context: { existingData?: TData } = {}
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

  sanitizeSnapshotEntry(entry: OrderedSetEntry<TData>): ItemRecord<TData> | null {
    if (!entry || typeof entry.id !== "string" || !entry.id.length) return null;
    const pos = normalizePosition(entry.pos);
    if (!pos.length) return null;
    const data = this.sanitizeSnapshotData(entry.data);
    return {
      id: entry.id,
      pos: pos as Position,
      data: data as TData,
      versions: {
        position: sanitizeVersion(entry.versions?.position),
        existence: sanitizeVersion(entry.versions?.existence),
        fields: Object.fromEntries(
          Object.keys(data ?? {}).map((field) => [
            field,
            sanitizeVersion(entry.versions?.fields?.[field]),
          ])
        ),
      },
      deletedAt: Number.isFinite(entry.deletedAt)
        ? Math.floor(entry.deletedAt as number)
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

  /** An item as callers see it, sharing nothing with the stored record. */
  private toEntry(record: ItemRecord<TData>): OrderedSetEntry<TData> {
    return {
      id: record.id,
      pos: clonePosition(record.pos),
      data: this.cloneData(record.data),
      versions: cloneVersions(record.versions),
      deletedAt: record.deletedAt,
    };
  }

  getItem(id: string): OrderedSetEntry<TData> | null {
    const record = this.items.get(id);
    return record ? this.toEntry(record) : null;
  }

  getSnapshot(options: { includeDeleted?: boolean } = {}): OrderedSetSnapshot<TData> {
    const includeDeleted = Boolean(options.includeDeleted);
    if (!includeDeleted && Array.isArray(this._snapshotCache)) {
      return this._snapshotCache.map((entry) => ({
        ...entry,
        pos: clonePosition(entry.pos),
        data: this.cloneData(entry.data),
        versions: cloneVersions(entry.versions!),
      }));
    }

    const entries = Array.from(this.items.values())
      .filter((record) => includeDeleted || record.deletedAt == null)
      .sort(
        (a, b) =>
          comparePositions(a.pos, b.pos) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      )
      .map((record) => this.toEntry(record));

    if (!includeDeleted) {
      this._snapshotCache = entries.map((entry) => ({
        ...entry,
        pos: clonePosition(entry.pos),
        data: this.cloneData(entry.data),
        versions: cloneVersions(entry.versions!),
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
        versions: {
          position: { clock, actor: operation.actor },
          existence: { clock, actor: operation.actor },
          fields: Object.fromEntries(
            Object.keys(payloadData).map((field) => [field, { clock, actor: operation.actor }])
          ),
        },
        deletedAt: null,
      });
      return true;
    }

    // Position and content are independent registers: a completion must not
    // suppress a concurrent move, regardless of which operation arrives first.
    const winsPosition = wins(clock, operation.actor, existing.versions.position);
    let mutated = false;

    // Only an insert that wins the write race may move an existing item. Older
    // creates replayed during bootstrap must not undo a newer move.
    if (position.length && winsPosition) {
      const samePosition = comparePositions(position, existing.pos) === 0;
      if (!samePosition) {
        existing.pos = position;
        mutated = true;
      }
      existing.versions.position = { clock, actor: operation.actor };
      mutated = true;
    }

    // Whether the item exists is a part of its own: the latest insert or
    // removal decides it, in whatever order they arrive.
    if (wins(clock, operation.actor, existing.versions.existence)) {
      existing.versions.existence = { clock, actor: operation.actor };
      if (existing.deletedAt != null) {
        existing.deletedAt = null;
        mutated = true;
      }
    }

    const winningData: Partial<TData> = {};
    for (const [field, value] of Object.entries(payloadData)) {
      if (!wins(clock, operation.actor, existing.versions.fields[field])) continue;
      (winningData as Record<string, unknown>)[field] = value;
      existing.versions.fields[field] = { clock, actor: operation.actor };
      mutated = true;
    }
    if (Object.keys(winningData).length > 0) {
      const merged = this.mergeInsertData(existing.data, winningData);
      if (!this.areDataEqual(existing.data, merged)) {
        existing.data = merged;
        mutated = true;
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
    if (!wins(clock, operation.actor, record.versions.existence)) return false;
    record.versions.existence = { clock, actor: operation.actor };
    record.deletedAt = clock;
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
    if (!wins(clock, operation.actor, record.versions.position)) return false;
    if (comparePositions(position, record.pos) !== 0) record.pos = position;
    record.versions.position = { clock, actor: operation.actor };
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
    const updatePayload = this.sanitizeUpdatePayload(operation.payload?.data, {
      existingData: record.data,
    });
    if (!updatePayload || Object.keys(updatePayload).length === 0) {
      return false;
    }
    const winningData: Partial<TData> = {};
    for (const [field, value] of Object.entries(updatePayload)) {
      if (!wins(clock, operation.actor, record.versions.fields[field])) continue;
      (winningData as Record<string, unknown>)[field] = value;
      record.versions.fields[field] = { clock, actor: operation.actor };
    }
    if (Object.keys(winningData).length === 0) return false;
    const merged = this.mergeUpdateData(record.data, winningData);
    if (!this.areDataEqual(record.data, merged)) record.data = merged;
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
