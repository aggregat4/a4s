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

function shouldEnableSync() {
  const params = new URLSearchParams(window.location.search);
  return window.location.port === "8080" || params.get("sync") === "1";
}

const SYNC_HEALTH_TIMEOUT_MS = 2000;
const SYNC_BACKOFF_START_MS = 500;
const SYNC_BACKOFF_MAX_MS = 10_000;

function createSyncAvailabilityMonitor({
  repository,
  baseUrl,
}: {
  repository: ListRepository;
  baseUrl: string;
}) {
  let stopped = false;
  let timer: number | null = null;
  let backoffMs = SYNC_BACKOFF_START_MS;

  const scheduleRetry = () => {
    if (stopped) return;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, SYNC_BACKOFF_MAX_MS);
    timer = window.setTimeout(() => {
      void check();
    }, delay);
  };

  const check = async () => {
    if (stopped) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      SYNC_HEALTH_TIMEOUT_MS
    );
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        method: "GET",
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      if (response.ok) {
        backoffMs = SYNC_BACKOFF_START_MS;
        await repository.enableSync(baseUrl, {
          onConnectionError: () => {
            repository.disableSync();
            scheduleRetry();
          },
        });
        return;
      }
    } catch (err) {
      window.clearTimeout(timeout);
    }
    repository.disableSync();
    scheduleRetry();
  };

  return {
    start() {
      stopped = false;
      backoffMs = SYNC_BACKOFF_START_MS;
      void check();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
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
  const enableSync = shouldEnableSync();
  const enableDemoSeed =
    new URLSearchParams(window.location.search).get("demo") === "1";
  const repository = new ListRepository({
    sync: null,
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
  if (enableSync) {
    const monitor = createSyncAvailabilityMonitor({
      repository,
      baseUrl: window.location.origin,
    });
    monitor.start();
  }
  window.listsApp = appRoot;
  return appRoot;
}

export {
  resetPersistentStorageIfNeeded,
  waitForDocumentReady,
};
