import { ORDERED_SET_OPERATIONS, OrderedSetCRDT } from "./ordered-set-crdt.js";

const LIST_INDEX_OPERATIONS = {
    createList: "createList",
    removeList: "removeList",
    reorderList: "reorderList",
};

function sanitizeText(value) {
    return typeof value === "string" ? value : "";
}

function resolveTargetId(operation) {
    if (typeof operation.itemId === "string" && operation.itemId.length) {
        return operation.itemId;
    }
    if (typeof operation.listId === "string" && operation.listId.length) {
        return operation.listId;
    }
    return null;
}

function toBaseInsert(operation) {
    const payload = operation.payload ?? {};
    const itemId = resolveTargetId(operation);
    return {
        ...operation,
        type: ORDERED_SET_OPERATIONS.insert,
        itemId,
        payload: {
            data: { title: sanitizeText(payload.title) },
            pos: payload.pos,
        },
    };
}

export class ListIndexCRDT {
    constructor(options = {}) {
        this._orderedSet = new OrderedSetCRDT(options);
        this.listeners = new Set();
    }

    get actorId() {
        return this._orderedSet.actorId;
    }

    get clock() {
        return this._orderedSet.clock;
    }

    get items() {
        return this._orderedSet.items;
    }

    exportState() {
        return this._orderedSet.exportState();
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
                // Ignore listener errors.
            }
        });
    }

    resetFromSnapshot(snapshot = [], metadata = {}) {
        const entries = Array.isArray(snapshot)
            ? snapshot.map((entry) => ({
                  id: entry.id,
                  pos: entry.pos,
                  data: { title: sanitizeText(entry.title) },
                  createdAt: entry.createdAt,
                  updatedAt: entry.updatedAt,
                  deletedAt: entry.deletedAt,
              }))
            : [];
        this._orderedSet.importRecords(entries);
        if (Number.isFinite(metadata.clock)) {
            this._orderedSet.clock.merge(metadata.clock);
        }
        this.emitChange();
    }

    resetFromState(state = {}) {
        const entries = Array.isArray(state.entries)
            ? state.entries.map((entry) => ({
                  ...entry,
                  data: { title: sanitizeText(entry?.data?.title) },
              }))
            : [];
        this._orderedSet.importRecords(entries);
        if (Number.isFinite(state.clock)) {
            this._orderedSet.clock.merge(state.clock);
        }
        this.emitChange();
    }

    applyOperation(operation) {
        if (!operation || typeof operation !== "object") return false;
        let baseOp = operation;
        switch (operation.type) {
            case LIST_INDEX_OPERATIONS.createList:
                if (!resolveTargetId(operation)) return false;
                baseOp = toBaseInsert(operation);
                break;
            case LIST_INDEX_OPERATIONS.removeList:
                if (!resolveTargetId(operation)) return false;
                baseOp = {
                    ...operation,
                    itemId: resolveTargetId(operation),
                    type: ORDERED_SET_OPERATIONS.remove,
                };
                break;
            case LIST_INDEX_OPERATIONS.reorderList:
                if (!resolveTargetId(operation)) return false;
                baseOp = {
                    ...operation,
                    itemId: resolveTargetId(operation),
                    type: ORDERED_SET_OPERATIONS.move,
                    payload: { pos: operation.payload?.pos },
                };
                break;
            default:
                break;
        }
        const changed = this._orderedSet.applyOperation(baseOp);
        if (changed) {
            this.emitChange();
        }
        return changed;
    }

    getRecord(id) {
        const entry = this._orderedSet.getItem(id);
        if (!entry) return null;
        return {
            id: entry.id,
            title: entry.data.title,
            pos: entry.pos,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            deletedAt: entry.deletedAt,
        };
    }

    getVisibleLists() {
        return this._orderedSet.getSnapshot().map((entry) => ({
            id: entry.id,
            title: entry.data.title,
            pos: entry.pos,
        }));
    }

    generateCreate(options = {}) {
        const listId = typeof options.listId === "string" ? options.listId : null;
        if (!listId) {
            throw new Error("generateCreate requires a listId");
        }
        const result = this._orderedSet.generateInsert({
            itemId: listId,
            data: { title: sanitizeText(options.title) },
            position: options.position,
            afterId: options.afterId,
            beforeId: options.beforeId,
        });
        const op = {
            ...result.op,
            type: LIST_INDEX_OPERATIONS.createList,
            listId,
            payload: {
                title: result.op.payload.data.title,
                pos: result.op.payload.pos,
            },
        };
        this.emitChange();
        return {
            op,
            snapshot: this.getVisibleLists(),
        };
    }

    generateRemove(listId) {
        const result = this._orderedSet.generateRemove(listId);
        const op = {
            ...result.op,
            type: LIST_INDEX_OPERATIONS.removeList,
            listId,
        };
        this.emitChange();
        return {
            op,
            snapshot: this.getVisibleLists(),
        };
    }

    generateReorder(options = {}) {
        const listId = typeof options.listId === "string" ? options.listId : null;
        if (!listId) {
            throw new Error("generateReorder requires a listId");
        }
        const result = this._orderedSet.generateMove({
            itemId: listId,
            position: options.position,
            afterId: options.afterId,
            beforeId: options.beforeId,
        });
        const op = {
            ...result.op,
            type: LIST_INDEX_OPERATIONS.reorderList,
            listId,
            payload: {
                pos: result.op.payload.pos,
            },
        };
        this.emitChange();
        return {
            op,
            snapshot: this.getVisibleLists(),
        };
    }
}

export { LIST_INDEX_OPERATIONS };
