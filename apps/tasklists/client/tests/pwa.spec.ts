import { test, expect } from "./fixtures";

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

  test("connectivity indicator reflects online/offline state", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".lists-sidebar", { state: "visible" });

    const indicator = page.locator(".sidebar-sync-indicator");
    await expect(indicator).toHaveClass(/is-connected/);
    await expect(indicator).toHaveAttribute("title", "Connected");
    await expect(indicator).toHaveText("●");

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

    await expect(indicator).toHaveClass(/is-disconnected/);
    await expect(indicator).toHaveAttribute("title", "Disconnected");
    await expect(indicator).toHaveText("×");

    await page.context().setOffline(false);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        value: true,
        configurable: true,
      });
      window.dispatchEvent(new Event("online"));
    });

    await expect(indicator).toHaveClass(/is-connected/);
    await expect(indicator).toHaveAttribute("title", "Connected");
    await expect(indicator).toHaveText("●");
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
