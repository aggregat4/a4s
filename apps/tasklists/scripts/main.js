import ListsApp from "./lists-app.js";
import { ListRepository } from "../lib/app/list-repository.js";
import { DEFAULT_DB_NAME as LISTS_DB_NAME } from "../lib/storage/list-storage.js";

async function resetPersistentStorageIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("resetStorage")) {
    return;
  }
  if (!("indexedDB" in window)) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const request = indexedDB.deleteDatabase(LISTS_DB_NAME);
      request.onsuccess = finish;
      request.onerror = finish;
      request.onblocked = finish;
    } catch (err) {
      finish();
    }
  });
  try {
    window.localStorage?.clear?.();
  } catch (err) {
    // ignore storage clearing errors
  }
}

async function ensureDemoData(repository, seedConfigs) {
  if (!repository || typeof repository.initialize !== "function") {
    return false;
  }
  await repository.initialize();
  if (!Array.isArray(seedConfigs) || !seedConfigs.length) {
    return false;
  }
  if (
    typeof repository.getListIds === "function" &&
    repository.getListIds().length
  ) {
    return false;
  }
  let previousId = null;
  for (const config of seedConfigs) {
    const listId =
      typeof config.id === "string" && config.id.length
        ? config.id
        : `seed-${crypto.randomUUID()}`;
    await repository.createList({
      listId,
      title: config.title,
      items: Array.isArray(config.items) ? config.items : [],
      afterId: previousId,
    });
    previousId = listId;
  }
  return true;
}

function waitForDocumentReady() {
  if (document.readyState === "loading") {
    return new Promise((resolve) =>
      document.addEventListener("DOMContentLoaded", resolve, { once: true })
    );
  }
  return Promise.resolve();
}

export async function bootstrapListsApp({ seedConfigs } = {}) {
  await waitForDocumentReady();
  const appRoot = document.querySelector("[data-role='lists-app']");
  if (!appRoot) return null;
  const sidebarElement = appRoot.querySelector("[data-role='sidebar']");
  const mainElement = appRoot.querySelector("[data-role='main']");
  const listsContainer = appRoot.querySelector("[data-role='lists-container']");
  const mainTitleElement =
    mainElement?.querySelector("[data-role='active-list-title']") ?? null;
  const moveDialogElement = document.querySelector("[data-role='move-dialog']");
  await resetPersistentStorageIfNeeded();
  const repository = new ListRepository();
  await ensureDemoData(repository, seedConfigs).catch(() => {});
  const app = new ListsApp({
    sidebarElement,
    mainElement,
    listsContainer,
    mainTitleElement,
    moveDialogElement,
    listRepository: repository,
  });
  await app.initialize();
  window.listsApp = app;
  return app;
}

export {
  resetPersistentStorageIfNeeded,
  ensureDemoData,
  waitForDocumentReady,
};
