import { Page, Locator } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportSnapshot,
  stringifyExportSnapshot,
} from "../src/app/export-snapshot.js";
import { test, expect } from "./fixtures";
import { dragHandleToTarget } from "./helpers/drag";

const listItemsSelector =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])";

function showDoneToggle(page: Page) {
  return page
    .locator("[data-role='lists-container'] .list-section.is-active")
    .locator(".tasklist-show-done-toggle");
}

function globalSearchInput(page: Page) {
  return page.getByRole("searchbox", { name: "Global search" });
}

function writeSnapshotFile(payload: string) {
  const filename = `tasklist-snapshot-${Date.now()}.json`;
  const path = join(tmpdir(), filename);
  writeFileSync(path, payload, "utf8");
  return path;
}

async function expectCaretVisible(_page: Page, target: Locator) {
  const caretInfo = await target.evaluate((el) => {
    const element = el as HTMLElement;
    const selection = element.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { ok: false, reason: "no-selection" };
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      ok: true,
      active: document.activeElement === element,
      contenteditable: element.getAttribute("contenteditable"),
      isContentEditable: element.isContentEditable,
      collapsed: range.collapsed,
      inElement:
        element.contains(range.startContainer) &&
        element.contains(range.endContainer),
      caretColor: style.caretColor,
      rectHeight: rect.height,
    };
  });

  expect(caretInfo.ok).toBe(true);
  if (caretInfo.ok) {
    expect(caretInfo.active).toBe(true);
    expect(caretInfo.contenteditable).toBe("true");
    expect(caretInfo.isContentEditable).toBe(true);
    expect(caretInfo.collapsed).toBe(true);
    expect(caretInfo.inElement).toBe(true);
    expect(caretInfo.caretColor).not.toBe("transparent");
    expect(caretInfo.rectHeight).toBeGreaterThan(0);
  }
}

async function dragReorderTask(
  _page: Page,
  source: Locator,
  target: Locator
) {
  // Drag from the dedicated handle so we don't accidentally enter edit mode
  // (editing is triggered on pointerdown for Firefox caret correctness).
  await dragHandleToTarget(source.locator(".handle"), target);
}

async function dragTaskToSidebarTarget(
  _page: Page,
  sourceItem: Locator,
  target: Locator
) {
  await dragHandleToTarget(sourceItem.locator(".handle"), target);
}

async function getSidebarListNames(page: Page) {
  return page
    .locator("[data-role='sidebar-list'] .sidebar-list-label")
    .allTextContents();
}

async function getSidebarCountForList(page: Page, name: string) {
  const listItem = page
    .locator("[data-role='sidebar-list'] li")
    .filter({ hasText: name })
    .first();
  const countText = await listItem.locator(".sidebar-list-count").innerText();
  if (!countText || countText.trim() === "Empty") {
    return 0;
  }
  const parsed = Number.parseInt(countText.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function gotoWithSnapshot(page: Page, url: string) {
  await page.goto(url);
  const demoSnapshotPath = join(
    process.cwd(),
    "tests",
    "fixtures",
    "demo-snapshot.json"
  );
  page.once("dialog", (dialog) => dialog.accept());
  const fileInput = page.locator("[data-role='import-snapshot-input']");
  await fileInput.setInputFiles(demoSnapshotPath);
  const prototypeListButton = page
    .locator("[data-role='sidebar-list'] .sidebar-list-button")
    .filter({ hasText: "Prototype Tasks" })
    .first();
  await expect(prototypeListButton).toBeVisible({ timeout: 10_000 });
  await prototypeListButton.click();
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );
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

async function addBlankTask(page: Page) {
  await page.getByRole("button", { name: "Add task" }).click();
  const editor = page.locator(listItemsSelector).first().locator(".text");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.keyboard.press("Escape");
  await expect(editor).not.toHaveAttribute("contenteditable", "true");
  return editor;
}

async function addNoteToFirstTask(page: Page, noteText: string) {
  const item = page.locator(listItemsSelector).first();
  await item.locator(".task-note-toggle").click();
  const noteInput = item.locator(".task-note-input");
  await expect(noteInput).toBeVisible();
  await noteInput.fill(noteText);
  return item;
}

async function getItemId(editor: Locator) {
  return editor.locator("xpath=ancestor::li[1]").getAttribute("data-item-id");
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

async function getCaretOffset(target: Locator) {
  return target.evaluate((el) => {
    const selection = el.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    const offset = pre.toString().length;
    pre.detach?.();
    return offset;
  });
}

async function getNormalizedText(target: Locator) {
  const text = await target.textContent();
  return (text ?? "").replace(/\u00a0/g, " ");
}

async function pressUndo(page: Page) {
  await page.keyboard.press("Control+Z");
}

async function pressRedo(page: Page) {
  await page.keyboard.press("Control+Shift+Z");
}

test("loads without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}\n${err.stack || ""}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console error: ${msg.text()}`);
    }
  });

  await gotoWithSnapshot(page, "/?resetStorage=1");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );
  await expect(page.locator(listItemsSelector).first()).toBeVisible();

  if (errors.length) {
    // Surface errors explicitly in the test output for debugging.
    console.error("Console/page errors during load:", errors);
  }
  expect(errors).toEqual([]);
});

test("tasklist header mirrors title, search, and show-done state", async ({
  page,
}) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");

  const listSection = page.locator(
    "[data-role='lists-container'] .list-section.is-visible"
  );
  const header = listSection.locator(".tasklist-header");
  const title = header.locator(".tasklist-title");
  const searchInput = header.locator("input.tasklist-search-input");
  const showDoneToggle = header.locator(".tasklist-show-done-toggle");

  await expect(title).toHaveText("Prototype Tasks");
  await expect(title).toHaveAttribute("tabindex", "0");
  await expect(title).toHaveAttribute("title", "Click to rename");
  await expect(searchInput).toHaveValue("");
  await expect(showDoneToggle).not.toBeChecked();

  await title.click();
  await expect(title).toHaveAttribute("contenteditable", "true");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Header Rename");
  await page.keyboard.press("Enter");
  await expect(title).not.toHaveAttribute("contenteditable", "true");
  await expect(title).toHaveText("Header Rename");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Header Rename"
  );

  const allListItems = page
    .locator(
      "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder)"
    )
    .filter({ has: page.locator(".text") });
  const firstItem = allListItems.first();
  const firstToggle = firstItem.locator("input.done-toggle");
  await firstToggle.check();
  await expect(firstItem).toBeHidden();

  await showDoneToggle.check();
  await expect(firstItem).toBeVisible();

  await searchInput.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, "umbrella");
  const visibleTasks = page.locator(listItemsSelector);
  await expect(visibleTasks).toHaveCount(1);
  await expect(visibleTasks.first().locator(".text")).toContainText("umbrella");
});

