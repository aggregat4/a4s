import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

export async function openSidebarOptions(page: Page) {
  const options = page.locator(".sidebar-actions-disclosure");
  if ((await options.getAttribute("open")) === "") {
    return;
  }
  await page.getByText("Options").click();
  await expect(options).toHaveAttribute("open", "");
}

/** On narrow screens the sidebar opens from the list title. */
export async function openListsPanel(page: Page) {
  const switcher = page.locator("[data-role='lists-switcher']:visible");
  if ((await switcher.getAttribute("aria-expanded")) === "true") {
    return;
  }
  await switcher.click();
  await expect(switcher).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".lists-sidebar")).toBeVisible();
}
