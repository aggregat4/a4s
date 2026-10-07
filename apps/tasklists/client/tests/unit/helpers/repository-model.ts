import assert from "node:assert/strict";
import * as fc from "fast-check";
import { ListRepository } from "../../../src/app/list-repository.js";
import type { TaskItem } from "../../../src/types/domain.js";
import type { ListStorage } from "../../../src/types/storage.js";

// --- Model ---------------------------------------------------------------

type ModelTask = { id: string; text: string; done: boolean; note: string };
type ModelList = { id: string; title: string; tasks: ModelTask[] };
type ModelState = { lists: ModelList[] };
export type Model = {
  state: ModelState;
  undo: ModelState[];
  redo: ModelState[];
  nextId: number;
};

const cloneState = (state: ModelState): ModelState =>
  JSON.parse(JSON.stringify(state));

const newId = (model: Model, prefix: string) => `${prefix}-${model.nextId++}`;

// Picks an element by a random number, so commands stay valid as the model
// changes while shrinking.
const pick = <T>(items: T[], n: number) => items[n % items.length];

// --- Real system ---------------------------------------------------------

export type Real = {
  repository: ListRepository;
  /** Opens a new connection to the list's storage, as a page load does. */
  openStorage: () => Promise<ListStorage>;
  identity: Storage;
  now: () => number;
  scheduler: fc.Scheduler;
  pending: Promise<unknown>[];
};

// Stands in for localStorage, which keeps the actor id across reloads.
export const createIdentityStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
};

/**
 * A clock that moves 10 seconds per reading, so text edits never merge into
 * one undo step and every change is its own step, as in the model.
 */
export function createSpacedClock() {
  let time = 1_700_000_000_000;
  return () => (time += 10_000);
}

export const createRepository = (
  storage: ListStorage,
  identity: Storage,
  now: () => number
) =>
  new ListRepository({
    storageFactory: async () => storage,
    listsCrdtOptions: { identityOptions: { storage: identity } },
    now,
  });

/** Lets every requested change and its saves complete. */
export async function settle(real: Real) {
  while (real.pending.length) {
    const pending = real.pending.splice(0);
    await real.scheduler.waitFor(Promise.all(pending));
  }
  await real.scheduler.waitIdle();
}

function snapshot(repository: ListRepository): ModelState {
  return {
    lists: repository.getRegistrySnapshot().map((entry) => {
      const state = repository.getListState(entry.id);
      return {
        id: entry.id,
        title: state.title,
        tasks: state.items.map((item: TaskItem) => ({
          id: item.id,
          text: item.text,
          done: item.done,
          note: item.note ?? "",
        })),
      };
    }),
  };
}

export function assertMatches(model: Model, real: Real, when: string) {
  assert.deepStrictEqual(snapshot(real.repository), model.state, when);
  assert.equal(real.repository.canUndo(), model.undo.length > 0, `${when}: canUndo`);
  assert.equal(real.repository.canRedo(), model.redo.length > 0, `${when}: canRedo`);
}

// --- Commands ------------------------------------------------------------

/**
 * One generated step. `label` shows the generated numbers; `apply` returns
 * what it acted on (task and list ids), which a failure report includes.
 */
class Step implements fc.AsyncCommand<Model, Real> {
  private target = "";
  constructor(
    private readonly label: string,
    readonly check: (m: Readonly<Model>) => boolean,
    private readonly apply: (m: Model, r: Real) => string | void | Promise<void>
  ) {}
  async run(m: Model, r: Real) {
    this.target = (await this.apply(m, r)) || "";
  }
  toString = () => (this.target ? `${this.label} on ${this.target}` : this.label);
}

/**
 * Requests a change from the repository and makes the same change to the
 * model, as one undo step. The request is made first, so its arguments are
 * read before the model changes.
 */
function perform(
  m: Model,
  r: Real,
  request: (repository: ListRepository) => Promise<unknown>,
  mutate: (state: ModelState) => void
) {
  r.pending.push(request(r.repository));
  m.undo.push(cloneState(m.state));
  m.redo = [];
  mutate(m.state);
}

const listIn = (state: ModelState, listId: string) =>
  state.lists.find((list) => list.id === listId)!;

