import type { Page } from "@playwright/test";
import {
  buildExportSnapshot,
  stringifyExportSnapshot,
} from "../src/app/export-snapshot.js";
import { test, expect } from "./fixtures";
import { dragHandleToTarget } from "./helpers/drag";
import { openSidebarOptions } from "./helpers/sidebar";

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
  await openSidebarOptions(page);
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
    const pushPromise = pageA.waitForResponse(
      (response) =>
        response.url().includes("/sync/push") &&
        response.status() === 200 &&
        (response.request().postData() ?? "").includes(uniqueText),
      { timeout: 10_000 }
    );
    await addTask(pageA, uniqueText);
    await pushPromise;

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
    const pushPromise = pageA.waitForResponse(
      (response) =>
        response.url().includes("/sync/push") &&
        response.status() === 200 &&
        (response.request().postData() ?? "").includes(uniqueText),
      { timeout: 10_000 }
    );
    await addTask(pageA, uniqueText);
    await pushPromise;

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

test("new tasks go to the top of tasks added by an earlier actor", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  await contextA.addInitScript(() => {
    window.localStorage.setItem("prototypeLists.actorId", "actor-a");
  });
  const contextB = await browser.newContext();
  await contextB.addInitScript(() => {
    window.localStorage.setItem("prototypeLists.actorId", "actor-z");
  });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await Promise.all([
      pageA.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageA.goto("/?sync=1"),
    ]);

    const listTitle = `Prepended ${Date.now()}`;
    await createList(pageA, listTitle);

    // Add enough tasks at the top that the first position reaches digit zero.
    for (let i = 1; i <= 12; i += 1) {
      await addTask(pageA, `Existing ${i}`);
    }

    await Promise.all([
      pageB.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageB.goto("/?sync=1"),
    ]);
    await selectList(pageB, listTitle);
    await expect(taskItem(pageB, "Existing 1")).toBeVisible({
      timeout: 10_000,
    });
    await addTask(pageB, "Newest task");

    const texts = await pageB
      .locator(listItemsSelector)
      .locator(".text")
      .allTextContents();
    expect(texts[0]).toBe("Newest task");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("list reorder propagates to other clients", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const sidebarNames = (page: Page) =>
    page
      .locator("[data-role='sidebar-list'] .sidebar-list-label")
      .allTextContents();
  try {
    await Promise.all([
      pageA.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageA.goto("/?sync=1&resetStorage=1"),
    ]);
    await Promise.all([
      pageB.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageB.goto("/?sync=1&resetStorage=1"),
    ]);

    await createList(pageA, "List A");
    await createList(pageA, "List B");
    await createList(pageA, "List C");
    await expect
      .poll(() => sidebarNames(pageB), { timeout: 10_000 })
      .toEqual(["List A", "List B", "List C"]);

    const items = pageA.locator("[data-role='sidebar-list'] li");
    await dragHandleToTarget(
      items.nth(2).locator(".sidebar-list-handle"),
      items.nth(0),
      { targetPosition: { x: 10, y: 2 } }
    );

    await expect
      .poll(() => sidebarNames(pageA), { timeout: 10_000 })
      .toEqual(["List C", "List A", "List B"]);
    await expect
      .poll(() => sidebarNames(pageB), { timeout: 10_000 })
      .toEqual(["List C", "List A", "List B"]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("concurrent list reorders converge across clients", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const registryIds = (page: Page) =>
    page.evaluate(() =>
      (window as any).listsApp.repository
        .getRegistrySnapshot()
        .map((entry: { id: string }) => entry.id)
    );
  try {
    await Promise.all([
      pageA.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageA.goto("/?sync=1&resetStorage=1"),
    ]);
    await Promise.all([
      pageB.waitForResponse((response) =>
        response.url().includes("/sync/bootstrap")
      ),
      pageB.goto("/?sync=1&resetStorage=1"),
    ]);

    await createList(pageA, "List A");
    await createList(pageA, "List B");
    await createList(pageA, "List C");
    await createList(pageA, "List D");
    await expect
      .poll(() => registryIds(pageB), { timeout: 10_000 })
      .toHaveLength(4);

    // Both clients edit the same list to different positions while offline, so
    // their reorder operations carry the same Lamport clock.
    await contextA.setOffline(true);
    await contextB.setOffline(true);
    await pageA.evaluate(async () => {
      const repository = (window as any).listsApp.repository;
      const ids = repository
        .getRegistrySnapshot()
        .map((entry: { id: string }) => entry.id);
      await repository.reorderList(ids[2], { beforeId: ids[0] });
    });
    await pageB.evaluate(async () => {
      const repository = (window as any).listsApp.repository;
      const ids = repository
        .getRegistrySnapshot()
        .map((entry: { id: string }) => entry.id);
      await repository.reorderList(ids[2], { afterId: ids[3] });
    });
    await contextA.setOffline(false);
    await contextB.setOffline(false);

    // After both clients reconnect and exchange their reorders, they must agree
    // on a single order even though neither saw the other's move when it was made.
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([
            registryIds(pageA),
            registryIds(pageB),
          ]);
          return { converged: JSON.stringify(a) === JSON.stringify(b), a, b };
        },
        { timeout: 15_000 }
      )
      .toMatchObject({ converged: true });
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("concurrent task completion and move converge after mixed edits", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const readTasks = (page: Page, listId: string) =>
    page.evaluate(
      (id) =>
        (window as any).listsApp.repository
          .getListSnapshot(id)
          .map((item: { id: string; text: string; done: boolean; note: string }) => ({
            id: item.id,
            text: item.text,
            done: item.done,
            note: item.note,
          })),
      listId
    );
  const readPositions = (page: Page, listId: string) =>
    page.evaluate((id) =>
      (window as any).listsApp.repository.getListSnapshot(id)
        .map((item: { id: string; pos: unknown }) => ({ id: item.id, pos: item.pos })), listId);
  try {
    await Promise.all([
      pageA.waitForResponse((r) => r.url().includes("/sync/bootstrap")),
      pageA.goto("/?sync=1&resetStorage=1"),
    ]);
    await Promise.all([
      pageB.waitForResponse((r) => r.url().includes("/sync/bootstrap")),
      pageB.goto("/?sync=1&resetStorage=1"),
    ]);
    const title = `Task order ${Date.now()}`;
    await createList(pageA, title);
    await selectList(pageB, title);
    const listId = await pageA.evaluate(
      (name) =>
        (window as any).listsApp.repository
          .getRegistrySnapshot()
          .find((entry: { id: string; title: string }) => entry.title === name)
          .id,
      title
    );
    await pageA.evaluate(async (id) => {
      const repo = (window as any).listsApp.repository;
      await repo.insertTask(id, { itemId: "alpha", text: "Alpha" });
      await repo.insertTask(id, {
        itemId: "beta",
        text: "Beta",
        afterId: "alpha",
      });
      await repo.insertTask(id, {
        itemId: "gamma",
        text: "Gamma",
        afterId: "beta",
      });
      await repo.insertTask(id, {
        itemId: "removed",
        text: "Removed",
        afterId: "gamma",
      });
      await repo.updateTask(id, "gamma", { done: true });
      await repo.removeTask(id, "removed");
    }, listId);
    await expect.poll(() => readTasks(pageB, listId)).toEqual([
      { id: "alpha", text: "Alpha", done: false, note: "" },
      { id: "beta", text: "Beta", done: false, note: "" },
      { id: "gamma", text: "Gamma", done: true, note: "" },
    ]);

    await contextA.setOffline(true);
    await contextB.setOffline(true);
    await pageA.evaluate(async (id) => {
      await (window as any).listsApp.repository.moveTaskWithinList(id, "beta", {
        beforeId: "alpha",
      });
      await (window as any).listsApp.repository.updateTask(id, "beta", {
        text: "Beta edited",
        note: "From desktop",
      });
    }, listId);
    await pageB.evaluate(async (id) => {
      await (window as any).listsApp.repository.updateTask(id, "beta", { done: true });
    }, listId);
    await contextA.setOffline(false);
    await contextB.setOffline(false);

    const expected = [
      { id: "beta", text: "Beta edited", done: true, note: "From desktop" },
      { id: "alpha", text: "Alpha", done: false, note: "" },
      { id: "gamma", text: "Gamma", done: true, note: "" },
    ];
    await expect.poll(() => readTasks(pageA, listId), { timeout: 15_000 }).toEqual(expected);
    await expect.poll(() => readTasks(pageB, listId), { timeout: 15_000 }).toEqual(expected);
    await expect.poll(async () => {
      const [a, b] = await Promise.all([readPositions(pageA, listId), readPositions(pageB, listId)]);
      return JSON.stringify(a) === JSON.stringify(b);
    }).toBe(true);
    await pageB.goto("/?sync=1");
    await pageB.waitForFunction(() => Boolean((window as any).listsApp?.repository));
    await expect.poll(() => readTasks(pageB, listId), { timeout: 15_000 }).toEqual(expected);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("an offline edit syncs after its client closes and restarts", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await Promise.all([
      pageA.waitForResponse((r) => r.url().includes("/sync/bootstrap")),
      pageA.goto("/?sync=1&resetStorage=1"),
    ]);
    await Promise.all([
      pageB.waitForResponse((r) => r.url().includes("/sync/bootstrap")),
      pageB.goto("/?sync=1&resetStorage=1"),
    ]);
    const title = `Restart ${Date.now()}`;
    const itemId = crypto.randomUUID();
    await createList(pageA, title);
    await selectList(pageB, title);
    const listId = await pageA.evaluate((name) =>
      (window as any).listsApp.repository.getRegistrySnapshot()
        .find((entry: { id: string; title: string }) => entry.title === name).id, title);

    await contextB.setOffline(true);
    await pageB.evaluate(async ({ listId, itemId }) => {
      await (window as any).listsApp.repository.insertTask(listId, {
        itemId,
        text: "Edited while offline",
        note: "Survives restart",
      });
    }, { listId, itemId });
    await pageB.close();
    await contextB.setOffline(false);

    const restarted = await contextB.newPage();
    await restarted.goto("/?sync=1");
    await expect.poll(() => restarted.evaluate((id) =>
      (window as any).listsApp?.repository?.getListSnapshot(id)
        .map((item: { id: string }) => item.id) ?? [], listId),
    { timeout: 15_000 }).toContain(itemId);
    await expect.poll(() => pageA.evaluate((id) =>
      (window as any).listsApp.repository.getListSnapshot(id)
        .map((item: { id: string; text: string; note: string }) => ({
          id: item.id,
          text: item.text,
          note: item.note,
        })), listId),
    { timeout: 15_000 }).toContainEqual({
      id: itemId,
      text: "Edited while offline",
      note: "Survives restart",
    });
  } finally {
    await contextA.close();
    await contextB.close();
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
