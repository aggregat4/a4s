import { ensureActorId, LamportClock } from "./ids.js";
import { between, clonePosition, comparePositions, normalizePosition } from "./position.js";

const OP_TYPES = {
    createList: "createList",
    renameList: "renameList",
    removeList: "removeList",
    reorderList: "reorderList",
};

function sanitizeText(value) {
    return typeof value === "string" ? value : "";
}

function makeOperationKey(op) {
    const actor = typeof op?.actor === "string" ? op.actor : "";
    const clock = Number.isFinite(op?.clock) ? Math.floor(op.clock) : 0;
    return `${actor}:${clock}`;
}

function sortRecords(left, right) {
    return comparePositions(left.pos, right.pos);
}

export class ListIndexCRDT {
    constructor(options = {}) {
        this.actorId = options.actorId ?? ensureActorId(options.identityOptions);
        this.clock = options.clock instanceof LamportClock ? options.clock : new LamportClock();
        this.records = new Map();
        this.seenOps = new Set();
        this.listeners = new Set();
    }

    subscribe(handler) {
        if (typeof handler !== "function") return () => {};
        this.listeners.add(handler);
        return () => {
            this.listeners.delete(handler);
        };
    }

    emitChange() {
        if (!this.listeners.size) return;
        const snapshot = this.getVisibleLists();
        this.listeners.forEach((handler) => {
            try {
                handler(snapshot);
            } catch (err) {
                // Ignore listener errors to avoid breaking the CRDT core.
            }
        });
    }

    resetFromSnapshot(snapshot = [], metadata = {}) {
        this.records.clear();
        if (Array.isArray(snapshot)) {
            snapshot.forEach((entry) => {
                if (!entry || typeof entry.id !== "string") return;
                const position = normalizePosition(entry.pos);
                if (!position.length) return;
                this.records.set(entry.id, {
                    id: entry.id,
                    title: sanitizeText(entry.title),
                    pos: position,
                    createdAt: Number.isFinite(entry.createdAt) ? Math.floor(entry.createdAt) : 0,
                    updatedAt: Number.isFinite(entry.updatedAt) ? Math.floor(entry.updatedAt) : 0,
                    deletedAt: Number.isFinite(entry.deletedAt)
                        ? Math.floor(entry.deletedAt)
                        : null,
                });
            });
        }
        if (Number.isFinite(metadata.clock)) {
            this.clock.merge(metadata.clock);
        }
        this.emitChange();
    }

    getRecord(id) {
        const record = this.records.get(id);
        if (!record) return null;
        return {
            id: record.id,
            title: record.title,
            pos: clonePosition(record.pos),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            deletedAt: record.deletedAt,
        };
    }

    getVisibleLists() {
        return Array.from(this.records.values())
            .filter((record) => record.deletedAt == null)
            .sort(sortRecords)
            .map((record) => ({
                id: record.id,
                title: record.title,
                pos: clonePosition(record.pos),
            }));
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
            case OP_TYPES.createList:
                changed = this.applyCreate(operation);
                break;
            case OP_TYPES.renameList:
                changed = this.applyRename(operation);
                break;
            case OP_TYPES.removeList:
                changed = this.applyRemove(operation);
                break;
            case OP_TYPES.reorderList:
                changed = this.applyReorder(operation);
                break;
            default:
                break;
        }

