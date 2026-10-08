// Model-based test of the task list UI.
//
// fast-check generates random sequences of user input (add a task, type,
// Enter, Backspace, Home/End, Escape, click a task, tick a task off, move a
// task, switch "Show done", undo, redo, reload) and runs them in the browser
// against a plain model of what the user should see: the tasks in order,
// their done state, which are hidden, which task is being edited, where the
// cursor is, and what undo and redo would do. Between them, a second device
// adds, changes, ticks off, deletes and moves tasks through the sync server.
//
// Undo reverts only the user's own changes and keeps the other device's, so
// the model records each change as operations on tasks, as the repository
// does. Tasks are ordered by position; the model makes positions with the
// app's own `between`, so it knows where a task goes when both devices put
// one between the same neighbours. Keys are typed in bursts at chosen times
// on the page's clock, so which keystrokes merge into one undo step is
// decided as the model expects.
//
// After every step the page must match the model, and before each reload the
// saved data must match it too. Some runs slow the CPU down. A failing run is
// shrunk to a minimal sequence.
import type { Browser, Page } from "@playwright/test";
import * as fc from "fast-check";
import { between, comparePositions } from "../src/domain/crdt/position.js";
import { test, expect } from "./fixtures";
import { openSidebarOptions } from "./helpers/sidebar";

const tasksSelector =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder)";
const visibleTasks = `${tasksSelector}:not([hidden])`;

// --- Model ---------------------------------------------------------------

type Position = ReturnType<typeof between>;
type Task = { id: string; text: string; done: boolean; pos: Position; deleted: boolean };

/** A change to the tasks, as the repository records it for undo and redo. */
type Op =
  | {
      type: "insert";
      id: string;
      text: string;
      done: boolean;
      afterId: string | null;
      beforeId: string | null;
      /** A position to restore; without one, it goes between the neighbours. */
      pos: Position | null;
    }
  | { type: "remove"; id: string }
  | { type: "update"; id: string; text?: string; done?: boolean }
  | { type: "move"; id: string; afterId: string | null; beforeId: string | null; pos: Position | null };
type UndoStep = { undo: Op[]; redo: Op[] };

type Model = {
  /** Every task by id, deleted ones too: their positions still count. */
  tasks: Map<string, Task>;
  /** The actor ids of this device and the other one. */
  actors: { local: string; remote: string };
  showDone: boolean;
  /** The task being edited, and the cursor in it. */
  editing: { id: string; caret: number } | null;
  undo: UndoStep[];
  redo: UndoStep[];
  /** The time on the page's clock, in ms. */
  time: number;
  /** The task whose text the last undo step changed, and when, while typing may merge. */
  typing: { id: string; at: number } | null;
};

const PAUSE_MS = 10_000;
// Keys that change text within this time of the previous text change of the
// same task merge into its undo step, unless they add or remove a word break.
const MERGE_WINDOW_MS = 1000;
const WORD_BREAK = /[\s.,;:!?]/;