const hasList = (m: Readonly<Model>) => m.state.lists.length > 0;
const hasTasks =
  (count = 1) =>
  (m: Readonly<Model>) =>
    m.state.lists.some((list) => list.tasks.length >= count);

/** A task, from the lists that have at least `minTasks` tasks. */
function pickTask(m: Model, list: number, task: number, minTasks = 1) {
  const l = pick(
    m.state.lists.filter((x) => x.tasks.length >= minTasks),
    list
  );
  const index = task % l.tasks.length;
  return { list: l, index, task: l.tasks[index] };
}

const quote = (value: string) => JSON.stringify(value);
const text = fc.stringMatching(/^[a-z]{0,5}( [a-z]{1,4})?$/);
const index = fc.nat(50);

const addTask = fc.tuple(index, index, text).map(
  ([l, at, value]) =>
    new Step(`AddTask(${l}, at ${at}, ${quote(value)})`, hasList, (m, r) => {
      const list = pick(m.state.lists, l);
      const position = at % (list.tasks.length + 1);
      const id = newId(m, "task");
      const afterId = list.tasks[position - 1]?.id ?? null;
      const beforeId = list.tasks[position]?.id ?? null;
      const task = { id, text: value, done: false, note: "" };
      perform(
        m,
        r,
        (repo) => repo.insertTask(list.id, { itemId: id, text: value, afterId, beforeId }),
        (s) => { listIn(s, list.id).tasks.splice(position, 0, task); }
      );
      return `${id} in ${list.id}`;
    })
);

const editField = (field: "text" | "note") =>
  fc.tuple(index, index, text).map(
    ([l, t, value]) =>
      new Step(`Edit ${field}(${l}, ${t}, ${quote(value)})`, hasTasks(), (m, r) => {
        const { list, index: i, task } = pickTask(m, l, t);
        if (task[field] === value) return;
        perform(
          m,
          r,
          (repo) => repo.updateTask(list.id, task.id, { [field]: value }),
          (s) => { listIn(s, list.id).tasks[i][field] = value; }
        );
        return task.id;
      })
  );

const toggle = fc.tuple(index, index).map(
  ([l, t]) =>
    new Step(`Toggle(${l}, ${t})`, hasTasks(), (m, r) => {
      const { list, index: i, task } = pickTask(m, l, t);
      const done = !task.done;
      perform(
        m,
        r,
        (repo) => repo.toggleTask(list.id, task.id, done),
        (s) => { listIn(s, list.id).tasks[i].done = done; }
      );
      return task.id;
    })
);

const removeTask = fc.tuple(index, index).map(
  ([l, t]) =>
    new Step(`RemoveTask(${l}, ${t})`, hasTasks(), (m, r) => {
      const { list, index: i, task } = pickTask(m, l, t);
      perform(
        m,
        r,
        (repo) => repo.removeTask(list.id, task.id),
        (s) => { listIn(s, list.id).tasks.splice(i, 1); }
      );
      return task.id;
    })
);

const split = fc.tuple(index, index, index).map(
  ([l, t, cut]) =>
    new Step(`Split(${l}, ${t}, cut ${cut})`, hasTasks(), (m, r) => {
      const { list, index: i, task } = pickTask(m, l, t);
      const at = cut % (task.text.length + 1);
      const beforeText = task.text.slice(0, at);
      const afterText = task.text.slice(at);
      const id = newId(m, "task");
      perform(
        m,
        r,
        (repo) =>
          repo.splitTask(list.id, task.id, {
            beforeText,
            afterText,
            previousText: task.text,
            newItemId: id,
            afterId: task.id,
            beforeId: list.tasks[i + 1]?.id,
          }),
        (s) => {
          const tasks = listIn(s, list.id).tasks;
          tasks[i].text = beforeText;
          tasks.splice(i + 1, 0, { id, text: afterText, done: false, note: "" });
        }
      );
      return `${task.id} into ${id}`;
    })
);

const merge = fc.tuple(index, index).map(
  ([l, t]) =>
    new Step(`Merge(${l}, ${t})`, hasTasks(2), (m, r) => {
      const { list, index: picked } = pickTask(m, l, t, 2);
      const i = Math.max(1, picked);
      const [previous, current] = [list.tasks[i - 1], list.tasks[i]];
      const mergedText = previous.text + current.text;
      perform(
        m,
        r,
        (repo) => repo.mergeTask(list.id, previous.id, current.id, { mergedText }),
        (s) => {
          const tasks = listIn(s, list.id).tasks;
          tasks[i - 1].text = mergedText;
          tasks.splice(i, 1);
        }
      );
      return `${current.id} into ${previous.id}`;
    })
);

