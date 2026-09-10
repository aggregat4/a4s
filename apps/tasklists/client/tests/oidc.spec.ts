import { test, expect } from "./fixtures";

const IDP_ORIGIN = "http://127.0.0.1:8001";
const SESSION_COOKIE = "baselib-oidc-session-cookie";

test.describe("OIDC session reauthentication", () => {
  test("expired session reauthenticates through the identity provider", async ({
    page,
    context,
  }) => {
    const app = page.locator("[data-role='lists-app']");

    // Initial login through the mock identity provider.
    await page.goto("/");
    await expect(app).toBeVisible();

    // Let the service worker install and take control, then make sure it has a
    // cached copy of the app shell. The regression was that this cached shell
    // kept being served after the session expired, so the browser never
    // reached the server's redirect to the identity provider.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null
    );

    let idpAuthorizeRequests = 0;
    page.on("request", (request) => {
      if (request.url().startsWith(`${IDP_ORIGIN}/auth`)) {
        idpAuthorizeRequests += 1;
      }
    });

    // Expire the application session without touching the service worker.
    await context.clearCookies({ name: SESSION_COOKIE });
    expect(
      (await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE)
    ).toBe(false);

    await page.goto("/");

    // The server must have redirected to the identity provider, and the
    // callback must have established a new session.
    await expect(app).toBeVisible();
    expect(page.url()).toBe(`${new URL(page.url()).origin}/`);
    expect(idpAuthorizeRequests).toBeGreaterThan(0);
    expect(
      (await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE)
    ).toBe(true);
  });
});
