import type { ListId } from "../../types/domain.js";

// Navigation state lives in query parameters so a reload, a bookmark, or
// back/forward restores it: `list` is the active list and `q` the search.
// Other parameters are left untouched.
const LIST_PARAM = "list";
const SEARCH_PARAM = "q";

const readParam = (name: string) =>
  new URLSearchParams(window.location.search).get(name) || null;

// "push" adds a history entry, for navigation the user chose. "replace"
// corrects the current entry, for changes the user did not navigate to (such
// as the fallback after deleting a list) and for typing into the search.
const writeParam = (
  name: string,
  value: string | null,
  mode: "push" | "replace"
) => {
  const next = value || null;
  if (readParam(name) === next) return;
  const url = new URL(window.location.href);
  if (next) {
    url.searchParams.set(name, next);
  } else {
    url.searchParams.delete(name);
  }
  if (mode === "push") {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(window.history.state, "", url);
  }
};

const readListIdFromUrl = (): ListId | null => readParam(LIST_PARAM);
const pushListIdToUrl = (listId: ListId) =>
  writeParam(LIST_PARAM, listId, "push");
const replaceListIdInUrl = (listId: ListId) =>
  writeParam(LIST_PARAM, listId, "replace");

const readSearchFromUrl = () => readParam(SEARCH_PARAM) ?? "";
const pushSearchToUrl = (query: string) =>
  writeParam(SEARCH_PARAM, query.trim(), "push");
const replaceSearchInUrl = (query: string) =>
  writeParam(SEARCH_PARAM, query.trim(), "replace");

export {
  pushListIdToUrl,
  pushSearchToUrl,
  readListIdFromUrl,
  readSearchFromUrl,
  replaceListIdInUrl,
  replaceSearchInUrl,
};
