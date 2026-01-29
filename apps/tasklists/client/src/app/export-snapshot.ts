import { between, comparePositions } from "../domain/crdt/position.js";
import type { ListId, ListState, RegistryState } from "../types/domain.js";

export const SNAPSHOT_SCHEMA = "net.aggregat4.tasklist.snapshot@v1";

type SnapshotListItem = {
  id: string;
  text: string;
  done: boolean;
  note?: string;
};

type SnapshotList = {
  listId: ListId;
  title: string;
  items: SnapshotListItem[];
};

export type ExportSnapshotEnvelope = {
  schema: string;
  exportedAt: string;
  appVersion?: string;
  data: {
    lists: SnapshotList[];
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

const sanitizeText = (value: unknown) => (typeof value === "string" ? value : "");
const sanitizeBoolean = (value: unknown) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(value);
};

function sortByPosition<T extends { pos?: unknown }>(entries: T[]) {
  return entries.slice().sort((a, b) => comparePositions(a?.pos, b?.pos));
}

function buildSnapshotLists(
  registryState: RegistryState,
  lists: Array<{ listId: ListId; state: ListState }>
): SnapshotList[] {
  const listMap = new Map<ListId, ListState>();
  lists.forEach((entry) => {
    if (!entry?.listId) return;
    listMap.set(entry.listId, entry.state);
  });

  const registryEntries = Array.isArray(registryState?.entries)
    ? registryState.entries
    : [];
  const orderedRegistry = sortByPosition(
    registryEntries.filter((entry) => entry && entry.deletedAt == null)
  );

  return orderedRegistry
    .map((entry) => {
      const listState = listMap.get(entry.id);
      if (!listState) return null;
      const title =
        sanitizeText(listState.title) || sanitizeText(entry.data?.title);
      const entries = Array.isArray(listState.entries)
        ? listState.entries.filter((item) => item && item.deletedAt == null)
        : [];
      const items = sortByPosition(entries).map((item) => {
        const note = sanitizeText(item?.data?.note);
        const payload: SnapshotListItem = {
          id: item.id,
          text: sanitizeText(item?.data?.text),
          done: sanitizeBoolean(item?.data?.done),
        };
        if (note.length) {
          payload.note = note;
        }
        return payload;
      });
      return {
        listId: entry.id,
        title,
        items,
      };
    })
    .filter((entry): entry is SnapshotList => Boolean(entry));
}

function buildOrderedEntries<TData extends Record<string, unknown>>(
  items: Array<{ id: string; data: TData }>,
  actor: string
) {
  let previousPosition: ReturnType<typeof between> | null = null;
  return items.map((item, index) => {
    const position = between(previousPosition, null, { actor });
    previousPosition = position;
    const time = index + 1;
    return {
      id: item.id,
      pos: position,
      data: item.data,
      createdAt: time,
      updatedAt: time,
      deletedAt: null,
    };
  });
}

export function buildExportSnapshot(input: ExportSnapshotInput): ExportSnapshotEnvelope {
  const exportedAt =
    typeof input.exportedAt === "string" && input.exportedAt.length
      ? input.exportedAt
      : new Date().toISOString();
  const lists = buildSnapshotLists(input.registryState, input.lists);
  const payload: ExportSnapshotEnvelope = {
    schema: SNAPSHOT_SCHEMA,
    exportedAt,
    data: {
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
  const data = record.data as { lists?: unknown };
  const listsInput = Array.isArray(data.lists) ? data.lists : null;
  if (!listsInput) {
    return { ok: false, error: "Snapshot lists are missing." };
  }
  const actor = "snapshot-import";
  const snapshotLists = listsInput
    .map((entry) => {
      const candidate = entry as {
        listId?: unknown;
        title?: unknown;
        items?: unknown;
      };
      const listId =
        typeof candidate.listId === "string" && candidate.listId.length
          ? candidate.listId
          : `list-${crypto.randomUUID()}`;
      const title = sanitizeText(candidate.title);
      const itemsInput = Array.isArray(candidate.items) ? candidate.items : [];
      const items = itemsInput.map((item) => {
        const record = item as {
          id?: unknown;
          text?: unknown;
          done?: unknown;
          note?: unknown;
        };
        const id =
          typeof record.id === "string" && record.id.length
            ? record.id
            : `task-${crypto.randomUUID()}`;
        return {
          id,
          text: sanitizeText(record.text),
          done: sanitizeBoolean(record.done),
          note: sanitizeText(record.note),
        };
      });
      return {
        listId,
        title,
        items,
      };
    })
    .filter((entry) => entry.listId.length);

  const registryEntries = buildOrderedEntries(
    snapshotLists.map((list) => ({
      id: list.listId,
      data: { title: list.title },
    })),
    actor
  );
  const registryState: RegistryState = {
    clock: registryEntries.length + 1,
    entries: registryEntries,
  };
  const lists = snapshotLists.map((list) => {
    const listEntries = buildOrderedEntries(
      list.items.map((item) => ({
        id: item.id,
        data: {
          text: sanitizeText(item.text),
          done: sanitizeBoolean(item.done),
          note: sanitizeText(item.note),
        },
      })),
      actor
    );
    return {
      listId: list.listId,
      state: {
        clock: listEntries.length + 1,
        title: list.title,
        titleUpdatedAt: 1,
        entries: listEntries,
      },
    };
  });
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
