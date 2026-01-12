import { ListRepository } from "../lib/app/list-repository.js";
import { DEFAULT_DB_NAME as LISTS_DB_NAME } from "../lib/storage/list-storage.js";
import "./components/app-shell.js";

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
  await customElements.whenDefined("a4-lists-app");
  let appRoot = document.querySelector("[data-role='lists-app']");
  if (!appRoot) {
    appRoot = document.createElement("a4-lists-app");
    appRoot.dataset.role = "lists-app";
    document.body.appendChild(appRoot);
  }
  if (!appRoot) return null;
  if (typeof customElements.upgrade === "function") {
    customElements.upgrade(appRoot);
  }
  await resetPersistentStorageIfNeeded();
  const repository = new ListRepository();
  await ensureDemoData(repository, seedConfigs).catch(() => {});
  if (typeof appRoot.initialize === "function") {
    await appRoot.initialize({ repository });
  }
  window.listsApp = appRoot;
  return appRoot;
}

export {
  resetPersistentStorageIfNeeded,
  ensureDemoData,
  waitForDocumentReady,
};
