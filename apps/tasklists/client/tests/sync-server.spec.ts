import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const listItemsSelector =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])";

async function createList(page: Page, title: string) {
  page.once("dialog", async (dialog) => {
    await dialog.accept(title);
  });
  await page.getByRole("button", { name: "Add list" }).click();
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    title
  );
}

async function selectList(page: Page, title: string) {
  const listButton = page
    .locator("[data-role='sidebar-list'] .sidebar-list-button")
    .filter({ hasText: title })
    .first();
  await expect(listButton).toBeVisible({ timeout: 10_000 });
  await listButton.click();
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    title
  );
}

test("sync propagates tasks between clients", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await pageA.goto("/?sync=1&resetStorage=1");
    await pageB.goto("/?sync=1&resetStorage=1");
    await createList(pageA, "Sync List");
    await selectList(pageB, "Sync List");

    const uniqueText = `Sync task ${Date.now()}`;
    await pageA.getByRole("button", { name: "Add task" }).click();
    const editor = pageA.locator(listItemsSelector).first().locator(".text");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill(uniqueText);
    await pageA.keyboard.press("Escape");
    await expect(editor).not.toHaveAttribute("contenteditable", "true");

    await pageA.waitForResponse(
      (response) =>
        response.url().includes("/sync/push") &&
        response.status() === 200 &&
        (response.request().postData() ?? "").includes(uniqueText),
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

test("late client bootstraps from existing data", async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  try {
    await pageA.goto("/?sync=1&resetStorage=1");
    await createList(pageA, "Bootstrap List");

    const uniqueText = `Bootstrap task ${Date.now()}`;
    await pageA.getByRole("button", { name: "Add task" }).click();
    const editor = pageA.locator(listItemsSelector).first().locator(".text");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill(uniqueText);
    await pageA.keyboard.press("Escape");
    await expect(editor).not.toHaveAttribute("contenteditable", "true");

    await pageA.waitForResponse(
      (response) =>
        response.url().includes("/sync/push") &&
        response.status() === 200 &&
        (response.request().postData() ?? "").includes(uniqueText),
      { timeout: 10_000 }
    );

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await pageB.goto("/?sync=1&resetStorage=1");
      await pageB.waitForResponse(
        (response) =>
          response.url().includes("/sync/bootstrap") &&
          response.status() === 200
      );
      await selectList(pageB, "Bootstrap List");
      const remoteTask = pageB.locator(listItemsSelector).locator(".text", {
        hasText: uniqueText,
      });
      await expect(remoteTask).toHaveCount(1, { timeout: 10_000 });
    } finally {
      await contextB.close();
    }
  } finally {
    await contextA.close();
  }
});