test("undo/redo shortcuts revert task insertions", async ({ page }) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );

  const initialCount = await page.locator(listItemsSelector).count();
  await addBlankTask(page);
  await expect(page.locator(listItemsSelector)).toHaveCount(initialCount + 1);
  const canUndo = await page.evaluate(
    () => (window as any).listsApp?.repository?.canUndo?.() ?? false
  );
  expect(canUndo).toBe(true);

  await page.locator(listItemsSelector).first().locator(".text").click();
  await pressUndo(page);
  await pressUndo(page);
  await expect(page.locator(listItemsSelector)).toHaveCount(initialCount);

  await pressRedo(page);
  await pressRedo(page);
  await expect(page.locator(listItemsSelector)).toHaveCount(initialCount + 1);
});

test("undo/redo coalesces text edits with granular steps", async ({ page }) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );

  const itemEditor = page.locator(listItemsSelector).first().locator(".text");
  await itemEditor.click();
  await expect(itemEditor).toHaveAttribute("contenteditable", "true");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Hello world");

  await pressUndo(page);
  await expect
    .poll(() => getNormalizedText(itemEditor))
    .not.toBe("Hello world");
  const fullText = "Hello world";
  const firstUndoText = await getNormalizedText(itemEditor);
  expect(firstUndoText).not.toBe(fullText);
  for (let i = 0; i < 3; i += 1) {
    const current = await getNormalizedText(itemEditor);
    if (current === "" || current.length <= 1) break;
    await pressUndo(page);
  }

  for (let i = 0; i < 4; i += 1) {
    const current = await getNormalizedText(itemEditor);
    if (current === fullText) break;
    await pressRedo(page);
  }
  await expect
    .poll(() => getNormalizedText(itemEditor), { timeout: 2000 })
    .toBe(fullText);
});

test("undo/redo combines split edits into one step", async ({ page }) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );

  const initialCount = await page.locator(listItemsSelector).count();
  await page.getByRole("button", { name: "Add task" }).click();
  const editor = page.locator(listItemsSelector).first().locator(".text");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.keyboard.type("SplitUndoXYZ");
  const itemId = await getItemId(editor);
  await expect(editor).toHaveText("SplitUndoXYZ");
  await editor.click();
  await setCaretPosition(editor, 5);
  await expect.poll(() => getCaretOffset(editor)).toBe(5);
  await page.keyboard.press("Enter");

  await expect(page.locator(listItemsSelector)).toHaveCount(initialCount + 2);
  const itemEditor = page.locator(`li[data-item-id="${itemId ?? ""}"] .text`);
  await expect(itemEditor).toHaveText("Split");

  await pressUndo(page);
  await expect
    .poll(() => page.locator(listItemsSelector).count(), { timeout: 15000 })
    .toBe(initialCount + 1);
  await expect
    .poll(() => getNormalizedText(itemEditor), { timeout: 15000 })
    .toBe("SplitUndoXYZ");

  await pressRedo(page);
  await expect
    .poll(() => page.locator(listItemsSelector).count(), { timeout: 15000 })
    .toBe(initialCount + 2);
  await expect(itemEditor).toHaveText("Split");
});

test("undo merge after split keeps distinct tasks below", async ({ page }) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");
  page.once("dialog", async (dialog) => {
    await dialog.accept("Undo Merge List");
  });
  await page.getByRole("button", { name: "Add list" }).click();
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Undo Merge List"
  );

  const firstTaskText = "AlphaBeta";
  const secondTaskText = "Task Two";
  const thirdTaskText = "Task Three";
  await addTask(page, thirdTaskText);
  await addTask(page, secondTaskText);
  await addTask(page, firstTaskText);

  const firstEditor = page.locator(listItemsSelector).first().locator(".text");
  await firstEditor.click();
  await expect(firstEditor).toHaveAttribute("contenteditable", "true");
  await setCaretPosition(firstEditor, "Alpha".length);
  await page.keyboard.press("Enter");

  const splitEditor = page
    .locator(listItemsSelector)
    .filter({ hasText: "Beta" })
    .first()
    .locator(".text");
  await expect(splitEditor).toHaveText("Beta");
  await splitEditor.click();
  await setCaretPosition(splitEditor, "Beta".length);
  await page.keyboard.press("Enter");
  await page.keyboard.type("New Task");

  await expect(page.locator(listItemsSelector)).toHaveCount(5);

  let remaining = 10;
  while (remaining > 0) {
    await pressUndo(page);
    await page.waitForTimeout(50);
    const count = await page.locator(listItemsSelector).count();
    if (count === 3) {
      break;
    }
    remaining -= 1;
  }
  await expect(page.locator(listItemsSelector)).toHaveCount(3);

  const secondText = await getNormalizedText(
    page.locator(listItemsSelector).nth(1).locator(".text")
  );
  const thirdText = await getNormalizedText(
    page.locator(listItemsSelector).nth(2).locator(".text")
  );
  expect([secondText, thirdText]).toEqual([secondTaskText, thirdTaskText]);
});

test("undo/redo walks through text edits and task insertions", async ({
  page,
}) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );

  const initialCount = await page.locator(listItemsSelector).count();
  await page.getByRole("button", { name: "Add task" }).click();
  const editor = page.locator(listItemsSelector).first().locator(".text");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.keyboard.type("Hello");
  const itemId = await getItemId(editor);
  await page.keyboard.press("Escape");

  await expect(page.locator(listItemsSelector)).toHaveCount(initialCount + 1);
  const itemEditor = page.locator(`li[data-item-id="${itemId ?? ""}"] .text`);

  await pressUndo(page);
  await expect
    .poll(() => getNormalizedText(itemEditor), { timeout: 15000 })
    .toBe("");
  await pressUndo(page);
  await expect
    .poll(() => page.locator(listItemsSelector).count(), { timeout: 15000 })
    .toBe(initialCount);

  await pressRedo(page);
  await expect
    .poll(() => page.locator(listItemsSelector).count(), { timeout: 15000 })
    .toBe(initialCount + 1);
  await pressRedo(page);
  await expect
    .poll(() => getNormalizedText(itemEditor), { timeout: 15000 })
    .toBe("Hello");
});