/** The tasks in list order, as the app sorts them. */
const ordered = (m: Readonly<Model>) =>
  [...m.tasks.values()]
    .filter((task) => !task.deleted)
    .sort((a, b) => comparePositions(a.pos, b.pos) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
// A done task stays visible while it is being edited, also when the other
// device ticked it off, and is hidden once editing ends.
const isVisible = (m: Readonly<Model>, task: Task) =>
  m.showDone || !task.done || m.editing?.id === task.id;
const visible = (m: Readonly<Model>) => ordered(m).filter((task) => isVisible(m, task));
const task = (m: Readonly<Model>, id: string) => m.tasks.get(id)!;
/** The tasks next to a task in list order, hidden ones included. */
const neighbours = (m: Readonly<Model>, id: string) => {
  const order = ordered(m);
  const i = order.findIndex((t) => t.id === id);
  return { afterId: order[i - 1]?.id ?? null, beforeId: order[i + 1]?.id ?? null };
};
/** The nearest visible task above or below. */
const visibleNeighbour = (m: Readonly<Model>, id: string, direction: -1 | 1) => {
  const tasks = visible(m);
  return tasks[tasks.findIndex((t) => t.id === id) + direction]?.id ?? null;
};

/** A new position between two tasks, as `actor` makes it. */
const positionBetween = (m: Model, afterId: string | null, beforeId: string | null, actor: string) =>
  between(afterId ? m.tasks.get(afterId)?.pos : null, beforeId ? m.tasks.get(beforeId)?.pos : null, {
    actor,
  });

/** Applies a change, made by `actor`. Changes to deleted tasks do nothing. */
function apply(m: Model, op: Op, actor: string) {
  const existing = m.tasks.get(op.id);
  const live = existing && !existing.deleted ? existing : null;
  switch (op.type) {
    case "insert": {
      // Inserting a deleted task brings it back.
      const pos = op.pos ?? positionBetween(m, op.afterId, op.beforeId, actor);
      m.tasks.set(op.id, { id: op.id, text: op.text, done: op.done, pos, deleted: false });
      return;
    }
    case "remove":
      if (live) live.deleted = true;
      return;
    case "update":
      if (live && op.text !== undefined) live.text = op.text;
      if (live && op.done !== undefined) live.done = op.done;
      return;
    case "move":
      if (live) live.pos = op.pos ?? positionBetween(m, op.afterId, op.beforeId, actor);
      return;
  }
}

/** Makes a change of this device's user, as one new undo step. */
function change(m: Model, step: UndoStep) {
  step.redo.forEach((op) => apply(m, op, m.actors.local));
  m.undo.push(step);
  m.redo = [];
  m.typing = null;
}

/** The op that puts a task back where and as it is now. */
const restore = (m: Readonly<Model>, id: string): Op => {
  const { text, done, pos } = task(m, id);
  return { type: "insert", id, text, done, ...neighbours(m, id), pos };
};

/** A key that changed a task's text now: merges into the last step or starts one. */
function textEdit(m: Model, id: string, text: string, changed: string) {
  const redo: Op[] = [{ type: "update", id, text }];
  const merges =
    m.typing?.id === id && m.time - m.typing.at <= MERGE_WINDOW_MS && !WORD_BREAK.test(changed);
  if (merges) {
    m.undo[m.undo.length - 1].redo = redo;
    m.redo = [];
    apply(m, redo[0], m.actors.local);
  } else {
    change(m, { undo: [{ type: "update", id, text: task(m, id).text }], redo });
  }
  m.typing = { id, at: m.time };
}

// --- Real system ---------------------------------------------------------

/** This device's page, the other device's page, and a URL to view the list. */
type Real = { page: Page; remote: Page; browser: Browser; viewerUrl: string };

/** Moves the page's clock and the model's time forward together. */
async function wait(m: Model, r: Real, ms: number) {
  m.time += ms;
  await r.page.clock.setFixedTime(m.time);
}

const sidebarButton = (page: Page, name: "Undo" | "Redo") =>
  page.locator("[data-role='sidebar']").getByRole("button", { name, exact: true });

/** The id of the task being edited, once it is not one of `known`. */
async function newEditedTask(page: Page, known: Map<string, Task>) {
  let id: string | null = null;
  await expect
    .poll(async () => {
      id = await page.evaluate(
        () => (document.activeElement?.closest("li") as HTMLElement | null)?.dataset.itemId ?? null
      );
      return id !== null && !known.has(id);
    })
    .toBe(true);
  return id!;
}

/** What the page shows, read as the model describes it. */
async function readPage(page: Page) {
  return page.locator(tasksSelector).evaluateAll((items) =>
    items.map((li) => {
      const text = li.querySelector(".text") as HTMLElement | null;
      const toggle = li.querySelector(".done-toggle") as HTMLInputElement | null;
      return {
        id: (li as HTMLElement).dataset.itemId,
        text: text?.textContent ?? "",
        done: Boolean(toggle?.checked),
        hidden: (li as HTMLElement).hidden,
        editing: text?.getAttribute("contenteditable") === "true",
        focused: text !== null && document.activeElement === text,
      };
    })
  );
}

function expected(m: Model) {
  return ordered(m).map(({ id, text, done }) => ({
    id,
    text,
    done,
    hidden: !isVisible(m, task(m, id)),
    editing: m.editing?.id === id,
    focused: m.editing?.id === id,
  }));
}

/** The tasks of a page, without what only this device shows. */
const readTasks = (page: Page) =>
  page.locator(tasksSelector).evaluateAll((items) =>
    items.map((li) => ({
      id: (li as HTMLElement).dataset.itemId,
      text: li.querySelector(".text")?.textContent ?? "",
      done: Boolean((li.querySelector(".done-toggle") as HTMLInputElement | null)?.checked),
    }))
  );
const expectedTasks = (m: Model) => ordered(m).map(({ id, text, done }) => ({ id, text, done }));

async function assertMatches(m: Model, r: Real, when: string) {
  await expect
    .poll(() => readPage(r.page), { message: when, timeout: 10_000 })
    .toEqual(expected(m));
  for (const [name, steps] of [["Undo", m.undo], ["Redo", m.redo]] as const) {
    const button = sidebarButton(r.page, name);
    if (steps.length) await expect(button, `${when}: ${name}`).toBeEnabled();
    else await expect(button, `${when}: ${name}`).toBeDisabled();
  }
  if (m.editing) {
    const caret = await r.page.evaluate(() => {
      const selection = window.getSelection();
      const editing = document.activeElement as HTMLElement | null;
      if (!selection?.rangeCount || !editing) return null;
      const range = selection.getRangeAt(0).cloneRange();
      range.selectNodeContents(editing);
      range.setEnd(selection.focusNode!, selection.focusOffset);
      return range.toString().length;
    });
    expect(caret, `${when}: cursor`).toBe(m.editing.caret);
  }
}

/** The saved data, read in a second tab so saves still running are not cut off. */
async function assertSaved(m: Model, r: Real) {
  const viewer = await r.page.context().newPage();
  await expect
    .poll(
      async () => {
        await viewer.goto(r.viewerUrl);
        await viewer
          .locator("[data-role='lists-container'] .list-section.is-active")
          .waitFor({ state: "attached" });
        return readTasks(viewer);
      },
      { message: "saved data", timeout: 20_000 }
    )
    .toEqual(expectedTasks(m));
  await viewer.close();
}

/** How many changes this device saved but has not sent to the sync server. */
const unsent = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("protoLists");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction("syncOutbox").objectStore("syncOutbox").get("outbox");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            db.close();
            resolve(get.result?.ops?.length ?? 0);
          };
        };
      })
  );

