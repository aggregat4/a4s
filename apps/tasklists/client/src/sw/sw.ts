/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = "a4-tasklists-v1";
const ASSET_MANIFEST_URL = "./asset-manifest.json";

const API_PATH_PREFIXES = ["/sync/", "/healthz", "/auth/"];

function isApiRequest(url: URL): boolean {
  return API_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

async function fetchAssetManifest(): Promise<string[]> {
  const response = await fetch(ASSET_MANIFEST_URL, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch asset manifest: ${response.status} ${response.statusText}`
    );
  }
  const assets = (await response.json()) as string[];
  if (!Array.isArray(assets)) {
    throw new Error("Asset manifest is not an array");
  }
  return assets.filter((a) => typeof a === "string");
}

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const assets = await fetchAssetManifest();
      const urlsToCache = new Set([ASSET_MANIFEST_URL, ...assets]);
      await cache.addAll(Array.from(urlsToCache));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  if (isApiRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) {
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        return new Response("Network error", { status: 408 });
      }
    })()
  );
});