test("sidebar list order updates after drag reorder", async ({ page }) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");

  const listItems = page.locator("[data-role='sidebar-list'] li");
  await expect(listItems).toHaveCount(3);

  await expect.poll(async () => getSidebarListNames(page)).toEqual([
    "Prototype Tasks",
    "Weekend Projects",
    "Work Follow-ups",
  ]);
  const initialNames = await getSidebarListNames(page);

  const sourceHandle = listItems.nth(2).locator(".sidebar-list-handle");
  const targetItem = listItems.nth(0);
  const sourceId = await sourceHandle.evaluate(
    (el) => (el.closest("li") as HTMLElement | null)?.dataset?.itemId ?? null
  );
  expect(sourceId).toBe("list-work");
  await dragHandleToTarget(sourceHandle, targetItem, {
    targetPosition: { x: 10, y: 2 },
  });
  const previewOrder = await getSidebarListNames(page);
  expect(previewOrder).not.toEqual(initialNames);
  await page.evaluate(() => {
    const list = document.querySelector("a4-tasklist");
    if (!list) return;
    list.dispatchEvent(
      new CustomEvent("itemcountchange", { detail: { total: 99 } })
    );
  });

  await expect
    .poll(async () => getSidebarListNames(page))
    .toEqual(previewOrder);
});

test("sidebar drag can move a middle list to the top", async ({ page }) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");

  const listItems = page.locator("[data-role='sidebar-list'] li");
  await expect(listItems).toHaveCount(3);

  await expect.poll(async () => getSidebarListNames(page)).toEqual([
    "Prototype Tasks",
    "Weekend Projects",
    "Work Follow-ups",
  ]);

  const sourceHandle = listItems.nth(1).locator(".sidebar-list-handle");
  const targetItem = listItems.nth(0);
  await dragHandleToTarget(sourceHandle, targetItem, {
    targetPosition: { x: 10, y: 2 },
  });

  await expect.poll(async () => getSidebarListNames(page)).toEqual([
    "Weekend Projects",
    "Prototype Tasks",
    "Work Follow-ups",
  ]);
});

test("sidebar drag to top works even when pointer is above first item", async ({
  page,
}) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");

  const listItems = page.locator("[data-role='sidebar-list'] li");
  await expect(listItems).toHaveCount(3);
  await expect.poll(async () => getSidebarListNames(page)).toEqual([
    "Prototype Tasks",
    "Weekend Projects",
    "Work Follow-ups",
  ]);

  const listEl = page.locator("[data-role='sidebar-list']");
  const sourceHandle = listItems.nth(1).locator(".sidebar-list-handle");
  await dragHandleToTarget(sourceHandle, listEl, {
    targetPosition: { x: 10, y: 2 },
  });

  await expect.poll(async () => getSidebarListNames(page)).toEqual([
    "Weekend Projects",
    "Prototype Tasks",
    "Work Follow-ups",
  ]);
});

