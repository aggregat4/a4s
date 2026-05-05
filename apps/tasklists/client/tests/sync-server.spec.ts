import type { Page } from "@playwright/test";
import {
  buildExportSnapshot,
  stringifyExportSnapshot,
} from "../src/app/export-snapshot.js";
import { test, expect } from "./fixtures";

const listItemsSelector =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])";

function buildEmptySnapshotPayload() {
  return stringifyExportSnapshot(
    buildExportSnapshot({
      registryState: { clock: 0, entries: [] },
      lists: [],
    })
  );
}

async function createList(page: Page, title: string) {
  page.once("dialog", async (dialog) => {
    await dialog.accept(title);
  });
  await page.getByRole("button", { name: "Add list" }).click();
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

async function addTask(page: Page, text: string) {
  await page.getByRole("button", { name: "Add task" }).click();
  const editor = page
    .locator(listItemsSelector)
    .locator(".text[contenteditable='true']")
    .first();
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.fill(text);
  await page.keyboard.press("Escape");
  await expect(taskItem(page, text)).toBeVisible({ timeout: 10_000 });
}

async function setShowDone(page: Page, value: boolean) {
  const toggle = page.locator(".tasklist-show-done-toggle");
  await expect(toggle).toBeVisible();
  if (value) {
    await toggle.check();
  } else {
    await toggle.uncheck();
  }
  await expect(toggle).toBeChecked({ checked: value });
}

function taskItem(page: Page, text: string) {
  return page.locator(listItemsSelector).filter({ hasText: text }).first();
}

async function completeTask(page: Page, text: string) {
  const item = taskItem(page, text);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.locator("input.done-toggle").check();
  await expect(item).toHaveAttribute("data-done", "true");
}

async function deleteTask(page: Page, text: string) {
  const item = taskItem(page, text);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.locator(".task-item-toggle").click();
  const deleteButton = item.locator(".task-item-actions button", {
    hasText: "Delete",
  });
  await expect(deleteButton).toBeVisible();
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await deleteButton.click();
  await expect(taskItem(page, text)).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  const response = await request.post("/sync/reset", {
    data: {
      clientId: `e2e-${crypto.randomUUID()}`,
      datasetGenerationKey: crypto.randomUUID(),
      snapshot: buildEmptySnapshotPayload(),
    },
  });
  expect(response.ok()).toBe(true);
});

test("interleaved clients converge after completing and deleting tasks", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await Promise.all([
      pageA.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageA.goto("/"),
    ]);
    await Promise.all([
      pageB.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageB.goto("/"),
    ]);

    const listTitle = `Interleaved ${Date.now()}`;
    const alpha = `Alpha ${crypto.randomUUID()}`;
    const beta = `Beta ${crypto.randomUUID()}`;
    const gamma = `Gamma ${crypto.randomUUID()}`;

    await createList(pageA, listTitle);
    await selectList(pageB, listTitle);
    await setShowDone(pageA, true);
    await setShowDone(pageB, true);

    await addTask(pageA, alpha);
    await expect(taskItem(pageB, alpha)).toBeVisible({ timeout: 10_000 });

    await addTask(pageB, beta);
    await expect(taskItem(pageA, beta)).toBeVisible({ timeout: 10_000 });

    await completeTask(pageA, alpha);
    await expect(taskItem(pageB, alpha)).toHaveAttribute("data-done", "true", {
      timeout: 10_000,
    });

    await completeTask(pageB, beta);
    await expect(taskItem(pageA, beta)).toHaveAttribute("data-done", "true", {
      timeout: 10_000,
    });

    await deleteTask(pageA, alpha);
    await expect(taskItem(pageB, alpha)).toHaveCount(0, { timeout: 10_000 });
    await expect(taskItem(pageB, beta)).toHaveAttribute("data-done", "true");

    await deleteTask(pageB, beta);
    await expect(taskItem(pageA, beta)).toHaveCount(0, { timeout: 10_000 });
    await expect(taskItem(pageA, alpha)).toHaveCount(0);

    await addTask(pageA, gamma);
    await expect(taskItem(pageB, gamma)).toBeVisible({ timeout: 10_000 });
    await expect(taskItem(pageB, alpha)).toHaveCount(0);
    await expect(taskItem(pageB, beta)).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("sync propagates tasks between clients", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await Promise.all([
      pageA.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageA.goto("/"),
    ]);
    await Promise.all([
      pageB.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageB.goto("/"),
    ]);
    await createList(pageA, "Sync List");
    await selectList(pageB, "Sync List");

    const uniqueText = `Sync task ${Date.now()}`;
    await addTask(pageA, uniqueText);

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
    await Promise.all([
      pageA.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageA.goto("/?sync=1&resetStorage=1"),
    ]);
    await createList(pageA, "Bootstrap List");

    const uniqueText = `Bootstrap task ${Date.now()}`;
    await addTask(pageA, uniqueText);

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
      await Promise.all([
        pageB.waitForResponse((response) =>
          response.url().includes("/sync/bootstrap")
        ),
        pageB.goto("/?sync=1&resetStorage=1"),
      ]);
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

test.afterAll(async ({ request }) => {
  const response = await request.post("/sync/reset", {
    data: {
      clientId: `e2e-${crypto.randomUUID()}`,
      datasetGenerationKey: crypto.randomUUID(),
      snapshot: buildEmptySnapshotPayload(),
    },
  });
  expect(response.ok()).toBe(true);
});
