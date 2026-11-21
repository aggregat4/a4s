import { normalizePosition } from "../domain/crdt/position.js";
import type {
  EntryVersions,
  ListState,
  OrderedSetEntry,
  Position,
  RegistryState,
  Version,
} from "../types/domain.js";

export const SERIALIZATION_VERSION = 1;
export const REGISTRY_STATE_ID = "registry";

type EncodedPositionComponent = { digit: number; actor: string };
type EncodedPosition = EncodedPositionComponent[];
type EncodedEntry<TData> = {
  id: string;
  pos: EncodedPosition;
  data: TData;
  versions: EntryVersions;
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

function encodeVersion(value: unknown): Version {
  const version = value as Partial<Version> | null | undefined;
  return { clock: encodeTimestamp(version?.clock), actor: encodeActor(version?.actor) };
}

function encodeVersions(value: unknown): EntryVersions {
  const versions = value as Partial<EntryVersions> | null | undefined;
  const fields = versions?.fields && typeof versions.fields === "object" ? versions.fields : {};
  return {
    position: encodeVersion(versions?.position),
    existence: encodeVersion(versions?.existence),
    fields: Object.fromEntries(
      Object.entries(fields).map(([field, version]) => [field, encodeVersion(version)])
    ),
  };
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
    versions: encodeVersions(entry.versions),
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
    versions?: unknown;
    deletedAt?: unknown;
  };
  if (typeof record.id !== "string" || !record.id.length) return null;
  const data = mapData ? mapData(record.data) : (record.data ?? ({} as TOut));
  const decoded = {
    id: record.id,
    pos: decodePosition(record.pos),
    data,
    versions: encodeVersions(record.versions),
    deletedAt:
      typeof record.deletedAt !== "number" || !Number.isFinite(record.deletedAt)
        ? null
        : Math.max(0, Math.floor(record.deletedAt)),
  };
  if (!decoded.pos.length) return null;
  return decoded as OrderedSetEntry<TOut>;
}

/** @internal Exported for its unit tests. */
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

/** @internal Exported for its unit tests. */
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
  note: sanitizeText((data as { note?: unknown })?.note),
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
        note: sanitizeText((entry as { note?: string })?.note),
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