test.describe("tasklist flows", () => {
  test.beforeEach(async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    await expect(page.locator("[data-role='active-list-title']")).toHaveText(
      "Prototype Tasks"
    );
    await expect(page.locator(listItemsSelector).first()).toBeVisible();
    await expect(page.locator(".lists-main-header")).toBeHidden();
  });

  test("tasklist flows › user can add, complete, and filter tasks", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Add task" }).click();

    const topTask = page.locator(listItemsSelector).first().locator(".text");
    await expect(topTask).toHaveAttribute("contenteditable", "true");

    await topTask.fill("Playwright smoke task");
    await page.keyboard.press("Escape");

    await expect(topTask).toHaveText("Playwright smoke task");

    const listRoot = page
      .locator(
        "[data-role='lists-container'] .list-section.is-visible ol.tasklist li"
      )
      .first();
    const checkbox = listRoot.locator("input.done-toggle");
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(listRoot).toBeHidden();
    await setShowDone(page, true);
    await expect(listRoot).toBeVisible();

    const searchInput = globalSearchInput(page);
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
    await expect(
      page.locator(".text[contenteditable='true']").filter({ hasText: "Here" })
    ).toHaveCount(1);
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

  test("ctrl+backspace deletes a word without removing the task", async ({
    page,
  }) => {
    const items = page.locator(listItemsSelector);
    const initialCount = await items.count();
    const firstText = items.nth(0).locator(".text");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await firstText.fill("Alpha Beta Gamma");
    await page.keyboard.press("Escape");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await setCaretPosition(firstText, "Alpha Beta Gamma".length);
    await page.keyboard.press("Control+Backspace");

    await expect(items).toHaveCount(initialCount);
    await expect
      .poll(() => getNormalizedText(firstText))
      .toContain("Alpha Beta");
    await expect(firstText).not.toContainText("Gamma");
  });

  test("ctrl+shift+backspace removes the current task", async ({ page }) => {
    const itemsBefore = page.locator(listItemsSelector);
    const initialCount = await itemsBefore.count();
    const firstText = itemsBefore.nth(0).locator(".text");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await page.keyboard.press("Control+Shift+Backspace");

    const itemsAfter = page.locator(listItemsSelector);
    await expect(itemsAfter).toHaveCount(initialCount - 1);
  });

  test("arrow keys move between tasks while editing", async ({ page }) => {
    const items = page.locator(listItemsSelector);
    const firstText = items.nth(0).locator(".text");
    const secondText = items.nth(1).locator(".text");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await firstText.fill("First column retention");
    await page.keyboard.press("Escape");

    await secondText.click();
    await expect(secondText).toHaveAttribute("contenteditable", "true");
    await secondText.fill("Second column retention");
    await page.keyboard.press("Escape");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    const targetOffset = 6;
    await setCaretPosition(firstText, targetOffset);
    await page.keyboard.press("ArrowDown");

    await expect(firstText).not.toHaveAttribute("contenteditable", "true");
    await expect(secondText).toHaveAttribute("contenteditable", "true");

    const caretInSecond = await getCaretOffset(secondText);
    expect(caretInSecond).not.toBeNull();
    expect(caretInSecond).toBe(targetOffset);

    await page.keyboard.press("ArrowUp");
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    const caretBackInFirst = await getCaretOffset(firstText);
    expect(caretBackInFirst).toBe(targetOffset);

    await page.keyboard.press("ArrowDown");
    await expect(secondText).toHaveAttribute("contenteditable", "true");
    const caretAfterReturn = await getCaretOffset(secondText);
    expect(caretAfterReturn).toBe(targetOffset);

    const shortText = "Hi";
    await secondText.fill(shortText);
    await page.keyboard.press("Escape");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await setCaretPosition(firstText, targetOffset);
    await page.keyboard.press("ArrowDown");

    await expect(secondText).toHaveAttribute("contenteditable", "true");
    const caretAfterClamp = await getCaretOffset(secondText);
    expect(caretAfterClamp).toBe(shortText.length);
  });

  test("caret remains visible when editing items with @/# highlights", async ({
    page,
  }) => {
    const items = page.locator(listItemsSelector);
    const firstText = items.nth(0).locator(".text");
    const secondText = items.nth(1).locator(".text");

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await firstText.fill("Plain item");
    await page.keyboard.press("Escape");

    const highlightedText = "Ping @alice about #launch";
    await secondText.click();
    await expect(secondText).toHaveAttribute("contenteditable", "true");
    await secondText.fill(highlightedText);
    await page.keyboard.press("Escape");

    await expect(secondText.locator(".task-token-mention")).toHaveCount(1);
    await expect(secondText.locator(".task-token-tag")).toHaveCount(1);

    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    const targetOffset = 6;
    await setCaretPosition(firstText, targetOffset);
    await page.keyboard.press("ArrowDown");

    await expect(secondText).toHaveAttribute("contenteditable", "true");
    const caretAfterNavigate = await getCaretOffset(secondText);
    expect(caretAfterNavigate).not.toBeNull();

    await page.keyboard.press("Escape");
    await expect(secondText).not.toHaveAttribute("contenteditable", "true");
    await expect(secondText.locator(".task-token-mention")).toHaveCount(1);

    await secondText.click();
    await expect(secondText).toHaveAttribute("contenteditable", "true");
    const caretAfterClick = await getCaretOffset(secondText);
    expect(caretAfterClick).not.toBeNull();
  });

  test("clicking into a task shows a native caret", async ({ page }) => {
    const firstText = page.locator(listItemsSelector).first().locator(".text");
    await firstText.click({ position: { x: 80, y: 10 } });
    await expect(firstText).toHaveAttribute("contenteditable", "true");
    await expectCaretVisible(page, firstText);
  });

  test("search highlights matching tokens and clears after reset", async ({
    page,
  }) => {
    const searchInput = globalSearchInput(page);
    await searchInput.fill("bird");
    const pageHeader = page.locator(".lists-main-header");
    await expect(pageHeader).toBeVisible();

    const visible = page.locator(
      "ol.tasklist li:not(.placeholder):not([hidden])"
    );
    await expect(visible).toHaveCount(1);
    await expect(page.locator("ol.tasklist mark")).toHaveCount(1);
    await expect(page.locator("ol.tasklist mark").first()).toHaveText(/bird/i);

    await searchInput.fill("");
    await expect(page.locator("ol.tasklist mark")).toHaveCount(0);
    await expect(pageHeader).toBeHidden();

    await searchInput.fill("no-such-term");
    await expect(pageHeader).toBeVisible();
    const emptyMessages = page.locator(".tasklist-empty:not([hidden])");
    await expect(emptyMessages).toHaveCount(3);
    await expect(emptyMessages.first()).toHaveText("No matching items");
    await searchInput.fill("");
    await expect(page.locator("a4-tasklist.tasklist-no-matches")).toHaveCount(
      0
    );
    await expect(pageHeader).toBeHidden();
  });

  test("search matches note text", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    const uniqueText = `Note search task ${Date.now()}`;
    await addTask(page, uniqueText);
    const noteToken = `note-only-${Date.now()}`;
    await addNoteToFirstTask(page, noteToken);

    const searchInput = globalSearchInput(page);
    await searchInput.fill(noteToken);
    const matching = page
      .locator(listItemsSelector)
      .locator(".text", { hasText: uniqueText });
    await expect(matching).toBeVisible();
  });

  test("export downloads snapshot json", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export" }).click(),
    ]);
    const targetPath = join(tmpdir(), `export-${Date.now()}.json`);
    await download.saveAs(targetPath);
    const raw = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.schema).toBe("net.aggregat4.tasklist.snapshot@v1");
    expect(parsed.data).toBeTruthy();
  });

  test("import replaces lists with snapshot data", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    const listId = "imported-list";
    const taskId = "imported-task";
    const registryState = {
      clock: 1,
      entries: [
        {
          id: listId,
          pos: [{ digit: 1, actor: "importer" }],
          data: { title: "Imported List" },
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    };
    const listState = {
      clock: 1,
      title: "Imported List",
      titleUpdatedAt: 1,
      entries: [
        {
          id: taskId,
          pos: [{ digit: 1, actor: "importer" }],
          data: { text: "Imported Task", done: false, note: "" },
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    };
    const snapshot = buildExportSnapshot({
      registryState,
      lists: [{ listId, state: listState }],
      exportedAt: "2026-01-27T00:00:00.000Z",
    });
    const snapshotPath = writeSnapshotFile(stringifyExportSnapshot(snapshot));

    page.once("dialog", (dialog) => dialog.accept());
    const fileInput = page.locator("[data-role='import-snapshot-input']");
    await fileInput.setInputFiles(snapshotPath);

    const importedListButton = page.locator(
      ".sidebar-list-button",
      { hasText: "Imported List" }
    );
    await expect(importedListButton).toBeVisible();
    await importedListButton.click();
    await expect(
      page.locator(listItemsSelector).locator(".text", {
        hasText: "Imported Task",
      })
    ).toBeVisible();
  });

  test("import shows error when server rejects snapshot", async ({ page }) => {
    await page.goto("/?resetStorage=1&sync=1");
    await page.waitForFunction(
      () =>
        Boolean(
          (document.querySelector("[data-role='lists-app']") as
            | { repository?: { isSyncEnabled?: () => boolean } }
            | null)?.repository?.isSyncEnabled?.()
        )
    );
    const listId = "imported-list";
    const registryState = {
      clock: 1,
      entries: [
        {
          id: listId,
          pos: [{ digit: 1, actor: "importer" }],
          data: { title: "Imported List" },
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    };
    const snapshot = buildExportSnapshot({
      registryState,
      lists: [{ listId, state: { clock: 0, title: "Imported List", titleUpdatedAt: 0, entries: [] } }],
      exportedAt: "2026-01-27T00:00:00.000Z",
    });
    const snapshotPath = writeSnapshotFile(stringifyExportSnapshot(snapshot));

    await page.route("**/sync/reset", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "datasetGenerationKey already exists" }),
      })
    );

    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.accept();
    });

    const fileInput = page.locator("[data-role='import-snapshot-input']");
    await fileInput.setInputFiles(snapshotPath);

    await expect
      .poll(
        () =>
          dialogMessages.find((message) =>
            message.includes("dataset generation key already exists")
          ),
        { timeout: 10000 }
      )
      .toBeTruthy();
  });

  test("alt+n toggles note input and returns to editing", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    const firstItem = page.locator(listItemsSelector).first();
    const textEl = firstItem.locator(".text");
    await textEl.click();
    await expect(textEl).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("Alt+N");
    const noteInput = firstItem.locator(".task-note-input");
    await expect(noteInput).toBeVisible();
    await expect(noteInput).toBeFocused();

    await page.keyboard.press("Alt+N");
    await expect(noteInput).toHaveCount(0);
    await expect(textEl).toHaveAttribute("contenteditable", "true");
    await expect(textEl).toBeFocused();
  });

  test("completed tasks stay checked after performing a search", async ({
    page,
  }) => {
    const items = page.locator(listItemsSelector);
    const checkbox = items.nth(0).locator("input.done-toggle");
    await setShowDone(page, true);
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    const searchInput = globalSearchInput(page);
    await searchInput.fill("fridge");
    await searchInput.fill("");

    await expect(checkbox).toBeChecked();
  });

  test("search results align between sidebar counts and list contents", async ({
    page,
  }) => {
    const searchInput = globalSearchInput(page);
    await searchInput.fill("week");

    const visibleSections = page.locator(".list-section.is-visible");
    await expect(visibleSections).toHaveCount(3);

    const sectionStats = await visibleSections.evaluateAll((sections) =>
      sections.map((section) => ({
        listId: section.dataset.listId ?? "",
        visibleCount: section.querySelectorAll(
          "ol.tasklist li:not(.placeholder):not([hidden])"
        ).length,
      }))
    );

    for (const entry of sectionStats) {
      const expectedLabel =
        entry.visibleCount === 0
          ? "No matches"
          : entry.visibleCount === 1
          ? "1 match"
          : `${entry.visibleCount} matches`;

      const button = page.locator(
        `.sidebar-list-button[data-list-id="${entry.listId}"]`
      );
      await expect(button).toHaveCount(1);
      await expect(button.locator(".sidebar-list-count")).toHaveText(
        expectedLabel
      );
    }
  });

  test("sidebar counts show only open items", async ({ page }) => {
    const initialCount = await page.locator(listItemsSelector).count();
    expect(initialCount).toBeGreaterThan(1);

    const firstItem = page.locator(listItemsSelector).first();
    const firstText =
      (await firstItem.locator(".text").textContent())?.trim() ?? "";
    await firstItem.locator("input.done-toggle").check();

    await expect
      .poll(() => getSidebarCountForList(page, "Prototype Tasks"))
      .toBe(initialCount - 1);

    await setShowDone(page, true);
    const toggledItemCheckbox = page
      .locator("ol.tasklist li")
      .filter({ has: page.locator(".text", { hasText: firstText }) })
      .locator("input.done-toggle");
    await toggledItemCheckbox.uncheck();

    await expect
      .poll(() => getSidebarCountForList(page, "Prototype Tasks"))
      .toBe(initialCount);
  });

  test("show done toggle reveals and hides completed items", async ({
    page,
  }) => {
    const firstItem = page
      .locator(
        "[data-role='lists-container'] .list-section.is-visible ol.tasklist li"
      )
      .first();
    const firstText =
      (await firstItem.locator(".text").textContent())?.trim() ?? "";
    const checkbox = firstItem.locator("input.done-toggle");
    await checkbox.check();

    await expect(firstItem).toBeHidden();

    const toggle = await setShowDone(page, true);
    await expect(toggle).toBeChecked();
    await expect(firstItem).toBeVisible();
    if (firstText) {
      await expect(firstItem.locator(".text")).toContainText(firstText);
    }

    await setShowDone(page, false);
    await expect(firstItem).toBeHidden();
  });

  test("task action menu toggles inline controls", async ({ page }) => {
    const firstItem = page.locator(listItemsSelector).first();
    const toggle = firstItem.locator(".task-item-toggle");
    const actions = firstItem.locator(".task-item-actions");

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(actions).toHaveAttribute("aria-hidden", "true");

    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(actions).toHaveAttribute("aria-hidden", "false");
    await expect(actions.locator("button")).toHaveCount(2);
    await expect(
      actions.locator("button").filter({ hasText: "Move" })
    ).toBeVisible();
    await expect(
      actions.locator("button").filter({ hasText: "Delete" })
    ).toBeVisible();

    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(actions).toHaveAttribute("aria-hidden", "true");
  });

  test("task action menu move triggers move dialog and closes tray", async ({
    page,
  }) => {
    const items = page.locator(listItemsSelector);
    const firstItem = items.first();
    const toggle = firstItem.locator(".task-item-toggle");
    await toggle.click();

    const moveButton = firstItem
      .locator(".task-item-actions")
      .locator("button", { hasText: "Move" });
    await expect(moveButton).toBeVisible();

    const originalText =
      (await firstItem.locator(".text").textContent())?.trim() ?? "";

    await moveButton.click();

    const moveDialog = page.locator(".move-dialog-content");
    await expect(moveDialog).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(firstItem.locator(".task-item-actions")).toHaveAttribute(
      "aria-hidden",
      "true"
    );

    const destination = moveDialog
      .locator(".move-dialog-option")
      .filter({ hasText: "Weekend Projects" });
    await destination.click();
    await expect(moveDialog).toBeHidden();

    await page
      .locator(".sidebar-list-button")
      .filter({ hasText: "Weekend Projects" })
      .click();
    await expect(page.locator("[data-role='active-list-title']")).toHaveText(
      "Weekend Projects"
    );

    if (originalText) {
      await expect(
        page
          .locator(listItemsSelector)
          .locator(".text")
          .filter({ hasText: originalText })
          .first()
      ).toBeVisible();
    }
  });

  test("task action menu delete prompts confirmation and removes task", async ({
    page,
  }) => {
    const items = page.locator(listItemsSelector);
    const itemCount = await items.count();
    const firstItem = items.first();
    const toggle = firstItem.locator(".task-item-toggle");
    await toggle.click();

    const deleteButton = firstItem
      .locator(".task-item-actions")
      .locator("button", { hasText: "Delete" });
    await expect(deleteButton).toBeVisible();

    const itemText = (await firstItem.locator(".text").textContent())?.trim();

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(itemText ?? "");
      await dialog.accept();
    });

    await deleteButton.click();

    await expect(firstItem.locator(".task-item-actions")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(
      firstItem.locator(".task-item-actions")
    ).not.toHaveClass(/task-item-actions-open/);
    await expect(page.locator(listItemsSelector)).toHaveCount(itemCount - 1);
  });

  test("adding a task resets any active search filter", async ({ page }) => {
    const searchInput = globalSearchInput(page);
    await searchInput.fill("bird");

    const matchesCount = await page
      .locator(
        ".list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])"
      )
      .count();
    expect(matchesCount).toBeGreaterThan(0);

    await page
      .locator("[data-role='lists-container'] .list-section.is-visible button")
      .first()
      .click();

    await expect(searchInput).toHaveValue("");
    await expect(page.locator(".list-section.is-visible")).toHaveCount(1);
  });

  test("keyboard shortcut moves items while preserving caret position", async ({
    page,
  }) => {
    await addTask(page, "Keyboard Move");
    const items = page.locator(listItemsSelector);
    const activeText = items.first().locator(".text");

    await activeText.click();
    await setCaretPosition(activeText, 3);

    await page.keyboard.press("Control+ArrowDown");

    const movedText = items.nth(1).locator(".text");
    await expect(page.locator(".text[contenteditable='true']")).toContainText(
      "Keyboard Move"
    );
    await expect(movedText).toHaveText("Keyboard Move");
    const offsetAfterDown = await getCaretOffset(movedText);
    expect(offsetAfterDown).toBe(3);

    await page.keyboard.press("Control+ArrowUp");

    const backToTop = items.first().locator(".text");
    await expect(backToTop).toHaveAttribute("contenteditable", "true");
    await expect(backToTop).toHaveText("Keyboard Move");
    const offsetAfterUp = await getCaretOffset(backToTop);
    expect(offsetAfterUp).toBe(3);
  });

  test("keyboard shortcuts jump to list start and end", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    const items = page.locator(listItemsSelector);
    const thirdText = items.nth(2).locator(".text");
    await thirdText.click();
    await expect(thirdText).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("Control+End");
    const lastText = items.last().locator(".text");
    await expect(lastText).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("Control+Home");
    const firstText = items.first().locator(".text");
    await expect(firstText).toHaveAttribute("contenteditable", "true");
  });

  test("jump to end skips hidden completed items", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    await setShowDone(page, false);
    const items = page.locator(listItemsSelector);
    const lastItem = items.last();
    const lastId = await lastItem.getAttribute("data-item-id");
    expect(lastId).not.toBeNull();
    await lastItem.locator("input.done-toggle").check();

    const targetText = items.first().locator(".text");
    await targetText.click();
    await expect(targetText).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("Control+End");
    const focused = page.locator(".text[contenteditable='true']");
    const focusedId = await focused.evaluate((el) =>
      el.closest("li")?.getAttribute("data-item-id")
    );
    expect(focusedId).not.toBe(lastId);
    await expect(focused.locator("xpath=ancestor::li[1]")).not.toHaveAttribute(
      "data-done",
      "true"
    );
  });

  test("keyboard shortcut toggles completion", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    await setShowDone(page, true);
    const firstItem = page.locator(listItemsSelector).first();
    const checkbox = firstItem.locator("input.done-toggle");
    await expect(checkbox).not.toBeChecked();
    await firstItem.locator(".text").click();
    const itemsBefore = await page.locator(listItemsSelector).count();
    await page.keyboard.press("Control+Enter");
    await expect(checkbox).toBeChecked();
    const itemsAfter = await page.locator(listItemsSelector).count();
    expect(itemsAfter).toBe(itemsBefore);
  });

  test("ctrl+enter hides done item and moves focus when show-done is off", async ({
    page,
  }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    await setShowDone(page, false);
    const items = page.locator(listItemsSelector);
    const firstItem = items.first();
    const firstId = await firstItem.getAttribute("data-item-id");
    expect(firstId).not.toBeNull();
    const firstText = firstItem.locator(".text");
    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("Control+Enter");
    const toggledItem = page.locator(
      `ol.tasklist li[data-item-id="${firstId}"]`
    );
    await expect(toggledItem).toHaveAttribute("data-done", "true");
    await expect(toggledItem).toHaveAttribute("hidden", "");

    const focusedText = items.first().locator(".text");
    await expect(focusedText).toHaveAttribute("contenteditable", "true");
    await expect(focusedText).toBeFocused();
  });

  test("ctrl+enter stays on item when show-done is on", async ({ page }) => {
    await gotoWithSnapshot(page, "/?resetStorage=1");
    await setShowDone(page, true);
    const items = page.locator(listItemsSelector);
    const firstText = items.first().locator(".text");
    await firstText.click();
    await expect(firstText).toHaveAttribute("contenteditable", "true");

    await page.keyboard.press("Control+Enter");
    await expect(items.first()).toHaveAttribute("data-done", "true");
    await expect(items.first()).not.toHaveAttribute("hidden", "");
    await expect(firstText).toHaveAttribute("contenteditable", "true");
  });

  test("dragging reorders tasks within the active list", async ({ page }) => {
    const items = page.locator(listItemsSelector);
    const count = await items.count();
    expect(count).toBeGreaterThan(2);

    const firstText =
      (await items.first().locator(".text").textContent())?.trim() ?? "";
    const secondText =
      (await items.nth(1).locator(".text").textContent())?.trim() ?? "";
    const secondId = await items.nth(1).getAttribute("data-item-id");

    await dragReorderTask(page, items.nth(1), items.nth(4));

    await expect
      .poll(
        async () => {
          const ids =
            (await items.evaluateAll((els) =>
              els.map((el) => el.dataset?.itemId ?? "")
            )) ?? [];
          return ids.indexOf(secondId ?? "");
        },
        { timeout: 5000 }
      )
      .toBeGreaterThan(2);

    const orderedTexts = await page.evaluate(() => {
      const el = document.querySelector("a4-tasklist") as any;
      return el?.store
        ?.getState?.()
        ?.items?.map((item) => item?.text?.trim?.());
    });
    expect(orderedTexts?.[0]).toBe(firstText);
    expect(orderedTexts).toContain(secondText);
  });

  test("dragging reorder persists after reload", async ({ page }) => {
    const items = page.locator(listItemsSelector);
    await expect(items.first()).toBeVisible();

    const initialIds = await items.evaluateAll((els) =>
      els.map((el) => el.dataset?.itemId ?? "")
    );
    expect(initialIds.length).toBeGreaterThan(4);

    await dragReorderTask(page, items.nth(1), items.nth(4));

    await expect
      .poll(
        async () =>
          (await items.evaluateAll((els) =>
            els.map((el) => el.dataset?.itemId ?? "")
          )) ?? [],
        { timeout: 5000 }
      )
      .not.toEqual(initialIds);
    const expectedIds =
      (await page.evaluate(() => {
        const el = document.querySelector("a4-tasklist") as any;
        return el?.store?.getState?.()?.items?.map((item) => item?.id ?? "");
      })) ??
      (await items.evaluateAll((els) =>
        els.map((el) => el.dataset?.itemId ?? "")
      ));

    await page.goto("/");
    await expect(page.locator("[data-role='active-list-title']")).toHaveText(
      "Prototype Tasks"
    );
    const idsAfterReload = await page
      .locator(listItemsSelector)
      .evaluateAll((els) => els.map((el) => el.dataset?.itemId ?? ""));
    expect(idsAfterReload).toEqual(expectedIds);
  });

  test("splitting creates a new item and preserves remainder", async ({
    page,
  }) => {
    const items = page.locator(listItemsSelector);
    const firstTextLocator = items.first().locator(".text");
    const originalFirst = (await firstTextLocator.textContent())?.trim() ?? "";
    const countBefore = await items.count();

    await firstTextLocator.click();
    await firstTextLocator.fill(`Fresh${originalFirst}`);
    await setCaretPosition(firstTextLocator, 5);
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(countBefore + 1);

    const secondTextLocator = items.nth(1).locator(".text");
    const splitRemainder =
      (await secondTextLocator.textContent())?.trim() ?? "";

    await page.keyboard.press("Escape");
    await expect(secondTextLocator).not.toHaveAttribute(
      "contenteditable",
      "true"
    );

    await expect(items.first().locator(".text")).toHaveText("Fresh");
    const dataBefore = await items
      .first()
      .locator(".text")
      .getAttribute("data-original-text");
    expect(dataBefore).toBe("Fresh");
    const stateAfter = await page.evaluate(() => {
      const el = document.querySelector("a4-tasklist") as any;
      return {
        state: el?.store?.getState?.(),
      };
    });
    expect(stateAfter?.state?.items?.[0]?.text).toBe("Fresh");
    const remainderCount =
      stateAfter?.state?.items?.filter(
        (item: any) => item?.text === splitRemainder
      )?.length ?? 0;
    expect(remainderCount).toBe(1);

    await expect(items.first().locator(".text")).toHaveText("Fresh");
    const dataAfter = await items
      .first()
      .locator(".text")
      .getAttribute("data-original-text");
    expect(dataAfter).toBe("Fresh");
  });

  test("dragging task to sidebar leaves no placeholders", async ({ page }) => {
    const destinationButton = page
      .locator(".sidebar-list-button")
      .filter({ hasText: "Weekend Projects" });
    const originalText =
      (
        await page
          .locator(listItemsSelector)
          .first()
          .locator(".text")
          .textContent()
      )?.trim() ?? "";

    await dragTaskToSidebarTarget(
      page,
      page.locator(listItemsSelector).first(),
      destinationButton
    );

    await expect(page.locator("ol.tasklist li.placeholder")).toHaveCount(0);
    await expect(destinationButton).not.toHaveClass(/is-drop-target/);

    await destinationButton.click();
    if (originalText) {
      await expect(
        page
          .locator("ol.tasklist li:not(.placeholder) .text")
          .filter({ hasText: originalText })
      ).toHaveCount(1);
    }
  });

  test("dragging task between lists via sidebar persists across reload", async ({
    page,
  }) => {
    const prototypeButton = page
      .locator(".sidebar-list-button")
      .filter({ hasText: "Prototype Tasks" });
    const weekendButton = page
      .locator(".sidebar-list-button")
      .filter({ hasText: "Weekend Projects" });
    const activeTitle = page.locator("[data-role='active-list-title']");
    const prototypeItems = page
      .locator("a4-tasklist[name='Prototype Tasks']")
      .locator("ol.tasklist li:not(.placeholder)");
    const weekendItems = page
      .locator("a4-tasklist[name='Weekend Projects']")
      .locator("ol.tasklist li:not(.placeholder)");

    const sourceItem = page.locator(listItemsSelector).first();
    const sourceText =
      (await sourceItem.locator(".text").textContent())?.trim() ?? "";
    expect(sourceText.length).toBeGreaterThan(0);

    await dragTaskToSidebarTarget(page, sourceItem, weekendButton);

    await weekendButton.click();
    await expect(activeTitle).toHaveText("Weekend Projects");
    await expect(
      weekendItems.locator(".text").filter({ hasText: sourceText })
    ).toHaveCount(1);

    await prototypeButton.click();
    await expect(activeTitle).toHaveText("Prototype Tasks");
    await expect(
      prototypeItems.locator(".text").filter({ hasText: sourceText })
    ).toHaveCount(0);

    await page.goto("/");
    await expect(activeTitle).toHaveText("Prototype Tasks");
    await weekendButton.click();
    await expect(activeTitle).toHaveText("Weekend Projects");
    await expect(
      weekendItems.locator(".text").filter({ hasText: sourceText })
    ).toHaveCount(1);
    await prototypeButton.click();
    await expect(activeTitle).toHaveText("Prototype Tasks");
    await expect(
      prototypeItems.locator(".text").filter({ hasText: sourceText })
    ).toHaveCount(0);
  });

  test("drag-and-drop positions item correctly and persists after reload", async ({
    page,
  }) => {
    await expect(page.locator(listItemsSelector).first()).toBeVisible();
    const items = page.locator(listItemsSelector);

    // Get initial order
    const initialOrder = await items.evaluateAll((elements) =>
      elements.map((el) => ({
        id: el.dataset.itemId,
        text: el.querySelector(".text").textContent.trim(),
      }))
    );
    expect(initialOrder.length).toBeGreaterThan(4);
    const initialIds = initialOrder.map((item) => item.id);

    // Select the item to drag - use the second item
    const draggedId = initialOrder[1].id;

    // Drag the item to position 4
    await dragReorderTask(page, items.nth(1), items.nth(4));

    const expectedOrder = await (async () => {
      const deadline = Date.now() + 5000;
      let lastCandidate: string[] | null = null;
      let stableCount = 0;

      while (Date.now() < deadline) {
        const ids =
          (await items.evaluateAll((els) =>
            els.map((el) => el.dataset?.itemId ?? "")
          )) ?? [];
        const draggedIndex = ids.indexOf(draggedId ?? "");
        const isDifferent =
          ids.length === initialIds.length &&
          ids.some((id, idx) => id !== initialIds[idx]);

        if (isDifferent && draggedIndex > 2) {
          const isSameAsLast =
            lastCandidate?.length === ids.length &&
            ids.every((id, idx) => id === lastCandidate?.[idx]);
          if (isSameAsLast) {
            stableCount += 1;
          } else {
            stableCount = 1;
            lastCandidate = ids;
          }

          if (stableCount >= 3) return ids;
        } else {
          stableCount = 0;
          lastCandidate = null;
        }

        await page.waitForTimeout(100);
      }

      throw new Error("Timed out waiting for stable post-drag order");
    })();

    // Reload the page
    await page.goto("/");
    await expect(page.locator("[data-role='active-list-title']")).toHaveText(
      "Prototype Tasks"
    );

    // Get the order after reload
    const postReloadItems = page.locator(listItemsSelector);
    const postReloadOrder = await postReloadItems.evaluateAll((elements) =>
      elements.map((el) => el.dataset.itemId)
    );

    expect(postReloadOrder).toEqual(expectedOrder);
  });

  test("deleting a list removes it and selects a fallback list", async ({
    page,
  }) => {
    await page
      .locator(".sidebar-list-button")
      .filter({ hasText: "Weekend Projects" })
      .click();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete list" }).click();

    await expect(
      page
        .locator(".sidebar-list-button")
        .filter({ hasText: "Weekend Projects" })
    ).toHaveCount(0);
    await expect(page.locator("[data-role='active-list-title']")).toHaveText(
      "Work Follow-ups"
    );
    await expect(page.locator(listItemsSelector).first()).toBeVisible();
  });

  test("multi-list search and move flow", async ({ page }) => {
    const listButtons = page.locator(".sidebar-list-button");
    await expect(listButtons).toHaveCount(3);
    await expect(listButtons.first()).toContainText("Prototype Tasks");
    await expect(listButtons.nth(1)).toContainText("Weekend Projects");

    const searchInput = globalSearchInput(page);
    await searchInput.fill("garage");

    const visibleSections = page.locator(".list-section.is-visible");
    await expect(visibleSections).toHaveCount(3);
    const weekendSection = visibleSections.filter({
      has: page.locator("a4-tasklist[name='Weekend Projects']"),
    });
    const weekendMatches = await weekendSection
      .locator("ol.tasklist li:not(.placeholder):not([hidden])")
      .count();
    expect(weekendMatches).toBeGreaterThan(0);

    await searchInput.fill("");
    await expect(page.locator(".list-section.is-visible")).toHaveCount(1);

    const sourceTextLocator = page
      .locator(listItemsSelector)
      .first()
      .locator(".text");
    const originalText = (await sourceTextLocator.textContent())?.trim() ?? "";
    await sourceTextLocator.focus();
    await page.keyboard.press("Control+Alt+M");

    const targetOption = page
      .locator(".move-dialog-option")
      .filter({ hasText: "Weekend Projects" });
    await expect(targetOption).toBeVisible();
    await targetOption.click();
    await expect(page.locator(".move-dialog-content")).toBeHidden();

    await page
      .locator(".sidebar-list-button")
      .filter({ hasText: "Weekend Projects" })
      .click();

    const movedTop = page.locator(listItemsSelector).first().locator(".text");
    await expect(movedTop).toHaveText(originalText);
  });
});

test("sidebar count updates after adding a task to a new list", async ({
  page,
}) => {
  await gotoWithSnapshot(page, "/?resetStorage=1");

  page.once("dialog", (dialog) => dialog.accept("New List"));
  await page.locator("[data-role='add-list']").click();
  await expect
    .poll(() => getSidebarListNames(page))
    .toHaveLength(4);
  const resolvedNames = await getSidebarListNames(page);
  const newListName = resolvedNames[resolvedNames.length - 1];
  await page
    .locator("[data-role='sidebar-list'] li")
    .filter({ hasText: newListName })
    .locator(".sidebar-list-button")
    .click();
  const before = await getSidebarCountForList(page, newListName);

  await addTask(page, "First task in new list");

  await expect
    .poll(() => getSidebarCountForList(page, newListName))
    .toBe(before + 1);
});
