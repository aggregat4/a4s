import type { ListId } from "../../types/domain.js";

// The active list is kept in the `list` query parameter so a reload, a
// bookmark, or back/forward restores it. Other parameters are left untouched.
const LIST_PARAM = "list";

const readListIdFromUrl = (): ListId | null =>
  new URLSearchParams(window.location.search).get(LIST_PARAM) || null;

const urlForListId = (listId: ListId) => {
  const url = new URL(window.location.href);
  url.searchParams.set(LIST_PARAM, listId);
  return url;
};

// Adds a history entry, for navigation the user chose.
const pushListIdToUrl = (listId: ListId) => {
  if (readListIdFromUrl() === listId) return;
  window.history.pushState(null, "", urlForListId(listId));
};

// Corrects the current entry, for changes the user did not navigate to, such
// as the fallback after deleting a list or opening a URL for an unknown list.
const replaceListIdInUrl = (listId: ListId) => {
  if (readListIdFromUrl() === listId) return;
  window.history.replaceState(window.history.state, "", urlForListId(listId));
};

export { readListIdFromUrl, pushListIdToUrl, replaceListIdInUrl };
