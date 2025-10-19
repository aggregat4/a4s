import { ensureActorId, LamportClock } from "./ids.js";
import { between, clonePosition, comparePositions, normalizePosition } from "./position.js";

export const ORDERED_SET_OPERATIONS = {
    insert: "insert",
    remove: "remove",
    move: "move",
    update: "update",
};

function makeOperationKey(operation) {
    const actor = typeof operation?.actor === "string" ? operation.actor : "";
    const clock = Number.isFinite(operation?.clock) ? Math.floor(operation.clock) : 0;
    return `${actor}:${clock}`;
}

function shallowClone(value) {
    if (value == null) return {};
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(value);
        } catch (err) {
            // Fallback to manual clone.
        }
    }
    if (Array.isArray(value)) {
        return value.map((entry) => shallowClone(entry));
    }
    if (typeof value === "object") {
        return { ...value };
    }
    return value;
}

function shallowEqual(a = {}, b = {}) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const key of keys) {
        if ((a || {})[key] !== (b || {})[key]) {
            return false;
        }
    }
    return true;
}

export class OrderedSetCRDT {
    constructor(options = {}) {
        this.actorId = options.actorId ?? ensureActorId(options.identityOptions);
        this.clock = options.clock instanceof LamportClock ? options.clock : new LamportClock();
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

    sanitizeInsertPayload(data, context = {}) {
        if (!data || typeof data !== "object") return {};
        return { ...data };
    }

    sanitizeUpdatePayload(data, context = {}) {
        if (!data || typeof data !== "object") return {};
        return { ...data };
    }

    sanitizeSnapshotData(data) {
        return this.cloneData(data);
    }

    cloneData(data) {
        return shallowClone(data);
    }

    mergeInsertData(existingData, insertData) {
        return this.mergeUpdateData(existingData, insertData);
    }

    mergeUpdateData(existingData, updateData) {
        return { ...(existingData || {}), ...(updateData || {}) };
    }

    areDataEqual(a, b) {
        return shallowEqual(a, b);
    }

    sanitizeSnapshotEntry(entry) {
        if (!entry || typeof entry.id !== "string" || !entry.id.length) return null;
        const pos = normalizePosition(entry.pos);
        if (!pos.length) return null;
        const data = this.sanitizeSnapshotData(entry.data);
        return {
            id: entry.id,
            pos,
            data,
            createdAt: Number.isFinite(entry.createdAt) ? Math.floor(entry.createdAt) : 0,
            updatedAt: Number.isFinite(entry.updatedAt) ? Math.floor(entry.updatedAt) : 0,
            deletedAt: Number.isFinite(entry.deletedAt) ? Math.floor(entry.deletedAt) : null,
        };
    }

    importRecords(entries = []) {
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

    getItem(id) {
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

    getSnapshot(options = {}) {
        const includeDeleted = Boolean(options.includeDeleted);
        if (!includeDeleted && Array.isArray(this._snapshotCache)) {
            return this._snapshotCache.map((item) => ({
                ...item,
                pos: clonePosition(item.pos),
                data: this.cloneData(item.data),
            }));
        }

        const entries = Array.from(this.items.values())
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

    exportState() {
        return {
            clock: this.getClockValue(),
            entries: this.getSnapshot({ includeDeleted: true }),
        };
    }

    applyOperation(operation) {
        if (!operation || typeof operation !== "object") return false;
        const opKey = makeOperationKey(operation);
        if (this.seenOps.has(opKey)) {
            return false;
        }

        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
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

    applyInsert(operation) {
        const itemId = operation.itemId;
        if (typeof itemId !== "string" || !itemId.length) return false;
        const existing = this.items.get(itemId);
        const position = normalizePosition(operation.payload?.pos);
        if (!position.length && !existing) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        const payloadData = this.sanitizeInsertPayload(operation.payload?.data, {
            existingData: existing?.data,
        });

        if (!existing) {
            this.items.set(itemId, {
                id: itemId,
                pos: position.length ? position : between(null, null, { actor: this.actorId }),
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

    applyRemove(operation) {
        const itemId = operation.itemId;
        if (typeof itemId !== "string" || !itemId.length) return false;
        const record = this.items.get(itemId);
        if (!record) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (record.deletedAt != null && clock <= record.deletedAt) return false;
        record.deletedAt = clock;
        if (clock > record.updatedAt) {
            record.updatedAt = clock;
        }
        return true;
    }

    applyMove(operation) {
        const itemId = operation.itemId;
        if (typeof itemId !== "string" || !itemId.length) return false;
        const record = this.items.get(itemId);
        if (!record || record.deletedAt != null) return false;
        const position = normalizePosition(operation.payload?.pos);
        if (!position.length) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (clock <= record.updatedAt) return false;
        if (comparePositions(position, record.pos) === 0) {
            return false;
        }
        record.pos = position;
        record.updatedAt = clock;
        return true;
    }

    applyUpdate(operation) {
        const itemId = operation.itemId;
        if (typeof itemId !== "string" || !itemId.length) return false;
        const record = this.items.get(itemId);
        if (!record || record.deletedAt != null) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
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

    nextClock(remoteTime) {
        return this.clock.tick(remoteTime);
    }

    ensurePositionBetween(leftId, rightId) {
        const left = leftId ? this.items.get(leftId) : null;
        const right = rightId ? this.items.get(rightId) : null;
        const leftPos = left ? left.pos : null;
        const rightPos = right ? right.pos : null;
        return between(leftPos, rightPos, { actor: this.actorId });
    }

    generateInsert(options = {}) {
        const itemId = typeof options.itemId === "string" ? options.itemId : null;
        if (!itemId) {
            throw new Error("generateInsert requires an itemId");
        }
        const position =
            options.position && normalizePosition(options.position).length
                ? normalizePosition(options.position)
                : this.ensurePositionBetween(options.afterId, options.beforeId);
        const payloadData = this.sanitizeInsertPayload(options.data);
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

    generateUpdate(options = {}) {
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

    generateMove(options = {}) {
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

    generateRemove(itemId) {
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
