import { normalizePosition } from "../crdt/position.js";
import type {
  ListState,
  OrderedSetEntry,
  Position,
  RegistryState,
} from "../../types/domain.js";
import type { ListsOperation, TaskListOperation } from "../../types/crdt.js";

export const SERIALIZATION_VERSION = 1;
export const REGISTRY_STATE_ID = "registry";

type EncodedPositionComponent = { digit: number; actor: string };
type EncodedPosition = EncodedPositionComponent[];
type EncodedEntry<TData> = {
  id: string;
  pos: EncodedPosition;
  data: TData;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
type MapDataFn<TIn, TOut> = (data: TIn) => TOut;

function encodeDigit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const digit = Math.floor(value);
  return digit < 0 ? 0 : digit;
}

function encodeActor(value: unknown) {
  return typeof value === "string" ? value : "";
}

function encodePosition(position: Position | null | undefined): EncodedPosition {
  return normalizePosition(position).map((component) => ({
    digit: encodeDigit(component.digit),
    actor: encodeActor(component.actor),
  }));
}

function decodePosition(encoded: unknown): EncodedPosition {
  if (!Array.isArray(encoded)) return [];
  return encoded
    .map((component) => ({
      digit: encodeDigit(component?.digit),
      actor: encodeActor(component?.actor),
    }))
    .filter((component, index, array) => {
      if (index === array.length - 1) return true;
      return !(component.digit === 0 && component.actor === "");
    });
}

function encodeTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function encodeData(value: unknown) {
  if (value == null) return {};
  if (typeof value !== "object") {
    return { value };
  }
  return JSON.parse(JSON.stringify(value));
}

function encodeEntry<TIn, TOut>(
  entry: OrderedSetEntry<TIn>,
  mapData?: MapDataFn<TIn, TOut>
): EncodedEntry<TOut> | null {
  if (!entry || typeof entry.id !== "string" || !entry.id.length) return null;
  const data = mapData
    ? mapData(entry.data)
    : (encodeData(entry.data) as TOut);
  return {
    id: entry.id,
    pos: encodePosition(entry.pos),
    data,
    createdAt: encodeTimestamp(entry.createdAt),
    updatedAt: encodeTimestamp(entry.updatedAt),
    deletedAt:
      entry.deletedAt == null || !Number.isFinite(entry.deletedAt)
        ? null
        : Math.max(0, Math.floor(entry.deletedAt)),
  };
}

function decodeEntry<TOut>(
  entry: unknown,
  mapData?: MapDataFn<unknown, TOut>
): OrderedSetEntry<TOut> | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as {
    id?: unknown;
    pos?: unknown;
    data?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    deletedAt?: unknown;
  };
  if (typeof record.id !== "string" || !record.id.length) return null;
  const data = mapData ? mapData(record.data) : (record.data ?? ({} as TOut));
  const decoded = {
    id: record.id,
    pos: decodePosition(record.pos),
    data,
    createdAt: encodeTimestamp(record.createdAt),
    updatedAt: encodeTimestamp(record.updatedAt),
    deletedAt:
      typeof record.deletedAt !== "number" || !Number.isFinite(record.deletedAt)
        ? null
        : Math.max(0, Math.floor(record.deletedAt)),
  };
  if (!decoded.pos.length) return null;
  return decoded as OrderedSetEntry<TOut>;
}

export function serializeOrderedSetSnapshot<TIn, TOut>(
  entries: OrderedSetEntry<TIn>[],
  mapData?: MapDataFn<TIn, TOut>
) {
  if (!Array.isArray(entries)) return [];
  const encoded = entries
    .map((entry) => encodeEntry(entry, mapData))
    .filter((entry) => entry != null);
  return encoded;
}

export function deserializeOrderedSetSnapshot<TOut>(
  entries: unknown,
  mapData?: MapDataFn<unknown, TOut>
) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => decodeEntry(entry, mapData))
    .filter((entry) => entry != null);
}

const sanitizeText = (value: unknown) => (typeof value === "string" ? value : "");
const sanitizeBoolean = (value: unknown) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(value);
};

const mapListDataEncode = (data: unknown) => ({
  text: sanitizeText((data as { text?: unknown })?.text),
  done: sanitizeBoolean((data as { done?: unknown })?.done),
});

const mapListDataDecode = mapListDataEncode;

const mapRegistryDataEncode = (data: unknown) => ({
  title: sanitizeText((data as { title?: unknown })?.title),
});

const mapRegistryDataDecode = mapRegistryDataEncode;

