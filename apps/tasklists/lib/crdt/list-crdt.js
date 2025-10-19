import { ensureActorId, LamportClock } from "./ids.js";
import {
    between,
    clonePosition,
    comparePositions,
    normalizePosition,
    positionToKey,
} from "./position.js";

const OP_TYPES = {
    insert: "insert",
    remove: "remove",
    move: "move",
    update: "update",
    renameList: "renameList",
};

function sanitizeText(text) {
    return typeof text === "string" ? text : "";
}

function sanitizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
}

function makeOperationKey(op) {
    const actor = typeof op?.actor === "string" ? op.actor : "";
    const clock = Number.isFinite(op?.clock) ? Math.floor(op.clock) : 0;
    return `${actor}:${clock}`;
}

function cloneItemRecord(record) {
    return {
        id: record.id,
        pos: clonePosition(record.pos),
        text: record.text,
        done: record.done,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
    };
}

function sortByPositionAscending(left, right) {
    return comparePositions(left.pos, right.pos);
}

export class ListCRDT {
    constructor(options = {}) {
        this.actorId = options.actorId ?? ensureActorId(options.identityOptions);
        this.clock = options.clock instanceof LamportClock ? options.clock : new LamportClock();
        this.items = new Map();
        this.seenOps = new Set();
        this.title = sanitizeText(options.title);
        this.titleUpdatedAt = 0;
        this.lastSnapshotCache = null;
    }

    /**
     * Resets the current CRDT to a specific snapshot (used when loading persisted state).
     * Snapshot items should already include positions.
     */
    resetFromSnapshot(snapshot = [], metadata = {}) {
        this.items.clear();
        if (Array.isArray(snapshot)) {
            snapshot.forEach((item) => {
                if (!item || typeof item.id !== "string") return;
                const pos = normalizePosition(item.pos);
                if (!pos.length) return;
                this.items.set(item.id, {
                    id: item.id,
                    pos,
                    text: sanitizeText(item.text),
                    done: sanitizeBoolean(item.done, false),
                    createdAt: Number.isFinite(item.createdAt) ? Math.floor(item.createdAt) : 0,
                    updatedAt: Number.isFinite(item.updatedAt) ? Math.floor(item.updatedAt) : 0,
                    deletedAt: Number.isFinite(item.deletedAt)
                        ? Math.floor(item.deletedAt)
                        : null,
                });
            });
        }
        if (typeof metadata.title === "string") {
            this.title = metadata.title;
        }
        if (Number.isFinite(metadata.titleUpdatedAt)) {
            this.titleUpdatedAt = Math.floor(metadata.titleUpdatedAt);
        }
        if (Number.isFinite(metadata.clock)) {
            this.clock.merge(metadata.clock);
        }
        this.lastSnapshotCache = null;
    }

    getItem(id) {
        const record = this.items.get(id);
        return record ? cloneItemRecord(record) : null;
    }

    getSnapshot(options = {}) {
        const includeDeleted = Boolean(options.includeDeleted);
        if (!includeDeleted && this.lastSnapshotCache) {
            return this.lastSnapshotCache.map((item) => ({ ...item }));
        }
        const items = Array.from(this.items.values())
            .filter((record) => includeDeleted || record.deletedAt == null)
            .map((record) => ({
                id: record.id,
                pos: clonePosition(record.pos),
                text: record.text,
                done: record.done,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                deletedAt: record.deletedAt,
            }))
            .sort(sortByPositionAscending);
        if (!includeDeleted) {
            this.lastSnapshotCache = items.map((item) => ({ ...item }));
        }
        return items.map((item) => ({ ...item }));
    }

    toListState() {
        const snapshot = this.getSnapshot();
        return {
            title: this.title,
            items: snapshot.map((item) => ({
                id: item.id,
                text: item.text,
                done: item.done,
            })),
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
            case OP_TYPES.insert:
                changed = this.applyInsert(operation);
                break;
            case OP_TYPES.remove:
                changed = this.applyRemove(operation);
                break;
            case OP_TYPES.move:
                changed = this.applyMove(operation);
                break;
            case OP_TYPES.update:
                changed = this.applyUpdate(operation);
                break;
            case OP_TYPES.renameList:
                changed = this.applyRename(operation);
                break;
            default:
                break;
        }

        this.seenOps.add(opKey);
        if (changed) {
            this.lastSnapshotCache = null;
        }
        return changed;
    }

