import { ORDERED_SET_OPERATIONS, OrderedSetCRDT } from "./ordered-set-crdt.js";

const LIST_INDEX_OPERATIONS = {
    createList: "createList",
    renameList: "renameList",
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

function toBaseUpdate(operation) {
    const payload = operation.payload ?? {};
    const itemId = resolveTargetId(operation);
    return {
        ...operation,
        type: ORDERED_SET_OPERATIONS.update,
        itemId,
        payload: {
            data: { title: sanitizeText(payload.title) },
        },
    };
}

export class ListIndexCRDT extends OrderedSetCRDT {
    constructor(options = {}) {
        super(options);
        this.listeners = new Set();
    }

    exportState() {
        return super.exportState();
    }

    sanitizeInsertPayload(data) {
        return { title: sanitizeText(data?.title) };
    }

    sanitizeUpdatePayload(data) {
        const result = {};
        if (data && Object.prototype.hasOwnProperty.call(data, "title")) {
            result.title = sanitizeText(data.title);
        }
        return result;
    }

    sanitizeSnapshotData(data) {
        return { title: sanitizeText(data?.title) };
    }

    cloneData(data) {
        return { title: sanitizeText(data?.title) };
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
        this.importRecords(entries);
        if (Number.isFinite(metadata.clock)) {
            this.clock.merge(metadata.clock);
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
        this.importRecords(entries);
        if (Number.isFinite(state.clock)) {
            this.clock.merge(state.clock);
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
            case LIST_INDEX_OPERATIONS.renameList:
                if (!resolveTargetId(operation)) return false;
                baseOp = toBaseUpdate(operation);
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
        const changed = super.applyOperation(baseOp);
        if (changed) {
            this.emitChange();
        }
        return changed;
    }

    getRecord(id) {
        const entry = super.getItem(id);
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
        return super
            .getSnapshot()
            .map((entry) => ({
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
        const result = super.generateInsert({
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

    generateRename(listId, title) {
        if (typeof listId !== "string" || !this.items.has(listId)) {
            throw new Error(`Cannot rename missing list "${listId}"`);
        }
        const result = super.generateUpdate({
            itemId: listId,
            data: { title: sanitizeText(title) },
        });
        const op = {
            ...result.op,
            type: LIST_INDEX_OPERATIONS.renameList,
            listId,
            payload: {
                title: result.op.payload.data.title,
            },
        };
        this.emitChange();
        return {
            op,
            snapshot: this.getVisibleLists(),
        };
    }

    generateRemove(listId) {
        const result = super.generateRemove(listId);
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
        const result = super.generateMove({
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
