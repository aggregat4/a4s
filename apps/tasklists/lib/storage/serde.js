import { normalizePosition } from "../crdt/position.js";

export const SERIALIZATION_VERSION = 1;
export const REGISTRY_STATE_ID = "registry";

function encodeDigit(value) {
  if (!Number.isFinite(value)) return 0;
  const digit = Math.floor(value);
  return digit < 0 ? 0 : digit;
}

function encodeActor(value) {
  return typeof value === "string" ? value : "";
}

function encodePosition(position) {
  return normalizePosition(position).map((component) => ({
    digit: encodeDigit(component.digit),
    actor: encodeActor(component.actor),
  }));
}

function decodePosition(encoded) {
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

function encodeTimestamp(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function encodeData(value) {
  if (value == null) return {};
  if (typeof value !== "object") {
    return { value };
  }
  return JSON.parse(JSON.stringify(value));
}

function encodeEntry(entry, mapData) {
  if (!entry || typeof entry.id !== "string" || !entry.id.length) return null;
  const data = mapData ? mapData(entry.data) : encodeData(entry.data);
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

function decodeEntry(entry, mapData) {
  if (!entry || typeof entry.id !== "string" || !entry.id.length) return null;
  const data = mapData ? mapData(entry.data) : entry.data ?? {};
  const decoded = {
    id: entry.id,
    pos: decodePosition(entry.pos),
    data,
    createdAt: encodeTimestamp(entry.createdAt),
    updatedAt: encodeTimestamp(entry.updatedAt),
    deletedAt:
      entry.deletedAt == null || !Number.isFinite(entry.deletedAt)
        ? null
        : Math.max(0, Math.floor(entry.deletedAt)),
  };
  if (!decoded.pos.length) return null;
  return decoded;
}

export function serializeOrderedSetSnapshot(entries, mapData) {
  if (!Array.isArray(entries)) return [];
  const encoded = entries
    .map((entry) => encodeEntry(entry, mapData))
    .filter((entry) => entry != null);
  return encoded;
}

export function deserializeOrderedSetSnapshot(entries, mapData) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => decodeEntry(entry, mapData))
    .filter((entry) => entry != null);
}

const sanitizeText = (value) => (typeof value === "string" ? value : "");
const sanitizeBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(value);
};

const mapListDataEncode = (data) => ({
  text: sanitizeText(data?.text),
  done: sanitizeBoolean(data?.done),
});

const mapListDataDecode = mapListDataEncode;

const mapRegistryDataEncode = (data) => ({
  title: sanitizeText(data?.title),
});

const mapRegistryDataDecode = mapRegistryDataEncode;

export function serializeListState(state = {}) {
  const normalizedEntries = Array.isArray(state.entries)
    ? state.entries.map((entry) => {
        const data = entry?.data ?? {
          text: sanitizeText(entry?.text),
          done: sanitizeBoolean(entry?.done),
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

export function deserializeListState(encoded = {}) {
  return {
    version: encodeTimestamp(encoded.version) || SERIALIZATION_VERSION,
    clock: encodeTimestamp(encoded.clock),
    title: sanitizeText(encoded.title),
    titleUpdatedAt: encodeTimestamp(encoded.titleUpdatedAt),
    entries: deserializeOrderedSetSnapshot(encoded.entries, mapListDataDecode),
  };
}

export function serializeRegistryState(state = {}) {
  const normalizedEntries = Array.isArray(state.entries)
    ? state.entries.map((entry) => {
        const data = entry?.data ?? {
          title: sanitizeText(entry?.title),
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

export function deserializeRegistryState(encoded = {}) {
  return {
    version: encodeTimestamp(encoded.version) || SERIALIZATION_VERSION,
    clock: encodeTimestamp(encoded.clock),
    entries: deserializeOrderedSetSnapshot(
      encoded.entries,
      mapRegistryDataDecode
    ),
  };
}

function serializePayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const result = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (key === "pos") {
      result.pos = encodePosition(value);
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0]?.digit != null
    ) {
      result[key] = value.map((component) => encodePosition(component));
    } else {
      result[key] = value;
    }
  });
  return result;
}

function deserializePayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const result = {};
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

export function serializeOperation(operation) {
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

export function deserializeOperation(encoded) {
  if (!encoded || typeof encoded !== "object") return null;
  const payload = deserializePayload(encoded.payload);
  const operation = {
    type: typeof encoded.type === "string" ? encoded.type : "",
    itemId: typeof encoded.itemId === "string" ? encoded.itemId : undefined,
    listId: typeof encoded.listId === "string" ? encoded.listId : undefined,
    payload,
    clock: encodeTimestamp(encoded.clock),
    actor: typeof encoded.actor === "string" ? encoded.actor : "",
  };
  return operation;
}

function cleanUndefinedKeys(object) {
  if (!object || typeof object !== "object") return object;
  const next = { ...object };
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) {
      delete next[key];
    }
  });
  return next;
}