/**
 * Waits until the other device has every change of this one, so a change it
 * makes comes after them.
 */
async function settle(m: Model, r: Real) {
  await expect.poll(() => unsent(r.page), { message: "changes sent", timeout: 10_000 }).toBe(0);
  await expect
    .poll(() => readTasks(r.remote), { message: "other device", timeout: 10_000 })
    .toEqual(expectedTasks(m));
}

// --- Steps ---------------------------------------------------------------

class Step implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly label: string,
    readonly check: (m: Readonly<Model>) => boolean,
    private readonly act: (m: Model, r: Real) => Promise<void>,
    // Steps are far apart, unless a step decides its own timing.
    private readonly options = { pause: true }
  ) {}
  async run(m: Model, r: Real) {
    if (this.options.pause) await wait(m, r, PAUSE_MS);
    await this.act(m, r);
    await assertMatches(m, r, `after ${this.label}`);
  }
  toString = () => this.label;
}

const editing = (m: Readonly<Model>) => m.editing !== null;
const index = fc.nat(30);

const addTask = new Step("Add", () => true, async (m, r) => {
  const first = ordered(m)[0]?.id ?? null;
  await r.page.getByRole("button", { name: "Add task" }).first().click();
  const id = await newEditedTask(r.page, m.tasks);
  change(m, {
    undo: [{ type: "remove", id }],
    redo: [{ type: "insert", id, text: "", done: false, afterId: null, beforeId: first, pos: null }],
  });
  m.editing = { id, caret: 0 };
});

// A burst of keys, each typed a given time after the key or step before it.
// The times sit on both sides of the merge window.
const typeKeys = (keys: [string, number][]) =>
  new Step(
    `Type ${keys.map(([key, delay]) => `+${delay}ms ${JSON.stringify(key)}`).join(" ")}`,
    editing,
    async (m, r) => {
      const e = m.editing!;
      for (const [key, delay] of keys) {
        await wait(m, r, delay);
        await r.page.keyboard.type(key);
        const text = task(m, e.id).text;
        textEdit(m, e.id, text.slice(0, e.caret) + key + text.slice(e.caret), key);
        e.caret += 1;
      }
    },
    { pause: false }
  );
