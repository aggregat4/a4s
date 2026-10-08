// Model-based test of the task list UI.
//
// fast-check generates random sequences of user input (add a task, type,
// Enter, Backspace, Home/End, Escape, click a task, tick a task off, switch
// "Show done", undo, redo, reload) and runs them in the browser against a
// plain model of what the user should see: the visible tasks, their done
// state, which task is being edited, where the cursor is, and what undo and
// redo would do. Keys are typed in bursts at chosen times on the page's clock,
// so which keystrokes merge into one undo step is decided as the model
// expects. After every step the page must match the model, and before each
// reload the saved data must match it too.
// Some runs slow the CPU down. A failing run is shrunk to a minimal sequence.
import type { Browser, Page } from "@playwright/test";
import * as fc from "fast-check";
import { test, expect } from "./fixtures";
import { openSidebarOptions } from "./helpers/sidebar";

const visibleTasks =
  "[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder):not([hidden])";

// --- Model ---------------------------------------------------------------

type Task = { text: string; done: boolean };
type Model = {
  tasks: Task[];
  showDone: boolean;
  /** The task being edited, as an index into `tasks`, and the cursor in it. */
  editing: { task: number; caret: number } | null;
  /** The tasks before each undoable change, and before each undo. */
  undo: Task[][];
  redo: Task[][];
  /** The time on the page's clock, in ms. */
  time: number;
  /** The task whose text the last undo step changed, and when, while typing may merge. */
  typing: { task: Task; at: number } | null;
};

const PAUSE_MS = 10_000;
// Keys that change text within this time of the previous text change of the
// same task merge into its undo step, unless they add or remove a word break.
const MERGE_WINDOW_MS = 1000;
const WORD_BREAK = /[\s.,;:!?]/;

const cloneTasks = (tasks: Task[]) => tasks.map((task) => ({ ...task }));

/** Starts a new undo step: the tasks as they are now. */
function recordUndoStep(m: Model) {
  m.undo.push(cloneTasks(m.tasks));
  m.redo = [];
  m.typing = null;
}

/** A key that changed `task`'s text now: merges into the last step or starts one. */
function textEdit(m: Model, task: Task, changed: string) {
  const merges =
    m.typing?.task === task &&
    m.time - m.typing.at <= MERGE_WINDOW_MS &&
    !WORD_BREAK.test(changed);
  if (!merges) recordUndoStep(m);
  m.redo = [];
  m.typing = { task, at: m.time };
}

const isVisible = (m: Model, task: Task) => m.showDone || !task.done;
const visibleIndexes = (m: Model) =>
  m.tasks.flatMap((task, i) => (isVisible(m, task) ? [i] : []));
/** The nearest visible task above or below, skipping hidden ones. */
const neighbour = (m: Model, i: number, direction: -1 | 1) => {
  for (let j = i + direction; j >= 0 && j < m.tasks.length; j += direction) {
    if (isVisible(m, m.tasks[j])) return j;
  }
  return null;
};

// --- Real system ---------------------------------------------------------

type Real = { page: Page; browser: Browser; viewerUrl: string };

/** Moves the page's clock and the model's time forward together. */
async function wait(m: Model, r: Real, ms: number) {
  m.time += ms;
  await r.page.clock.setFixedTime(m.time);
}

const sidebarButton = (page: Page, name: "Undo" | "Redo") =>
  page.locator("[data-role='sidebar']").getByRole("button", { name, exact: true });

/** What the page shows, read as the model describes it. */
async function readPage(page: Page) {
  return page.locator(visibleTasks).evaluateAll((items) =>
    items.map((li) => {
      const text = li.querySelector(".text") as HTMLElement | null;
      const toggle = li.querySelector(".done-toggle") as HTMLInputElement | null;
      return {
        text: text?.textContent ?? "",
        done: Boolean(toggle?.checked),
        editing: text?.getAttribute("contenteditable") === "true",
        focused: text !== null && document.activeElement === text,
      };
    })
  );
}

function expected(m: Model) {
  return visibleIndexes(m).map((i) => ({
    text: m.tasks[i].text,
    done: m.tasks[i].done,
    editing: m.editing?.task === i,
    focused: m.editing?.task === i,
  }));
}

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
        // "Show done" is off in a fresh tab, so read all tasks from the DOM.
        return viewer
          .locator("[data-role='lists-container'] .list-section.is-visible ol.tasklist li:not(.placeholder)")
          .evaluateAll((items) =>
            items.map((li) => ({
              text: li.querySelector(".text")?.textContent ?? "",
              done: Boolean((li.querySelector(".done-toggle") as HTMLInputElement | null)?.checked),
            }))
          );
      },
      { message: "saved data", timeout: 20_000 }
    )
    .toEqual(m.tasks);
  await viewer.close();
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
  await r.page.getByRole("button", { name: "Add task" }).first().click();
  recordUndoStep(m);
  m.tasks.unshift({ text: "", done: false });
  m.editing = { task: 0, caret: 0 };
});