        this.seenOps.add(opKey);
        if (changed) {
            this.emitChange();
        }
        return changed;
    }

    applyCreate(operation) {
        const listId = operation.listId;
        if (typeof listId !== "string" || !listId.length) return false;
        const payload = operation.payload ?? {};
        const position = normalizePosition(payload.pos);
        if (!position.length) return false;
        const title = sanitizeText(payload.title);
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;

        const existing = this.records.get(listId);
        if (!existing) {
            this.records.set(listId, {
                id: listId,
                title,
                pos: position,
                createdAt: clock,
                updatedAt: clock,
                deletedAt: null,
            });
            return true;
        }

        let mutated = false;
        if (existing.deletedAt != null && clock > existing.deletedAt) {
            existing.deletedAt = null;
            mutated = true;
        }
        if (clock > existing.updatedAt && existing.title !== title) {
            existing.title = title;
            existing.updatedAt = clock;
            mutated = true;
        }
        return mutated;
    }

    applyRename(operation) {
        const listId = operation.listId;
        if (typeof listId !== "string" || !listId.length) return false;
        const record = this.records.get(listId);
        if (!record || record.deletedAt != null) return false;
        const title = sanitizeText(operation.payload?.title);
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (clock <= record.updatedAt && title === record.title) return false;
        if (title === record.title) {
            record.updatedAt = Math.max(record.updatedAt, clock);
            return false;
        }
        if (clock < record.updatedAt) return false;
        record.title = title;
        record.updatedAt = clock;
        return true;
    }

    applyRemove(operation) {
        const listId = operation.listId;
        if (typeof listId !== "string" || !listId.length) return false;
        const record = this.records.get(listId);
        if (!record) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (record.deletedAt != null && clock <= record.deletedAt) return false;
        record.deletedAt = clock;
        if (clock > record.updatedAt) {
            record.updatedAt = clock;
        }
        return true;
    }

    applyReorder(operation) {
        const listId = operation.listId;
        if (typeof listId !== "string" || !listId.length) return false;
        const record = this.records.get(listId);
        if (!record || record.deletedAt != null) return false;
        const position = normalizePosition(operation.payload?.pos);
        if (!position.length) return false;
        const clock = Number.isFinite(operation.clock) ? Math.floor(operation.clock) : 0;
        if (clock <= record.updatedAt) return false;
        record.pos = position;
        record.updatedAt = clock;
        return true;
    }

    nextClock(remoteTime) {
        return this.clock.tick(remoteTime);
    }

    ensurePositionBetween(leftId, rightId) {
        const left = leftId ? this.records.get(leftId) : null;
        const right = rightId ? this.records.get(rightId) : null;
        const leftPos = left ? left.pos : null;
        const rightPos = right ? right.pos : null;
        return between(leftPos, rightPos, { actor: this.actorId });
    }

    generateCreate(options = {}) {
        const listId = typeof options.listId === "string" ? options.listId : null;
        if (!listId) {
            throw new Error("generateCreate requires a listId");
        }
        const position =
            options.position && normalizePosition(options.position).length
                ? normalizePosition(options.position)
                : this.ensurePositionBetween(options.afterId, options.beforeId);
        const title = sanitizeText(options.title);
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.createList,
            listId,
            payload: { title, pos: clonePosition(position) },
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, snapshot: this.getVisibleLists() };
    }

    generateRename(listId, title) {
        if (typeof listId !== "string" || !this.records.has(listId)) {
            throw new Error(`Cannot rename missing list "${listId}"`);
        }
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.renameList,
            listId,
            payload: { title: sanitizeText(title) },
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, snapshot: this.getVisibleLists() };
    }

    generateRemove(listId) {
        if (typeof listId !== "string" || !this.records.has(listId)) {
            throw new Error(`Cannot remove missing list "${listId}"`);
        }
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.removeList,
            listId,
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, snapshot: this.getVisibleLists() };
    }

    generateReorder(options = {}) {
        const listId = typeof options.listId === "string" ? options.listId : null;
        if (!listId) {
            throw new Error("generateReorder requires a listId");
        }
        if (!this.records.has(listId)) {
            throw new Error(`Cannot reorder missing list "${listId}"`);
        }
        const position =
            options.position && normalizePosition(options.position).length
                ? normalizePosition(options.position)
                : this.ensurePositionBetween(options.afterId, options.beforeId);
        const clock = this.nextClock();
        const op = {
            type: OP_TYPES.reorderList,
            listId,
            payload: { pos: clonePosition(position) },
            clock,
            actor: this.actorId,
        };
        this.applyOperation(op);
        return { op, snapshot: this.getVisibleLists() };
    }
}

export { OP_TYPES as LIST_INDEX_OPERATIONS };