    applyInsert(operation) {
        const itemId = operation.itemId;
        if (typeof itemId !== "string" || !itemId.length) return false;
        const payload = operation.payload ?? {};
        const position = normalizePosition(payload.pos);
        if (!position.length) return false;
        const text = sanitizeText(payload.text);
        const done = sanitizeBoolean(payload.done, false);
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;

        const existing = this.items.get(itemId);
        if (!existing) {
            this.items.set(itemId, {
                id: itemId,
                pos: position,
                text,
                done,
                createdAt: clock,
                updatedAt: clock,
                deletedAt: null,
            });
            return true;
        }

        let updated = false;
        if (existing.deletedAt != null && clock > existing.deletedAt) {
            existing.deletedAt = null;
            updated = true;
        }

        if (clock > existing.updatedAt) {
            if (payload.text != null && existing.text !== text) {
                existing.text = text;
                updated = true;
            }
            if (payload.done != null && existing.done !== done) {
                existing.done = done;
                updated = true;
            }
            existing.updatedAt = clock;
        }
        return updated;
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
        if (!record) return false;
        if (record.deletedAt != null) return false;
        const position = normalizePosition(operation.payload?.pos);
        if (!position.length) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (clock <= record.updatedAt) return false;
        const samePosition = positionToKey(position) === positionToKey(record.pos);
        if (samePosition) return false;
        record.pos = position;
        record.updatedAt = clock;
        return true;
    }

    applyUpdate(operation) {
        const itemId = operation.itemId;
        if (typeof itemId !== "string" || !itemId.length) return false;
        const record = this.items.get(itemId);
        if (!record) return false;
        if (record.deletedAt != null) return false;
        const payload = operation.payload ?? {};
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (clock <= record.updatedAt) return false;

        let changed = false;
        if (payload.text != null) {
            const nextText = sanitizeText(payload.text);
            if (nextText !== record.text) {
                record.text = nextText;
                changed = true;
            }
        }
        if (payload.done != null) {
            const nextDone = sanitizeBoolean(payload.done, record.done);
            if (nextDone !== record.done) {
                record.done = nextDone;
                changed = true;
            }
        }
        if (changed) {
            record.updatedAt = clock;
        }
        return changed;
    }

    applyRename(operation) {
        const payload = operation.payload ?? {};
        const title = sanitizeText(payload.title);
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (clock < this.titleUpdatedAt) {
            return false;
        }
        if (clock === this.titleUpdatedAt && title === this.title) {
            return false;
        }
        this.title = title;
        this.titleUpdatedAt = clock;
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
        const text = sanitizeText(options.text);
        const done = sanitizeBoolean(options.done, false);
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.insert,
            itemId,
            payload: { text, done, pos: clonePosition(position) },
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, resultingSnapshot: this.getSnapshot() };
    }

    generateUpdate(options = {}) {
        const itemId = typeof options.itemId === "string" ? options.itemId : null;
        if (!itemId) {
            throw new Error("generateUpdate requires an itemId");
        }
        if (!this.items.has(itemId)) {
            throw new Error(`Cannot update missing item "${itemId}"`);
        }
        const payload = {};
        if (options.text != null) {
            payload.text = sanitizeText(options.text);
        }
        if (options.done != null) {
            payload.done = sanitizeBoolean(options.done, false);
        }
        if (Object.keys(payload).length === 0) {
            throw new Error("generateUpdate requires a text or done payload");
        }
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.update,
            itemId,
            payload,
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, resultingSnapshot: this.getSnapshot() };
    }

    generateToggle(itemId, explicitState = null) {
        if (typeof itemId !== "string" || !this.items.has(itemId)) {
            throw new Error(`Cannot toggle missing item "${itemId}"`);
        }
        const record = this.items.get(itemId);
        const nextDone =
            explicitState == null ? !record.done : sanitizeBoolean(explicitState, record.done);
        return this.generateUpdate({ itemId, done: nextDone });
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
            type: OP_TYPES.move,
            itemId,
            payload: { pos: clonePosition(position) },
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, resultingSnapshot: this.getSnapshot() };
    }

    generateRemove(itemId) {
        if (typeof itemId !== "string" || !this.items.has(itemId)) {
            throw new Error(`Cannot remove missing item "${itemId}"`);
        }
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.remove,
            itemId,
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, resultingSnapshot: this.getSnapshot({ includeDeleted: false }) };
    }

    generateRename(title) {
        const nextTitle = sanitizeText(title);
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.renameList,
            payload: { title: nextTitle },
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, resultingSnapshot: this.getSnapshot() };
    }
}

export { OP_TYPES as LIST_CRDT_OPERATIONS };