// A burst of keys, each typed a given time after the key or step before it.
// The times sit on both sides of the merge window.
const typeKeys = (keys: [string, number][]) =>
  new Step(
    `Type ${keys.map(([key, delay]) => `+${delay}ms ${JSON.stringify(key)}`).join(" ")}`,
    editing,
    async (m, r) => {
      const e = m.editing!;
      const task = m.tasks[e.task];
      for (const [key, delay] of keys) {
        await wait(m, r, delay);
        await r.page.keyboard.type(key);
        textEdit(m, task, key);
        task.text = task.text.slice(0, e.caret) + key + task.text.slice(e.caret);
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
  await r.page.keyboard.press("Enter");
  recordUndoStep(m);
  const e = m.editing!;
  const task = m.tasks[e.task];
  const after = task.text.slice(e.caret);
  task.text = task.text.slice(0, e.caret);
  m.tasks.splice(e.task + 1, 0, { text: after, done: false });
  m.editing = { task: e.task + 1, caret: 0 };
});

const backspace = new Step("Backspace", editing, async (m, r) => {
  await r.page.keyboard.press("Backspace");
  const e = m.editing!;
  const task = m.tasks[e.task];
  if (e.caret > 0) {
    textEdit(m, task, task.text[e.caret - 1]);
    task.text = task.text.slice(0, e.caret - 1) + task.text.slice(e.caret);
    e.caret -= 1;
    return;
  }
  const above = neighbour(m, e.task, -1);
  if (task.text.length === 0) {
    recordUndoStep(m);
    // An empty task is deleted; the cursor goes to the end of the visible
    // task above, or below if there is none.
    const target = above ?? neighbour(m, e.task, 1);
    m.tasks.splice(e.task, 1);
    m.editing =
      target === null
        ? null
        : (() => {
            const t = target > e.task ? target - 1 : target;
            return { task: t, caret: m.tasks[t].text.length };
          })();
    return;
  }
  if (above === null) return;
  // Joins the task to the visible task above, the cursor at the join.
  recordUndoStep(m);
  const caret = m.tasks[above].text.length;
  m.tasks[above].text += task.text;
  m.tasks.splice(e.task, 1);
  m.editing = { task: above, caret };
});

const homeOrEnd = fc.constantFrom("Home", "End").map(
  (key) =>
    new Step(key, editing, async (m, r) => {
      await r.page.keyboard.press(key);
      const e = m.editing!;
      e.caret = key === "Home" ? 0 : m.tasks[e.task].text.length;
    })
);

const escape = new Step("Escape", editing, async (m, r) => {
  await r.page.keyboard.press("Escape");
  m.editing = null;
});

const hasVisible = (m: Readonly<Model>) => visibleIndexes(m as Model).length > 0;

const clickTask = index.map(
  (n) =>
    new Step(`Click task ${n}, End`, hasVisible, async (m, r) => {
      const visible = visibleIndexes(m);
      const position = n % visible.length;
      await r.page.locator(visibleTasks).nth(position).locator(".text").click();
      await r.page.keyboard.press("End");
      const i = visible[position];
      m.editing = { task: i, caret: m.tasks[i].text.length };
    })
);

const toggle = index.map(
  (n) =>
    new Step(`Tick task ${n}`, hasVisible, async (m, r) => {
      const visible = visibleIndexes(m);
      const position = n % visible.length;
      await r.page.locator(visibleTasks).nth(position).locator(".done-toggle").click();
      recordUndoStep(m);
      const task = m.tasks[visible[position]];
      task.done = !task.done;
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
    to.push(cloneTasks(m.tasks));
    m.tasks = from.pop()!;
    m.editing = null;
    m.typing = null;
  });

// Typing and undo come up most, so typed text is often undone.
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
  clickTask,
  toggle,
  fc.constant(showDone),
  fc.constant(history("Undo")),
  fc.constant(history("Undo")),
  fc.constant(history("Undo")),
  fc.constant(history("Redo")),
  fc.constant(reload),
];

// --- Property ------------------------------------------------------------

test("the task list matches the model for any sequence of user input", async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CPU throttling uses CDP");
  test.setTimeout(10 * 60_000);
  await fc.assert(
    fc.asyncProperty(
      fc.commands(commands, { maxCommands: 60, size: "max" }),
      fc.constantFrom(1, 4),
      async (cmds, cpuSlowdown) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        try {
          const start = Date.UTC(2026, 0, 1);
          await page.clock.setFixedTime(start);
          page.on("dialog", (dialog) => dialog.accept("Model"));
          await page.goto("/?sync=0");
          await openSidebarOptions(page);
          await page.getByRole("button", { name: "Add list" }).click();
          await expect(page.locator("[data-role='active-list-title']")).toHaveText("Model");
          const viewerUrl = page.url();
          // Reloading clears the undo history, which holds creating the list.
          await page.reload();
          await expect(sidebarButton(page, "Undo")).toBeDisabled();
          if (cpuSlowdown > 1) {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuSlowdown });
          }
          const model: Model = {
            tasks: [],
            showDone: false,
            editing: null,
            undo: [],
            redo: [],
            time: start,
            typing: null,
          };
          await fc.asyncModelRun(() => ({ model, real: { page, browser, viewerUrl } }), cmds);
          await assertSaved(model, { page, browser, viewerUrl });
        } finally {
          await context.close();
        }
      }
    ),
    { numRuns: Number(process.env.UI_MODEL_RUNS ?? 10), includeErrorInReport: true }
  );
});