export function serializeListState(state: ListState) {
  const normalizedEntries = Array.isArray(state.entries)
    ? state.entries.map((entry) => {
      const data = entry?.data ?? {
        text: sanitizeText((entry as { text?: string })?.text),
        done: sanitizeBoolean((entry as { done?: boolean })?.done),
      };
      return {
        ...entry,
        data,
      };
    })
    : [];
  return {
    version: SERIALIZATION_VERSION,
    clock: encodeTimestamp(state.clock),
    title: sanitizeText(state.title),
    titleUpdatedAt: encodeTimestamp(state.titleUpdatedAt),
    entries: serializeOrderedSetSnapshot(normalizedEntries, mapListDataEncode),
  };
}

export function deserializeListState(encoded: unknown = {}): ListState {
  const safe = encoded ?? {};
  return {
    version:
      encodeTimestamp((safe as { version?: unknown }).version) ||
      SERIALIZATION_VERSION,
    clock: encodeTimestamp((safe as { clock?: unknown }).clock),
    title: sanitizeText((safe as { title?: unknown }).title),
    titleUpdatedAt: encodeTimestamp(
      (safe as { titleUpdatedAt?: unknown }).titleUpdatedAt
    ),
    entries: deserializeOrderedSetSnapshot(
      (safe as { entries?: unknown }).entries,
      mapListDataDecode
    ),
  };
}

export function serializeRegistryState(state: RegistryState) {
  const normalizedEntries = Array.isArray(state.entries)
    ? state.entries.map((entry) => {
      const data = entry?.data ?? {
        title: sanitizeText((entry as { title?: string })?.title),
      };
      return {
        ...entry,
        data,
      };
    })
    : [];
  return {
    version: SERIALIZATION_VERSION,
    clock: encodeTimestamp(state.clock),
    entries: serializeOrderedSetSnapshot(
      normalizedEntries,
      mapRegistryDataEncode
    ),
  };
}

export function deserializeRegistryState(encoded: unknown = {}): RegistryState {
  const safe = encoded ?? {};
  return {
    version:
      encodeTimestamp((safe as { version?: unknown }).version) ||
      SERIALIZATION_VERSION,
    clock: encodeTimestamp((safe as { clock?: unknown }).clock),
    entries: deserializeOrderedSetSnapshot(
      (safe as { entries?: unknown }).entries,
      mapRegistryDataDecode
    ),
  };
}

function serializePayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const result: Record<string, unknown> = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (key === "pos") {
      result.pos = encodePosition(value as Position);
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0]?.digit != null
    ) {
      result[key] = value.map((component) =>
        encodePosition(component as Position)
      );
    } else {
      result[key] = value;
    }
  });
  return result;
}

function deserializePayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const result: Record<string, unknown> = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (key === "pos") {
      result.pos = decodePosition(value);
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0]?.digit != null
    ) {
      result[key] = value.map((component) => decodePosition(component));
    } else {
      result[key] = value;
    }
  });
  return result;
}

export function serializeOperation(operation: TaskListOperation | ListsOperation) {
  if (!operation || typeof operation !== "object") return null;
  const base = {
    type: typeof operation.type === "string" ? operation.type : "",
    itemId: typeof operation.itemId === "string" ? operation.itemId : undefined,
    listId: typeof operation.listId === "string" ? operation.listId : undefined,
    payload: serializePayload(operation.payload),
    clock: encodeTimestamp(operation.clock),
    actor: typeof operation.actor === "string" ? operation.actor : "",
  };
  return cleanUndefinedKeys(base);
}

export function deserializeOperation(
  encoded: unknown
): TaskListOperation | ListsOperation | null {
  if (!encoded || typeof encoded !== "object") return null;
  const record = encoded as {
    type?: unknown;
    itemId?: unknown;
    listId?: unknown;
    payload?: unknown;
    clock?: unknown;
    actor?: unknown;
  };
  const payload = deserializePayload(record.payload);
  const operation = {
    type: typeof record.type === "string" ? record.type : "",
    itemId: typeof record.itemId === "string" ? record.itemId : undefined,
    listId: typeof record.listId === "string" ? record.listId : undefined,
    payload,
    clock: encodeTimestamp(record.clock),
    actor: typeof record.actor === "string" ? record.actor : "",
  };
  return operation as TaskListOperation | ListsOperation;
}

function cleanUndefinedKeys<T extends Record<string, unknown>>(object: T | null) {
  if (!object || typeof object !== "object") return object;
  const next: Record<string, unknown> = { ...object };
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) {
      delete next[key];
    }
  });
  return next;
}
