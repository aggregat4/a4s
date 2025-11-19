import { test, expect, Page, Locator } from "@playwright/test";

const listItemsSelector =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])";

function showDoneToggle(page: Page) {
  return page
    .locator("[data-role='lists-container'] .list-section.is-active")
    .locator("input.tasklist-show-done-toggle");
}

function globalSearchInput(page: Page) {
  return page.getByRole("searchbox", { name: "Global search" });
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

test.beforeEach(async ({ page }) => {
  await page.goto("/?resetStorage=1");
  await expect(page.locator("[data-role='active-list-title']")).toHaveText(
    "Prototype Tasks"
  );
  await expect(page.locator(listItemsSelector).first()).toBeVisible();
  await expect(page.locator(".lists-main-header")).toBeHidden();
});

test("user can add, complete, and filter tasks", async ({ page }) => {
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
  await expect(page.locator("a4-tasklist.tasklist-no-matches")).toHaveCount(0);
  await expect(pageHeader).toBeHidden();
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

test("show done toggle reveals and hides completed items", async ({ page }) => {
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
  const toggle = firstItem.locator(".task-item__toggle");
  const actions = firstItem.locator(".task-item__actions");

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
  const toggle = firstItem.locator(".task-item__toggle");
  await toggle.click();

  const moveButton = firstItem
    .locator(".task-item__actions")
    .locator("button", { hasText: "Move" });
  await expect(moveButton).toBeVisible();

  const originalText =
    (await firstItem.locator(".text").textContent())?.trim() ?? "";

  await moveButton.click();

  const moveDialog = page.locator(".move-dialog__content");
  await expect(moveDialog).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(firstItem.locator(".task-item__actions")).toHaveAttribute(
    "aria-hidden",
    "true"
  );

  const destination = moveDialog
    .locator(".move-dialog__option")
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
  const toggle = firstItem.locator(".task-item__toggle");
  await toggle.click();

  const deleteButton = firstItem
    .locator(".task-item__actions")
    .locator("button", { hasText: "Delete" });
  await expect(deleteButton).toBeVisible();

  const itemText = (await firstItem.locator(".text").textContent())?.trim();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(itemText ?? "");
    await dialog.accept();
  });

  await deleteButton.click();

  await expect(firstItem.locator(".task-item__actions")).toHaveAttribute(
    "aria-hidden",
    "true"
  );
  await expect(firstItem).not.toHaveClass(/task-item--actions/);
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

test("splitting then dragging keeps items separated", async ({ page }) => {
  const items = page.locator(listItemsSelector);
  const firstTextLocator = items.first().locator(".text");
  const originalFirst = (await firstTextLocator.textContent())?.trim() ?? "";

  await firstTextLocator.click();
  await setCaretPosition(firstTextLocator, 0);
  await page.keyboard.type("Fresh");
  await page.keyboard.press("Enter");

  const secondTextLocator = items.nth(1).locator(".text");
  const splitRemainder = (await secondTextLocator.textContent())?.trim() ?? "";

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

  const handle = items.nth(1).locator(".handle");
  const target = items.nth(4);
  await handle.dragTo(target);

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
  await expect(
    page
      .locator(`${listItemsSelector} .text`)
      .filter({ hasText: splitRemainder || originalFirst })
  ).toHaveCount(1);
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

  await page.locator(listItemsSelector).first().dragTo(destinationButton);

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
    page.locator(".sidebar-list-button").filter({ hasText: "Weekend Projects" })
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
  await page.keyboard.press("m");

  const targetOption = page
    .locator(".move-dialog__option")
    .filter({ hasText: "Weekend Projects" });
  await expect(targetOption).toBeVisible();
  await targetOption.click();
  await expect(page.locator(".move-dialog__content")).toBeHidden();

  await page
    .locator(".sidebar-list-button")
    .filter({ hasText: "Weekend Projects" })
    .click();

  const movedTop = page.locator(listItemsSelector).first().locator(".text");
  await expect(movedTop).toHaveText(originalText);
});
