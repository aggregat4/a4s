import {
  serializeRegistryState,
  serializeListState,
  deserializeRegistryState,
  deserializeListState,
} from "../storage/serde.js";
import type { ListId, ListState, RegistryState } from "../types/domain.js";

export const SNAPSHOT_SCHEMA = "net.aggregat4.tasklist.snapshot@v1";

type SerializedRegistryState = ReturnType<typeof serializeRegistryState>;
type SerializedListState = ReturnType<typeof serializeListState>;

export type ExportSnapshotEnvelope = {
  schema: string;
  exportedAt: string;
  appVersion?: string;
  data: {
    registry: SerializedRegistryState;
    lists: Array<{ listId: ListId; state: SerializedListState }>;
  };
};

export type ExportSnapshotInput = {
  registryState: RegistryState;
  lists: Array<{ listId: ListId; state: ListState }>;
  exportedAt?: string;
  appVersion?: string;
};

export type ParsedSnapshot = {
  registryState: RegistryState;
  lists: Array<{ listId: ListId; state: ListState }>;
  exportedAt?: string;
  appVersion?: string;
};

export function buildExportSnapshot(input: ExportSnapshotInput): ExportSnapshotEnvelope {
  const exportedAt =
    typeof input.exportedAt === "string" && input.exportedAt.length
      ? input.exportedAt
      : new Date().toISOString();
  const registry = serializeRegistryState(input.registryState);
  const lists = Array.isArray(input.lists)
    ? input.lists
        .filter((entry) => typeof entry?.listId === "string" && entry.listId.length)
        .map((entry) => ({
          listId: entry.listId,
          state: serializeListState(entry.state),
        }))
    : [];
  const payload: ExportSnapshotEnvelope = {
    schema: SNAPSHOT_SCHEMA,
    exportedAt,
    data: {
      registry,
      lists,
    },
  };
  if (typeof input.appVersion === "string" && input.appVersion.length) {
    payload.appVersion = input.appVersion;
  }
  return payload;
}

export function stringifyExportSnapshot(snapshot: ExportSnapshotEnvelope) {
  return JSON.stringify(snapshot, null, 2);
}

export function parseExportSnapshot(raw: unknown):
  | { ok: true; value: ParsedSnapshot }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Snapshot is not an object." };
  }
  const record = raw as {
    schema?: unknown;
    exportedAt?: unknown;
    appVersion?: unknown;
    data?: unknown;
  };
  if (record.schema !== SNAPSHOT_SCHEMA) {
    return { ok: false, error: "Snapshot schema is not supported." };
  }
  if (!record.data || typeof record.data !== "object") {
    return { ok: false, error: "Snapshot data is missing." };
  }
  const data = record.data as {
    registry?: unknown;
    lists?: unknown;
  };
  if (!data.registry || typeof data.registry !== "object") {
    return { ok: false, error: "Snapshot registry state is missing." };
  }
  const registryState = deserializeRegistryState(data.registry);
  const lists = Array.isArray(data.lists)
    ? data.lists
        .map((entry) => {
          const candidate = entry as { listId?: unknown; state?: unknown };
          if (typeof candidate.listId !== "string" || !candidate.listId.length) {
            return null;
          }
          if (!candidate.state || typeof candidate.state !== "object") {
            return null;
          }
          return {
            listId: candidate.listId,
            state: deserializeListState(candidate.state),
          } as { listId: ListId; state: ListState };
        })
        .filter((entry): entry is { listId: ListId; state: ListState } => Boolean(entry))
    : [];
  const exportedAt =
    typeof record.exportedAt === "string" ? record.exportedAt : undefined;
  const appVersion =
    typeof record.appVersion === "string" ? record.appVersion : undefined;
  return {
    ok: true,
    value: {
      registryState,
      lists,
      exportedAt,
      appVersion,
    },
  };
}

export function parseExportSnapshotText(text: string):
  | { ok: true; value: ParsedSnapshot }
  | { ok: false; error: string } {
  if (typeof text !== "string" || !text.length) {
    return { ok: false, error: "Snapshot file is empty." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "Snapshot JSON is invalid." };
  }
  return parseExportSnapshot(parsed);
}
