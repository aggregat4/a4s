import { test, expect } from "./fixtures";

test("embedded static mode serves html, css, and js assets", async ({
  page,
  request,
}) => {
  const indexResponse = await request.get("/");
  expect(indexResponse.status()).toBe(200);
  expect(indexResponse.headers()["content-type"]).toContain("text/html");
  const indexBody = await indexResponse.text();
  expect(indexBody).toContain("<!doctype html>");

  const cssResponse = await request.get("/styles.css");
  expect(cssResponse.status()).toBe(200);
  expect(cssResponse.headers()["content-type"]).toContain("text/css");
  const cssBody = await cssResponse.text();
  expect(cssBody).toContain("--space-xs");
  expect(cssBody).not.toContain("<!doctype html>");

  const mainJsResponse = await request.get("/entrypoints/main.js");
  expect(mainJsResponse.status()).toBe(200);
  expect(mainJsResponse.headers()["content-type"]).toContain("javascript");
  const mainJsBody = await mainJsResponse.text();
  expect(mainJsBody.length).toBeGreaterThan(0);
  expect(mainJsBody).toContain("bootstrapListsApp");
  expect(mainJsBody).not.toContain("<!doctype html>");

  await page.goto("/?resetStorage=1");
  await expect(page.locator("[data-role='lists-app']")).toBeVisible();
});

test("embedded static mode returns 404 for invalid routes", async ({
  request,
}) => {
  const response = await request.get("/lists/inbox");
  expect(response.status()).toBe(404);
});
