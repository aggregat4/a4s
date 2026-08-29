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
