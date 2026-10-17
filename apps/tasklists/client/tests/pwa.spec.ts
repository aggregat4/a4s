import { test, expect } from "./fixtures";
import { openSidebarOptions } from "./helpers/sidebar";

test.describe("PWA", () => {
  test("manifest is served with correct display mode", async ({ page }) => {
    const response = await page.goto("/manifest.json");
    expect(response?.status()).toBe(200);
    const manifest = await response?.json();
    expect(manifest).toMatchObject({
      name: "A4 Tasklists",
      short_name: "Tasklists",
      display: "standalone",
      start_url: ".",
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: expect.stringContaining("icon-192.png"),
          sizes: "192x192",
        }),
        expect.objectContaining({
          src: expect.stringContaining("icon-512.png"),
          sizes: "512x512",
        }),
      ])
    );
  });

  test("service worker is registered", async ({ page }) => {
    await page.goto("/");
    const swState = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) {
        return { supported: false };
      }
      const registration = await navigator.serviceWorker.ready;
      return {
        supported: true,
        active: registration.active?.scriptURL ?? null,
      };
    });
    expect(swState.supported).toBe(true);
    expect(swState.active).toContain("sw.js");
  });

  test("service worker cache name tracks the client version", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => {
      if (!("serviceWorker" in navigator)) return false;
      return navigator.serviceWorker.controller !== null;
    });
    await openSidebarOptions(page);
    const clientVersion = (
      await page.locator("[data-role='app-versions'] dd").nth(1).textContent()
    )?.trim();
    expect(clientVersion).toBeTruthy();
    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames).toContain(`a4-tasklists-${clientVersion}`);
  });

  test("the status line says when changes are not reaching the server", async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      // Without lists the status sits under the main heading.
      const status = page.locator(".lists-main-header a4-sync-status");
      await expect(status).toHaveAttribute("role", "status");
      // Connected is the normal state: the line is empty.
      await expect(status).toHaveText("");

      await page.context().setOffline(true);
      // Playwright may not fire navigator.onLine change automatically in all browsers.
      // Dispatch the event manually to ensure the UI reacts.
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", {
          value: false,
          configurable: true,
        });
        window.dispatchEvent(new Event("offline"));
      });
      await expect(status).toHaveText("Offline. Changes are saved on this device.");
      await expect(status).toBeVisible();

      await page.context().setOffline(false);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", {
          value: true,
          configurable: true,
        });
        window.dispatchEvent(new Event("online"));
      });
      await expect(status).toHaveText("");
    }
  });

  test("app loads from service worker cache when offline", async ({ page }) => {
    await page.goto("/");
    // Wait for the service worker to install and cache assets
    await page.waitForFunction(() => {
      if (!("serviceWorker" in navigator)) return false;
      return navigator.serviceWorker.controller !== null;
    });

    await page.context().setOffline(true);

    // Navigate to the app while offline
    await page.goto("/");
    await page.waitForSelector(".lists-sidebar", { state: "visible" });
    await expect(page.locator(".sidebar-title")).toHaveText("Lists");

    await page.context().setOffline(false);
  });
});

test.describe("server unreachable", () => {
  // The service worker would answer the requests the test fails.
  test.use({ serviceWorkers: "block" });

  test("the status line says when the server cannot be reached", async ({ page }) => {
    await page.route("**/healthz", (route) => route.abort());
    await page.goto("/");
    const status = page.locator(".lists-main-header a4-sync-status");
    await expect(status).toHaveText(
      "Can’t reach the server. Changes are saved on this device."
    );

    await page.unroute("**/healthz");
    await expect(status).toHaveText("", { timeout: 15_000 });
  });
});
