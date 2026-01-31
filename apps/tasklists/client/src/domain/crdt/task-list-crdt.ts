import { ORDERED_SET_OPERATIONS, OrderedSetCRDT } from "./ordered-set-crdt.js";
import type {
  ListState,
  OrderedSetSnapshot,
  Position,
  OrderedSetEntry,
  TaskInsertInput,
  TaskMoveInput,
  TaskUpdateInput,
} from "../../types/domain.js";
import type {
  OrderedSetOperation,
  TaskListOperation,
} from "../../types/crdt.js";

const TASK_LIST_OPERATIONS = {
  ...ORDERED_SET_OPERATIONS,
  renameList: "renameList",
} as const;

function sanitizeText(value) {
  return typeof value === "string" ? value : "";
}

function sanitizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

type TaskEntry = {
  id: string;
  pos: Position | null;
  text: string;
  done: boolean;
  note: string;
  createdAt?: number | null;
  updatedAt?: number | null;
  deletedAt?: number | null;
};

function cloneRecordEntry(
  entry: OrderedSetEntry<{ text: string; done: boolean; note: string }>
): TaskEntry {
  return {
    id: entry.id,
    pos: entry.pos,
    text: entry.data.text,
    done: entry.data.done,
    note: entry.data.note,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
  };
}

type TaskPayloadData = { text?: string; done?: boolean; note?: string };
type TaskPayload = { data?: TaskPayloadData } | TaskPayloadData | null;

function sanitizePayloadData(payload?: TaskPayload) {
  const candidate = payload ?? {};
  const source =
    candidate && typeof candidate === "object" && "data" in candidate
      ? (candidate as { data?: TaskPayloadData }).data ?? {}
      : candidate;
  const normalized = source as TaskPayloadData;
  return {
    text: sanitizeText(normalized.text),
    done: sanitizeBoolean(normalized.done, false),
    note: sanitizeText(normalized.note),
  };
}

function makeBaseInsertOp(operation: TaskListOperation) {
  const payload = operation.payload ?? {};
  return {
    ...operation,
    type: ORDERED_SET_OPERATIONS.insert,
    payload: {
      data: sanitizePayloadData(payload),
      pos: payload.pos,
    },
  };
}

function makeBaseUpdateOp(operation: TaskListOperation) {
  const payload = operation.payload ?? {};
  const candidate = payload ?? {};
  const source =
    candidate && typeof candidate === "object" && "data" in candidate
      ? (candidate as { data?: TaskPayloadData }).data ?? {}
      : candidate;
  const normalized = source as TaskPayloadData;
  const data: any = {};
  if (Object.prototype.hasOwnProperty.call(normalized, "text")) {
    data.text = sanitizeText(normalized.text);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "done")) {
    data.done = sanitizeBoolean(normalized.done, false);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "note")) {
    data.note = sanitizeText(normalized.note);
  }
  return {
    ...operation,
    type: ORDERED_SET_OPERATIONS.update,
    payload: {
      data,
    },
  };
}

export class TaskListCRDT {
  private _orderedSet: OrderedSetCRDT<{ text: string; done: boolean; note: string }>;
  title: string;
  titleUpdatedAt: number;

