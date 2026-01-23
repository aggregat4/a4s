import { test, expect } from "./fixtures";

const listItemsSelector =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])";

test("sync propagates tasks between clients", async ({ browser }) => {
  test.skip(
    process.env.PLAYWRIGHT_USE_GO_SERVER !== "1",
    "requires Go server"
  );

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await pageA.goto("/?sync=1&resetStorage=1");
    await pageB.goto("/?sync=1&resetStorage=1");

    const uniqueText = `Sync task ${Date.now()}`;
    await pageA.getByRole("button", { name: "Add task" }).click();
    const editor = pageA.locator(listItemsSelector).first().locator(".text");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill(uniqueText);
    await pageA.keyboard.press("Escape");
    await expect(editor).not.toHaveAttribute("contenteditable", "true");

    await pageA.waitForRequest(
      (request) =>
        request.url().includes("/sync/push") &&
        (request.postData() ?? "").includes(uniqueText),
      { timeout: 10_000 }
    );

    const remoteTask = pageB.locator(listItemsSelector).locator(".text", {
      hasText: uniqueText,
    });
    await expect(remoteTask).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
