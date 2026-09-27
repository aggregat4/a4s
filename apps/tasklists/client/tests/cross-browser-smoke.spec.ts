import { buildExportSnapshot, stringifyExportSnapshot } from "../src/app/export-snapshot.js";
import { test, expect } from "./fixtures";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/sync/reset", {
    data: {
      clientId: `smoke-${crypto.randomUUID()}`,
      datasetGenerationKey: crypto.randomUUID(),
      snapshot: stringifyExportSnapshot(buildExportSnapshot({
        registryState: { clock: 0, entries: [] },
        lists: [],
      })),
    },
  });
  expect(response.ok()).toBe(true);
});

test("creates, persists, and reloads an ordered list", async ({ page }) => {
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/sync/bootstrap")),
    page.goto("/?sync=1&resetStorage=1"),
  ]);
  await page.waitForFunction(() => Boolean((window as any).listsApp?.repository));
  await page.evaluate(() => (window as any).listsApp.repository.initialize());
  await page.waitForFunction(() => (window as any).listsApp.repository.isSyncEnabled());
  const listId = `smoke-${crypto.randomUUID()}`;
  await page.evaluate(async (id) => {
    const repo = (window as any).listsApp.repository;
    await repo.createList({ listId: id, title: "Browser smoke" });
    await repo.insertTask(id, { itemId: "first", text: "First" });
    await repo.insertTask(id, { itemId: "second", text: "Second", afterId: "first" });
    await repo.updateTask(id, "second", { done: true, note: "Saved" });
  }, listId);

  await page.goto("/?sync=1");
  await expect.poll(() => page.evaluate((id) =>
    (window as any).listsApp?.repository?.getListSnapshot(id)
      .map((item: { id: string; text: string; done: boolean; note: string }) => ({
        id: item.id,
        text: item.text,
        done: item.done,
        note: item.note,
      })) ?? [], listId), { timeout: 15_000 }).toEqual([
    { id: "first", text: "First", done: false, note: "" },
    { id: "second", text: "Second", done: true, note: "Saved" },
  ]);
});
