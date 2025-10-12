import { test, expect, Page, Locator } from "@playwright/test";
import { resolve } from "path";
import { pathToFileURL } from "url";

const appUrl = pathToFileURL(resolve(__dirname, "..", "index.html")).href;
const listItemsSelector = "ol.tasklist li:not(.placeholder)";

function showDoneToggle(page: Page) {
  return page.getByRole("checkbox", { name: "Show done" });
}

async function setShowDone(page: Page, value: boolean) {
  const toggle = showDoneToggle(page);
  if (value) {
    await toggle.check();
  } else {
    await toggle.uncheck();
  }
  return toggle;
}

async function addTask(page: Page, text: string) {
  await page.getByRole("button", { name: "Add task" }).click();
  const editor = page.locator(listItemsSelector).first().locator(".text");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.fill(text);
  await page.keyboard.press("Escape");
  await expect(editor).not.toHaveAttribute("contenteditable", "true");
  return editor;
}

async function setCaretPosition(target: Locator, position: number) {
  await target.evaluate((el, offset) => {
    const selection = el.ownerDocument.getSelection();
    if (!selection) return;
    const textNode =
      el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE
        ? (el.firstChild as Text)
        : null;
    if (!textNode) return;
    const safeOffset = Math.max(
      0,
      Math.min(offset ?? 0, textNode.textContent?.length ?? 0)
    );
    const range = el.ownerDocument.createRange();
    range.setStart(textNode, safeOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, position);
}

test.beforeEach(async ({ page }) => {
  await page.goto(appUrl);
  await expect(
    page.getByRole("heading", { name: "Prototype Tasks" })
  ).toBeVisible();
});

test("user can add, complete, and filter tasks", async ({ page }) => {
  await page.getByRole("button", { name: "Add task" }).click();

  const topTask = page.locator(listItemsSelector).first().locator(".text");
  await expect(topTask).toHaveAttribute("contenteditable", "true");

  await topTask.fill("Playwright smoke task");
  await page.keyboard.press("Escape");

  await expect(topTask).toHaveText("Playwright smoke task");

  const checkbox = page
    .locator(listItemsSelector)
    .first()
    .locator("input.done-toggle");
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  const hiddenLocator = page.locator("ol.tasklist li[hidden]");
  await expect(hiddenLocator).toHaveCount(1);
  await setShowDone(page, true);
  await expect(hiddenLocator).toHaveCount(0);

  const searchInput = page.getByRole("searchbox", { name: "Search tasks" });
  await searchInput.fill("playwright");

  const visibleTasks = page.locator(
    "ol.tasklist li:not(.placeholder):not([hidden])"
  );
  await expect(visibleTasks).toHaveCount(1);
  await expect(visibleTasks.first().locator(".text")).toContainText(
    "Playwright smoke task"
  );
});

test("editing commits changes when escape is pressed", async ({ page }) => {
  const firstItem = page.locator(listItemsSelector).first().locator(".text");
  await firstItem.click();
  await expect(firstItem).toHaveAttribute("contenteditable", "true");

  await firstItem.fill("Updated task title");
  await page.keyboard.press("Escape");

  await expect(firstItem).toHaveText("Updated task title");
  await expect(firstItem).not.toHaveAttribute("contenteditable", "true");
});

test("pressing enter splits the current task into two", async ({ page }) => {
  await addTask(page, "SplitHere");
  const items = page.locator(listItemsSelector);
  const countBefore = await items.count();
  const firstItem = items.first().locator(".text");

  await firstItem.click();
  await setCaretPosition(firstItem, 5);
  await page.keyboard.press("Enter");

  await expect(items).toHaveCount(countBefore + 1);
  await expect(items.nth(0).locator(".text")).toHaveText("Split");
  const secondText = items.nth(1).locator(".text");
  await expect(secondText).toHaveText("Here");
  await expect(secondText).toHaveAttribute("contenteditable", "true");
});

test("backspace at start merges the task with the previous item", async ({
  page,
}) => {
  const itemsBefore = page.locator(listItemsSelector);
  const initialCount = await itemsBefore.count();
  const firstTextLocator = itemsBefore.nth(0).locator(".text");
  const secondTextLocator = itemsBefore.nth(1).locator(".text");

  const firstText = (await firstTextLocator.textContent())?.trim() ?? "";
  const secondText = (await secondTextLocator.textContent())?.trim() ?? "";

  await secondTextLocator.click();
  await setCaretPosition(secondTextLocator, 0);
  await page.keyboard.press("Backspace");

  const itemsAfter = page.locator(listItemsSelector);
  await expect(itemsAfter).toHaveCount(initialCount - 1);
  const mergedTextLocator = itemsAfter.nth(0).locator(".text");
  await expect(mergedTextLocator).toContainText(firstText);
  await expect(mergedTextLocator).toContainText(secondText);
});

test("backspace removes an empty new task", async ({ page }) => {
  const itemsBefore = page.locator(listItemsSelector);
  const initialCount = await itemsBefore.count();

  await page.getByRole("button", { name: "Add task" }).click();
  const newTask = page.locator(listItemsSelector).first().locator(".text");
  await expect(newTask).toHaveAttribute("contenteditable", "true");
  await page.keyboard.press("Backspace");

  const itemsAfter = page.locator(listItemsSelector);
  await expect(itemsAfter).toHaveCount(initialCount);
});

test("search highlights matching tokens and clears after reset", async ({
  page,
}) => {
  const searchInput = page.getByRole("searchbox", { name: "Search tasks" });
  await searchInput.fill("bird");

  const visible = page.locator(
    "ol.tasklist li:not(.placeholder):not([hidden])"
  );
  await expect(visible).toHaveCount(1);
  await expect(page.locator("ol.tasklist mark")).toHaveCount(1);
  await expect(page.locator("ol.tasklist mark").first()).toHaveText(/bird/i);

  await searchInput.fill("");
  await expect(page.locator("ol.tasklist mark")).toHaveCount(0);
});

test("completed tasks stay checked after performing a search", async ({
  page,
}) => {
  const items = page.locator(listItemsSelector);
  const checkbox = items.nth(0).locator("input.done-toggle");
  await setShowDone(page, true);
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  const searchInput = page.getByRole("searchbox", { name: "Search tasks" });
  await searchInput.fill("fridge");
  await searchInput.fill("");

  await expect(checkbox).toBeChecked();
});

test("show done toggle reveals and hides completed items", async ({ page }) => {
  const items = page.locator(listItemsSelector);
  const firstText = (await items.first().locator(".text").textContent())?.trim() ?? "";
  const checkbox = items.first().locator("input.done-toggle");
  await checkbox.check();

  await expect(items.first()).toBeHidden();

  const toggle = await setShowDone(page, true);
  await expect(toggle).toBeChecked();
  await expect(items.first()).toBeVisible();
  if (firstText) {
    await expect(items.first().locator(".text")).toContainText(firstText);
  }

  await setShowDone(page, false);
  await expect(items.first()).toBeHidden();
});

test("adding a task resets any active search filter", async ({ page }) => {
  const searchInput = page.getByRole("searchbox", { name: "Search tasks" });
  await searchInput.fill("bird");

  const hiddenLocator = page.locator("ol.tasklist li[hidden]");
  await expect(hiddenLocator).toHaveCount(19);

  await page.getByRole("button", { name: "Add task" }).click();

  await expect(hiddenLocator).toHaveCount(0);
});