const moveWithin = fc.tuple(index, index, index).map(
  ([l, t, to]) =>
    new Step(`MoveWithin(${l}, ${t} to ${to})`, hasTasks(2), (m, r) => {
      const { list, index: from, task } = pickTask(m, l, t, 2);
      const rest = list.tasks.filter((x) => x.id !== task.id);
      const position = to % (rest.length + 1);
      if (position === from) return;
      const afterId = rest[position - 1]?.id ?? null;
      const beforeId = rest[position]?.id ?? null;
      perform(
        m,
        r,
        (repo) => repo.moveTaskWithinList(list.id, task.id, { afterId, beforeId }),
        (s) => {
          const tasks = listIn(s, list.id).tasks;
          tasks.splice(position, 0, tasks.splice(from, 1)[0]);
        }
      );
      return `${task.id} to ${position}`;
    })
);

const hasTwoLists = (m: Readonly<Model>) => m.state.lists.length > 1 && hasTasks()(m);
const moveToList = fc.tuple(index, index, index).map(
  ([l, t, target]) =>
    new Step(`MoveToList(${l}, ${t} to ${target})`, hasTwoLists, (m, r) => {
      const { list, index: i, task } = pickTask(m, l, t);
      const destination = pick(m.state.lists.filter((x) => x.id !== list.id), target);
      const beforeId = destination.tasks[0]?.id ?? null;
      perform(
        m,
        r,
        (repo) =>
          repo.moveTask(list.id, destination.id, task.id, { snapshot: { ...task }, beforeId }),
        (s) => {
          const moved = listIn(s, list.id).tasks.splice(i, 1)[0];
          listIn(s, destination.id).tasks.unshift(moved);
        }
      );
      return `${task.id} to ${destination.id}`;
    })
);

const renameList = fc.tuple(index, text).map(
  ([l, title]) =>
    new Step(`RenameList(${l}, ${quote(title)})`, hasList, (m, r) => {
      const list = pick(m.state.lists, l);
      if (list.title === title) return;
      perform(
        m,
        r,
        (repo) => repo.renameList(list.id, title),
        (s) => { listIn(s, list.id).title = title; }
      );
      return list.id;
    })
);

const createList = text.map(
  (title) =>
    new Step(`CreateList(${quote(title)})`, (m) => m.state.lists.length < 4, (m, r) => {
      const id = newId(m, "list");
      perform(
        m,
        r,
        (repo) => repo.createList({ listId: id, title }),
        (s) => { s.lists.push({ id, title, tasks: [] }); }
      );
      return id;
    })
);

/** Undo moves the current state to the redo stack and back; redo the reverse. */
const history = (direction: "undo" | "redo") =>
  new Step(
    direction === "undo" ? "Undo" : "Redo",
    (m) => m[direction].length > 0,
    (m, r) => {
      const other = direction === "undo" ? "redo" : "undo";
      r.pending.push(r.repository[direction]());
      m[other].push(cloneState(m.state));
      m.state = m[direction].pop()!;
    }
  );

const settleStep = new Step(
  "Settle",
  () => true,
  async (m, r) => {
    await settle(r);
    assertMatches(m, r, "after settling");
  }
);

const reload = new Step(
  "Reload",
  () => true,
  async (m, r) => {
    await settle(r);
    assertMatches(m, r, "before reload");
    r.repository.dispose();
    r.repository = createRepository(await r.openStorage(), r.identity, r.now);
    await r.scheduler.waitFor(r.repository.initialize());
    // The undo history is not kept across reloads.
    m.undo = [];
    m.redo = [];
    assertMatches(m, r, "after reload");
  }
);

export const commands = [
  addTask,
  editField("text"),
  editField("note"),
  toggle,
  removeTask,
  split,
  merge,
  moveWithin,
  moveToList,
  renameList,
  createList,
  fc.constant(history("undo")),
  fc.constant(history("redo")),
  fc.constant(settleStep),
  fc.constant(reload),
];