const type = fc
  .array(fc.tuple(fc.constantFrom("a", "b", " "), fc.constantFrom(100, 999, 1000, 1001, 5000)), {
    minLength: 1,
    maxLength: 5,
  })
  .map(typeKeys);

const enter = new Step("Enter", editing, async (m, r) => {
  const e = m.editing!;
  const { text } = task(m, e.id);
  const next = neighbours(m, e.id).beforeId;
  await r.page.keyboard.press("Enter");
  const id = await newEditedTask(r.page, m.tasks);
  change(m, {
    undo: [
      { type: "remove", id },
      { type: "update", id: e.id, text },
    ],
    redo: [
      { type: "update", id: e.id, text: text.slice(0, e.caret) },
      { type: "insert", id, text: text.slice(e.caret), done: false, afterId: e.id, beforeId: next, pos: null },
    ],
  });
  m.editing = { id, caret: 0 };
});

const backspace = new Step("Backspace", editing, async (m, r) => {
  await r.page.keyboard.press("Backspace");
  const e = m.editing!;
  const { text } = task(m, e.id);
  if (e.caret > 0) {
    textEdit(m, e.id, text.slice(0, e.caret - 1) + text.slice(e.caret), text[e.caret - 1]);
    e.caret -= 1;
    return;
  }
  const above = visibleNeighbour(m, e.id, -1);
  if (text.length === 0) {
    // An empty task is deleted; the cursor goes to the end of the visible
    // task above, or below if there is none.
    const target = above ?? visibleNeighbour(m, e.id, 1);
    change(m, { undo: [restore(m, e.id)], redo: [{ type: "remove", id: e.id }] });
    m.editing = target === null ? null : { id: target, caret: task(m, target).text.length };
    return;
  }
  if (above === null) return;
  // Joins the task to the visible task above, the cursor at the join.
  const aboveText = task(m, above).text;
  change(m, {
    undo: [restore(m, e.id), { type: "update", id: above, text: aboveText }],
    redo: [
      { type: "update", id: above, text: aboveText + text },
      { type: "remove", id: e.id },
    ],
  });
  m.editing = { id: above, caret: aboveText.length };
});

const homeOrEnd = fc.constantFrom("Home", "End").map(
  (key) =>
    new Step(key, editing, async (m, r) => {
      await r.page.keyboard.press(key);
      const e = m.editing!;
      e.caret = key === "Home" ? 0 : task(m, e.id).text.length;
    })
);

const escape = new Step("Escape", editing, async (m, r) => {
  await r.page.keyboard.press("Escape");
  m.editing = null;
});

/** Moves the task being edited past the visible task above or below it. */
const move = fc.constantFrom("up", "down").map(
  (direction) =>
    new Step(`Move ${direction}`, editing, async (m, r) => {
      await r.page.keyboard.press(`ControlOrMeta+${direction === "up" ? "ArrowUp" : "ArrowDown"}`);
      const { id } = m.editing!;
      const past = visibleNeighbour(m, id, direction === "up" ? -1 : 1);
      if (past === null) return;
      const rest = ordered(m).filter((t) => t.id !== id);
      const at = rest.findIndex((t) => t.id === past) + (direction === "up" ? 0 : 1);
      change(m, {
        undo: [{ type: "move", id, ...neighbours(m, id), pos: task(m, id).pos }],
        redo: [
          {
            type: "move",
            id,
            afterId: rest[at - 1]?.id ?? null,
            beforeId: rest[at]?.id ?? null,
            pos: null,
          },
        ],
      });
    })
);

const hasVisible = (m: Readonly<Model>) => visible(m).length > 0;

const clickTask = index.map(
  (n) =>
    new Step(`Click task ${n}, End`, hasVisible, async (m, r) => {
      const tasks = visible(m);
      const position = n % tasks.length;
      await r.page.locator(visibleTasks).nth(position).locator(".text").click();
      await r.page.keyboard.press("End");
      const { id, text } = tasks[position];
      m.editing = { id, caret: text.length };
    })
);

