import { ListRepository } from "../app/list-repository.js";
import { DEFAULT_DB_NAME as LISTS_DB_NAME } from "../storage/list-storage.js";
import type { SeedConfig } from "../app/demo-seed.js";
import "../ui/components/app-shell.js";

async function resetPersistentStorageIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("resetStorage")) {
    return;
  }
  if (!("indexedDB" in window)) {
    return;
  }
  await new Promise<void>((resolve) => {
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


function waitForDocumentReady() {
  if (document.readyState === "loading") {
    return new Promise<void>((resolve) =>
      document.addEventListener("DOMContentLoaded", () => resolve(), {
        once: true,
      })
    );
  }
  return Promise.resolve();
}

async function resolveSyncBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const enableSync =
    window.location.port === "8080" || params.get("sync") === "1";
  if (!enableSync) {
    return null;
  }
  try {
    const response = await fetch(`${window.location.origin}/healthz`, {
      method: "GET",
    });
    if (response.ok) {
      return window.location.origin;
    }
  } catch (err) {
    // Ignore network failures; sync stays disabled.
  }
  return null;
}

export async function bootstrapListsApp(
  { seedConfigs }: { seedConfigs?: SeedConfig[] } = {}
) {
  await waitForDocumentReady();
  await customElements.whenDefined("a4-lists-app");
  let appRoot = document.querySelector(
    "[data-role='lists-app']"
  ) as HTMLElement | null;
  if (!appRoot) {
    appRoot = document.createElement("a4-lists-app") as HTMLElement;
    appRoot.dataset.role = "lists-app";
    document.body.appendChild(appRoot);
  }
  if (typeof customElements.upgrade === "function") {
    customElements.upgrade(appRoot);
  }
  await resetPersistentStorageIfNeeded();
  const syncBaseUrl = await resolveSyncBaseUrl();
  const enableDemoSeed =
    new URLSearchParams(window.location.search).get("demo") === "1";
  const repository = new ListRepository({
    sync: syncBaseUrl ? { baseUrl: syncBaseUrl } : null,
  });
  const appRootElement = appRoot as HTMLElement & {
    initialize?: (options: {
      repository: ListRepository;
      seedConfigs?: SeedConfig[];
      enableDemoSeed?: boolean;
    }) => Promise<void> | void;
  };
  if (typeof appRootElement.initialize === "function") {
    await appRootElement.initialize({
      repository,
      seedConfigs,
      enableDemoSeed,
    });
  }
  window.listsApp = appRoot;
  return appRoot;
}

export {
  resetPersistentStorageIfNeeded,
  waitForDocumentReady,
};
