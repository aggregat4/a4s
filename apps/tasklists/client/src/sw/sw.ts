/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = "a4-tasklists-v2";
const ASSET_MANIFEST_URL = "./asset-manifest.json";

const API_PATH_PREFIXES = ["/sync/", "/healthz", "/auth/"];

function isApiRequest(url: URL): boolean {
  return API_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isIndexHtml(url: URL): boolean {
  return url.pathname === "/" || url.pathname === "/index.html";
}

function isHashedAsset(url: URL): boolean {
  return url.pathname.startsWith("/chunks/");
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    const networkResponse = await fetch(request, { cache: "no-store" });
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    return new Response("Network error", { status: 408 });
  }
}

async function navigateIndex(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = new URL("/index.html", request.url).href;
  try {
    // Always consult the network for the app shell. The document is gated by
    // the server, so an expired session must produce the server's redirect to
    // the identity provider instead of a cached copy. Do not follow redirects
    // here so the browser processes the OAuth Set-Cookie on the 302 itself.
    const networkResponse = await fetch(request, {
      redirect: "manual",
      cache: "no-store",
    });
    if (
      networkResponse.type === "opaqueredirect" ||
      (networkResponse.status >= 300 && networkResponse.status < 400)
    ) {
      return networkResponse;
    }
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
      if (new URL(request.url).pathname === "/") {
        await cache.put(indexUrl, networkResponse.clone());
      }
    }
    return networkResponse;
  } catch {
    const cached =
      (await cache.match(request)) ?? (await cache.match(indexUrl));
    if (cached) {
      return cached;
    }
    return new Response("Network error", { status: 408 });
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const networkResponse = await fetch(request);
  if (networkResponse.ok) {
    cache.put(request, networkResponse.clone());
  }
  return networkResponse;
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => {
      if (cached) {
        return cached;
      }
      return new Response("Network error", { status: 408 });
    });

  return cached ?? fetchPromise;
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

// Cache a clean copy of the app shell under both "/" and "/index.html". The
// manifest-driven install normally fetches "/index.html", which the server
// redirects to "/"; the resulting redirected response cannot be returned for a
// navigation, so it must not be what offline mode falls back to.
async function cacheAppShell(cache: Cache): Promise<void> {
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) {
    return;
  }
  const rootUrl = new URL("/", self.location.origin).href;
  const indexUrl = new URL("/index.html", self.location.origin).href;
  await cache.put(rootUrl, response.clone());
  await cache.put(indexUrl, response);
}

async function cleanUpCache() {
  const cache = await caches.open(CACHE_NAME);
  const manifestResponse = await cache.match(ASSET_MANIFEST_URL);
  if (!manifestResponse) {
    return;
  }

  const assets = (await manifestResponse.json()) as string[];
  const validUrls = new Set(
    [ASSET_MANIFEST_URL, ...assets].map(
      (path) => new URL(path, self.location.origin).href
    )
  );

  // Preserve the HTML shell so offline still works
  const indexUrl = new URL("/index.html", self.location.origin).href;
  const rootUrl = new URL("/", self.location.origin).href;

  const requests = await cache.keys();
  for (const request of requests) {
    if (request.url === indexUrl || request.url === rootUrl) {
      continue;
    }
    if (!validUrls.has(request.url)) {
      await cache.delete(request);
    }
  }
}

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const assets = await fetchAssetManifest();
      const urlsToCache = new Set([ASSET_MANIFEST_URL, ...assets]);
      await cache.addAll(Array.from(urlsToCache));
      await cacheAppShell(cache);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await cleanUpCache();
    })()
  );
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

  if (request.mode === "navigate" && isIndexHtml(url)) {
    event.respondWith(navigateIndex(request));
    return;
  }

  if (isIndexHtml(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