const toggle = index.map(
  (n) =>
    new Step(`Tick task ${n}`, hasVisible, async (m, r) => {
      const tasks = visible(m);
      const position = n % tasks.length;
      await r.page.locator(visibleTasks).nth(position).locator(".done-toggle").click();
      const { id, done } = tasks[position];
      change(m, {
        undo: [{ type: "update", id, done }],
        redo: [{ type: "update", id, done: !done }],
      });
      m.editing = null;
    })
);

const showDone = new Step("Show done", () => true, async (m, r) => {
  await r.page
    .locator("[data-role='lists-container'] .list-section.is-active .tasklist-show-done-toggle")
    .click();
  m.showDone = !m.showDone;
  m.editing = null;
});

const reload = new Step("Reload", () => true, async (m, r) => {
  await assertSaved(m, r);
  await r.page.reload();
  // "Show done" and the undo history are not kept across reloads.
  m.showDone = false;
  m.editing = null;
  m.undo = [];
  m.redo = [];
  m.typing = null;
});

/** The sidebar buttons; clicking one ends editing. */
const history = (name: "Undo" | "Redo") =>
  new Step(name, (m) => (name === "Undo" ? m.undo : m.redo).length > 0, async (m, r) => {
    await sidebarButton(r.page, name).click();
    const [from, to] = name === "Undo" ? [m.undo, m.redo] : [m.redo, m.undo];
    const step = from.pop()!;
    (name === "Undo" ? step.undo : step.redo).forEach((op) => apply(m, op, m.actors.local));
    to.push(step);
    m.editing = null;
    m.typing = null;
  });

// --- Steps of the other device -------------------------------------------
//
// The other device shows done tasks, so it sees every task in model order.
// It makes each change once it has this device's changes, then ends editing.

/** A change the other device makes; this device's edit adjusts to it. */
const remoteStep = (
  label: string,
  check: (m: Readonly<Model>) => boolean,
  act: (m: Model, r: Real) => Promise<void>
) =>
  new Step(`Other device: ${label}`, check, async (m, r) => {
    await settle(m, r);
    await act(m, r);
    await r.remote.keyboard.press("Escape");
    if (m.editing && task(m, m.editing.id).deleted) m.editing = null;
  });

const hasTasks = (m: Readonly<Model>) => ordered(m).length > 0;
const remoteTask = (r: Real, position: number) => r.remote.locator(tasksSelector).nth(position);
/** Starts editing a task on the other device, the cursor at its end. */
async function remoteEdit(r: Real, position: number) {
  await remoteTask(r, position).locator(".text").click();
  await r.remote.keyboard.press("End");
}

const remoteAdd = remoteStep('Add "r"', () => true, async (m, r) => {
  const first = ordered(m)[0]?.id ?? null;
  await r.remote.getByRole("button", { name: "Add task" }).first().click();
  const id = await newEditedTask(r.remote, m.tasks);
  await r.remote.keyboard.type("r");
  apply(
    m,
    { type: "insert", id, text: "r", done: false, afterId: null, beforeId: first, pos: null },
    m.actors.remote
  );
});

const remoteType = index.map((n) =>
  remoteStep(`Type "z" in task ${n}`, hasTasks, async (m, r) => {
    const tasks = ordered(m);
    const position = n % tasks.length;
    await remoteEdit(r, position);
    await r.remote.keyboard.type("z");
    const { id, text } = tasks[position];
    apply(m, { type: "update", id, text: `${text}z` }, m.actors.remote);
    // The task being edited shows the new text, the cursor at its end.
    if (m.editing?.id === id) m.editing.caret = text.length + 1;
  })
);

const remoteToggle = index.map((n) =>
  remoteStep(`Tick task ${n}`, hasTasks, async (m, r) => {
    const tasks = ordered(m);
    const position = n % tasks.length;
    await remoteTask(r, position).locator(".done-toggle").click();
    const { id, done } = tasks[position];
    apply(m, { type: "update", id, done: !done }, m.actors.remote);
  })
);

