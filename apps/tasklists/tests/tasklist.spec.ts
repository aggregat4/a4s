import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { pathToFileURL } from "url";

const appUrl = pathToFileURL(resolve(__dirname, "..", "index.html")).href;

test("user can add, complete, and filter tasks", async ({ page }) => {
  await page.goto(appUrl);

  await expect(
    page.getByRole("heading", { name: "Prototype Tasks" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Add task" }).click();

  const topTask = page
    .locator("ol.tasklist li:not(.placeholder)")
    .first()
    .locator(".text");
  await expect(topTask).toHaveAttribute("contenteditable", "true");

  await topTask.fill("Playwright smoke task");
  await page.keyboard.press("Escape");

  await expect(topTask).toHaveText("Playwright smoke task");

  const checkbox = page
    .locator("ol.tasklist li:not(.placeholder)")
    .first()
    .locator("input.done-toggle");
  await checkbox.check();
  await expect(checkbox).toBeChecked();

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
