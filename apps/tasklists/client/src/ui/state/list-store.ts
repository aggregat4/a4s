import type { TaskItem, TaskListState } from "../../types/domain.js";

type HeaderError = { message: string; code?: string } | null;

export const normalizeHeaderError = (value: unknown): HeaderError => {
  if (!value) return null;
  const message =
    typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : null;
  if (!message) return null;
  const code =
    typeof (value as { code?: unknown }).code === "string"
      ? (value as { code: string }).code
      : null;
  return code ? { message, code } : { message };
};

export const cloneListState = (source: unknown): TaskListState => ({
  title:
    typeof (source as { title?: unknown })?.title === "string"
      ? (source as { title: string }).title
      : "",
  items: Array.isArray((source as { items?: TaskItem[] })?.items)
    ? (source as { items: TaskItem[] }).items.map((item, index) => ({
        id:
          typeof item?.id === "string" && item.id.length
            ? item.id
            : `item-${index}`,
        text: typeof item?.text === "string" ? item.text : "",
        done: Boolean(item?.done),
        note: typeof item?.note === "string" ? item.note : "",
      }))
    : [],
  headerError: normalizeHeaderError(
    (source as { headerError?: HeaderError | null })?.headerError
  ),
});

export const generateItemId = () => `task-${crypto.randomUUID()}`;
export const generateListId = (prefix = "list") =>
  `${prefix}-${crypto.randomUUID()}`;