const remoteRemove = index.map((n) =>
  remoteStep(`Delete task ${n}`, hasTasks, async (m, r) => {
    const tasks = ordered(m);
    const position = n % tasks.length;
    await remoteEdit(r, position);
    await r.remote.keyboard.press("ControlOrMeta+Shift+Backspace");
    apply(m, { type: "remove", id: tasks[position].id }, m.actors.remote);
  })
);

const remoteMove = fc.tuple(index, fc.constantFrom("up", "down")).map(([n, direction]) =>
  remoteStep(`Move task ${n} ${direction}`, hasTasks, async (m, r) => {
    const tasks = ordered(m);
    const position = n % tasks.length;
    await remoteEdit(r, position);
    await r.remote.keyboard.press(`ControlOrMeta+${direction === "up" ? "ArrowUp" : "ArrowDown"}`);
    const to = position + (direction === "up" ? -1 : 1);
    if (to < 0 || to >= tasks.length) return;
    const rest = tasks.filter((_, i) => i !== position);
    apply(
      m,
      {
        type: "move",
        id: tasks[position].id,
        afterId: rest[to - 1]?.id ?? null,
        beforeId: rest[to]?.id ?? null,
        pos: null,
      },
      m.actors.remote
    );
  })
);

// Typing and undo come up most, so typed text is often undone. Clicking a
// task comes up often too, as many steps end editing.
const commands = [
  fc.constant(addTask),
  fc.constant(addTask),
  type,
  type,
  type,
  type,
  fc.constant(enter),
  fc.constant(backspace),
  fc.constant(backspace),
  homeOrEnd,
  fc.constant(escape),
  move,
  clickTask,
  clickTask,
  toggle,
  fc.constant(showDone),
  fc.constant(history("Undo")),
  fc.constant(history("Undo")),
  fc.constant(history("Undo")),
  fc.constant(history("Redo")),
  fc.constant(reload),
  fc.constant(remoteAdd),
  remoteType,
  remoteToggle,
  remoteRemove,
  remoteMove,
];

// --- Property ------------------------------------------------------------

const actorId = (page: Page) =>
  page.evaluate(() => localStorage.getItem("prototypeLists.actorId") ?? "");

test("the task list matches the model for any sequence of user input", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CPU throttling uses CDP");
  test.setTimeout(15 * 60_000);
  await fc.assert(
    fc.asyncProperty(
      fc.commands(commands, { maxCommands: 100, size: "max" }),
      fc.constantFrom(1, 4),
      async (cmds, cpuSlowdown) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        const remote = await remoteContext.newPage();
        try {
          const start = Date.UTC(2026, 0, 1);
          await page.clock.setFixedTime(start);
          // The sync server keeps the lists of earlier runs.
          const title = `Model ${crypto.randomUUID()}`;
          page.on("dialog", (dialog) => dialog.accept(title));
          await page.goto("/?sync=1");
          await openSidebarOptions(page);
          await page.getByRole("button", { name: "Add list" }).click();
          await expect(page.locator("[data-role='active-list-title']")).toHaveText(title);
          const viewerUrl = page.url();
          // Reloading clears the undo history, which holds creating the list.
          await page.reload();
          await expect(sidebarButton(page, "Undo")).toBeDisabled();

          await remote.goto(viewerUrl);
          await remote
            .locator("[data-role='sidebar-list'] .sidebar-list-button")
            .filter({ hasText: title })
            .click();
          await expect(remote.locator("[data-role='active-list-title']")).toHaveText(title);
          await remote
            .locator("[data-role='lists-container'] .list-section.is-active .tasklist-show-done-toggle")
            .click();

          if (cpuSlowdown > 1) {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuSlowdown });
          }
          const model: Model = {
            tasks: new Map(),
            actors: { local: await actorId(page), remote: await actorId(remote) },
            showDone: false,
            editing: null,
            undo: [],
            redo: [],
            time: start,
            typing: null,
          };
          const real = { page, remote, browser, viewerUrl };
          await fc.asyncModelRun(() => ({ model, real }), cmds);
          await assertSaved(model, real);
        } finally {
          await context.close();
          await remoteContext.close();
        }
      }
    ),
    { numRuns: Number(process.env.UI_MODEL_RUNS ?? 10), includeErrorInReport: true }
  );
});