  constructor(
    options: { actorId?: string; title?: string; titleUpdatedAt?: number; identityOptions?: { storageKey?: string; storage?: Storage } } = {}
  ) {
    this._orderedSet = new OrderedSetCRDT<{ text: string; done: boolean; note: string }>(
      options
    );
    this.title = sanitizeText(options.title);
    this.titleUpdatedAt = Number.isFinite(options.titleUpdatedAt)
      ? Math.floor(options.titleUpdatedAt)
      : 0;
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

  exportState(): ListState {
    const base = this._orderedSet.exportState();
    return {
      ...base,
      title: this.title,
      titleUpdatedAt: this.titleUpdatedAt,
    };
  }

  resetFromState(state: ListState = { clock: 0, entries: [], title: "" }) {
    const entries = Array.isArray(state.entries)
      ? state.entries.map((entry) => ({
          ...entry,
          data: {
            text: sanitizeText(entry?.data?.text),
            done: sanitizeBoolean(entry?.data?.done, false),
            note: sanitizeText(entry?.data?.note),
          },
        }))
      : [];
    this._orderedSet.importRecords(entries);
    this.title = sanitizeText(state.title);
    this.titleUpdatedAt = Number.isFinite(state.titleUpdatedAt)
      ? Math.floor(state.titleUpdatedAt)
      : 0;
    if (Number.isFinite(state.clock)) {
      this._orderedSet.clock.merge(state.clock);
    }
  }

  resetFromSnapshot(
    snapshot: OrderedSetSnapshot<{ text: string; done: boolean; note: string }> = [],
    metadata: { clock?: number; title?: string; titleUpdatedAt?: number } = {}
  ) {
    const entries = Array.isArray(snapshot)
      ? snapshot.map((item) => ({
          id: item.id,
          pos: item.pos,
          data: {
            text: sanitizeText(item.data?.text),
            done: sanitizeBoolean(item.data?.done, false),
            note: sanitizeText(item.data?.note),
          },
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          deletedAt: item.deletedAt,
        }))
      : [];
    this._orderedSet.importRecords(entries);
    if (typeof metadata.title === "string") {
      this.title = sanitizeText(metadata.title);
    }
    if (Number.isFinite(metadata.titleUpdatedAt)) {
      this.titleUpdatedAt = Math.floor(metadata.titleUpdatedAt);
    }
    if (Number.isFinite(metadata.clock)) {
      this._orderedSet.clock.merge(metadata.clock);
    }
  }

  applyOperation(operation: TaskListOperation) {
    if (!operation || typeof operation !== "object") return false;
    if (operation.type === TASK_LIST_OPERATIONS.renameList) {
      return this.applyRename(operation);
    }
    if (operation.type === ORDERED_SET_OPERATIONS.insert) {
      return this._orderedSet.applyOperation(
        makeBaseInsertOp(operation) as OrderedSetOperation<{
          text: string;
          done: boolean;
          note: string;
        }>
      );
    }
    if (operation.type === ORDERED_SET_OPERATIONS.update) {
      return this._orderedSet.applyOperation(
        makeBaseUpdateOp(operation) as OrderedSetOperation<{
          text: string;
          done: boolean;
          note: string;
        }>
      );
    }
    return this._orderedSet.applyOperation(
      operation as OrderedSetOperation<{ text: string; done: boolean }>
    );
  }

  applyRename(operation) {
    const payload = operation.payload ?? {};
    const title = sanitizeText(payload.title);
    const clock = Number.isFinite(operation.clock)
      ? Math.floor(operation.clock)
      : 0;
    if (clock < this.titleUpdatedAt) {
      return false;
    }
    if (clock === this.titleUpdatedAt && title === this.title) {
      return false;
    }
    this.title = title;
    this.titleUpdatedAt = clock;
    this._orderedSet.invalidateSnapshotCache();
    return true;
  }

  getItem(id: string): TaskEntry | null {
    const entry = this._orderedSet.getItem(id);
    return entry ? cloneRecordEntry(entry) : null;
  }

  getSnapshot(options: { includeDeleted?: boolean } = {}): TaskEntry[] {
    const baseSnapshot = this._orderedSet.getSnapshot(options);
    return baseSnapshot.map(cloneRecordEntry);
  }

  toListState() {
    const snapshot = this.getSnapshot();
    return {
      title: this.title,
      items: snapshot.map((item) => ({
        id: item.id,
        text: item.text,
        done: item.done,
        note: item.note,
      })),
    };
  }

  nextClock(remoteTime?: number) {
    return this._orderedSet.nextClock(remoteTime);
  }

  generateInsert(options: TaskInsertInput = {}) {
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    if (!itemId) {
      throw new Error("generateInsert requires an itemId");
    }
    const data = {
      text: sanitizeText(options.text),
      done: options.done != null ? sanitizeBoolean(options.done, false) : false,
      note: sanitizeText(options.note),
    };
    const result = this._orderedSet.generateInsert({
      itemId,
      data,
      position: options.position,
      afterId: options.afterId,
      beforeId: options.beforeId,
    });
    const op = {
      ...result.op,
      payload: {
        text: result.op.payload.data.text,
        done: result.op.payload.data.done,
        note: result.op.payload.data.note,
        pos: result.op.payload.pos,
      },
    };
    return {
      op,
      resultingSnapshot: this.getSnapshot(),
    };
  }

  generateUpdate(options: TaskUpdateInput & { itemId?: string } = {}) {
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    if (!itemId) {
      throw new Error("generateUpdate requires an itemId");
    }
    const data: any = {};
    if (options.text != null) {
      data.text = sanitizeText(options.text);
    }
    if (options.done != null) {
      data.done = sanitizeBoolean(options.done, false);
    }
    if (options.note != null) {
      data.note = sanitizeText(options.note);
    }
    const result = this._orderedSet.generateUpdate({
      itemId,
      data,
    });
    const op = {
      ...result.op,
      payload: {
        ...(Object.prototype.hasOwnProperty.call(result.op.payload.data, "text")
          ? { text: result.op.payload.data.text }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(result.op.payload.data, "done")
          ? { done: result.op.payload.data.done }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(result.op.payload.data, "note")
          ? { note: result.op.payload.data.note }
          : {}),
      },
    };
    return {
      op,
      resultingSnapshot: this.getSnapshot(),
    };
  }

  generateToggle(itemId, explicitState = null) {
    if (typeof itemId !== "string" || !this._orderedSet.items.has(itemId)) {
      throw new Error(`Cannot toggle missing item "${itemId}"`);
    }
    const record = this._orderedSet.items.get(itemId);
    const nextDone =
      explicitState == null
        ? !record.data.done
        : sanitizeBoolean(explicitState, record.data.done);
    return this.generateUpdate({ itemId, done: nextDone });
  }

  generateMove(options: TaskMoveInput & { itemId?: string } = {}) {
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    if (!itemId) {
      throw new Error("generateMove requires an itemId");
    }
    const result = this._orderedSet.generateMove({
      itemId,
      position: options.position,
      afterId: options.afterId,
      beforeId: options.beforeId,
    });
    return {
      op: result.op,
      resultingSnapshot: this.getSnapshot(),
    };
  }

  generateRemove(itemId: string) {
    const result = this._orderedSet.generateRemove(itemId);
    return {
      op: result.op,
      resultingSnapshot: this.getSnapshot(),
    };
  }

  generateRename(title: string) {
    const nextTitle = sanitizeText(title);
    const clock = this.nextClock();
    const op = {
      type: TASK_LIST_OPERATIONS.renameList,
      payload: { title: nextTitle },
      clock,
      actor: this.actorId,
    };
    this.applyRename(op);
    return {
      op,
      resultingSnapshot: this.getSnapshot(),
    };
  }
}
