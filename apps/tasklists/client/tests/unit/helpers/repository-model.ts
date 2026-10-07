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

/** Applies an undoable change to the model: one change is one undo step. */
function change(model: Model, mutate: (state: ModelState) => void) {
  model.undo.push(cloneState(model.state));
  model.redo = [];
  mutate(model.state);
}

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

function request(real: Real, operation: Promise<unknown>) {
  real.pending.push(operation);
}

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

type Cmd = fc.AsyncCommand<Model, Real>;

const text = fc.stringMatching(/^[a-z]{0,5}( [a-z]{1,4})?$/);
const index = fc.nat(50);

class AddTask implements Cmd {
  constructor(readonly list: number, readonly at: number, readonly text: string) {}
  check = (m: Readonly<Model>) => m.state.lists.length > 0;
  async run(m: Model, r: Real) {
    const list = pick(m.state.lists, this.list);
    const at = this.at % (list.tasks.length + 1);
    const id = newId(m, "task");
    const afterId = list.tasks[at - 1]?.id ?? null;
    const beforeId = list.tasks[at]?.id ?? null;
    change(m, (s) => {
      s.lists
        .find((l) => l.id === list.id)!
        .tasks.splice(at, 0, { id, text: this.text, done: false, note: "" });
    });
    request(
      r,
      r.repository.insertTask(list.id, { itemId: id, text: this.text, afterId, beforeId })
    );
  }
  toString = () => `AddTask(list ${this.list}, at ${this.at}, ${JSON.stringify(this.text)})`;
}

const hasTask = (m: Readonly<Model>) => m.state.lists.some((l) => l.tasks.length > 0);
const pickTask = (m: Model, list: number, task: number) => {
  const lists = m.state.lists.filter((l) => l.tasks.length > 0);
  const l = pick(lists, list);
  const index = task % l.tasks.length;
  return { list: l, index, task: l.tasks[index] };
};
const inModel = (m: Model, listId: string, taskId: string) =>
  m.state.lists.find((l) => l.id === listId)!.tasks.find((t) => t.id === taskId)!;

class EditText implements Cmd {
  constructor(readonly list: number, readonly task: number, readonly text: string) {}
  check = hasTask;
  async run(m: Model, r: Real) {
    const { list, task } = pickTask(m, this.list, this.task);
    if (task.text === this.text) return;
    change(m, () => {
      inModel(m, list.id, task.id).text = this.text;
    });
    request(r, r.repository.updateTask(list.id, task.id, { text: this.text }));
  }
  toString = () => `EditText(${this.list}, ${this.task}, ${JSON.stringify(this.text)})`;
}

class EditNote implements Cmd {
  constructor(readonly list: number, readonly task: number, readonly note: string) {}
  check = hasTask;
  async run(m: Model, r: Real) {
    const { list, task } = pickTask(m, this.list, this.task);
    if (task.note === this.note) return;
    change(m, () => {
      inModel(m, list.id, task.id).note = this.note;
    });
    request(r, r.repository.updateTask(list.id, task.id, { note: this.note }));
  }
  toString = () => `EditNote(${this.list}, ${this.task}, ${JSON.stringify(this.note)})`;
}

class Toggle implements Cmd {
  constructor(readonly list: number, readonly task: number) {}
  check = hasTask;
  async run(m: Model, r: Real) {
    const { list, task } = pickTask(m, this.list, this.task);
    const done = !task.done;
    change(m, () => {
      inModel(m, list.id, task.id).done = done;
    });
    request(r, r.repository.toggleTask(list.id, task.id, done));
  }
  toString = () => `Toggle(${this.list}, ${this.task})`;
}

class RemoveTask implements Cmd {
  constructor(readonly list: number, readonly task: number) {}
  check = hasTask;
  async run(m: Model, r: Real) {
    const { list, task } = pickTask(m, this.list, this.task);
    change(m, (s) => {
      const l = s.lists.find((x) => x.id === list.id)!;
      l.tasks = l.tasks.filter((t) => t.id !== task.id);
    });
    request(r, r.repository.removeTask(list.id, task.id));
  }
  toString = () => `RemoveTask(${this.list}, ${this.task})`;
}

class Split implements Cmd {
  constructor(readonly list: number, readonly task: number, readonly cut: number) {}
  check = hasTask;
  async run(m: Model, r: Real) {
    const { list, index, task } = pickTask(m, this.list, this.task);
    // Read before the model changes: `task` is the model's own object.
    const previousText = task.text;
    const cut = this.cut % (previousText.length + 1);
    const beforeText = previousText.slice(0, cut);
    const afterText = previousText.slice(cut);
    const id = newId(m, "task");
    const nextId = list.tasks[index + 1]?.id;
    change(m, (s) => {
      const l = s.lists.find((x) => x.id === list.id)!;
      l.tasks[index].text = beforeText;
      l.tasks.splice(index + 1, 0, { id, text: afterText, done: false, note: "" });
    });
    request(
      r,
      r.repository.splitTask(list.id, task.id, {
        beforeText,
        afterText,
        previousText,
        newItemId: id,
        afterId: task.id,
        beforeId: nextId,
      })
    );
  }
  toString = () => `Split(${this.list}, ${this.task}, cut ${this.cut})`;
}

class Merge implements Cmd {
  constructor(readonly list: number, readonly task: number) {}
  check = (m: Readonly<Model>) => m.state.lists.some((l) => l.tasks.length > 1);
  async run(m: Model, r: Real) {
    const lists = m.state.lists.filter((l) => l.tasks.length > 1);
    const list = pick(lists, this.list);
    const index = 1 + (this.task % (list.tasks.length - 1));
    const previous = list.tasks[index - 1];
    const current = list.tasks[index];
    const mergedText = previous.text + current.text;
    change(m, (s) => {
      const l = s.lists.find((x) => x.id === list.id)!;
      l.tasks[index - 1].text = mergedText;
      l.tasks.splice(index, 1);
    });
    request(
      r,
      r.repository.mergeTask(list.id, previous.id, current.id, { mergedText })
    );
  }
  toString = () => `Merge(${this.list}, ${this.task})`;
}

class MoveWithin implements Cmd {
  constructor(readonly list: number, readonly from: number, readonly to: number) {}
  check = (m: Readonly<Model>) => m.state.lists.some((l) => l.tasks.length > 1);
  async run(m: Model, r: Real) {
    const lists = m.state.lists.filter((l) => l.tasks.length > 1);
    const list = pick(lists, this.list);
    const from = this.from % list.tasks.length;
    const rest = list.tasks.filter((_, i) => i !== from);
    const to = this.to % (rest.length + 1);
    if (to === from) return;
    const task = list.tasks[from];
    const afterId = rest[to - 1]?.id ?? null;
    const beforeId = rest[to]?.id ?? null;
    change(m, (s) => {
      const l = s.lists.find((x) => x.id === list.id)!;
      const moved = l.tasks.splice(from, 1)[0];
      l.tasks.splice(to, 0, moved);
    });
    request(
      r,
      r.repository.moveTaskWithinList(list.id, task.id, { afterId, beforeId })
    );
  }
  toString = () => `MoveWithin(${this.list}, ${this.from} -> ${this.to})`;
}

class MoveToList implements Cmd {
  constructor(readonly list: number, readonly task: number, readonly target: number) {}
  check = (m: Readonly<Model>) => m.state.lists.length > 1 && hasTask(m);
  async run(m: Model, r: Real) {
    const { list, task } = pickTask(m, this.list, this.task);
    const targets = m.state.lists.filter((l) => l.id !== list.id);
    const target = pick(targets, this.target);
    const beforeId = target.tasks[0]?.id ?? null;
    const moved = { ...task };
    change(m, (s) => {
      const source = s.lists.find((x) => x.id === list.id)!;
      const destination = s.lists.find((x) => x.id === target.id)!;
      source.tasks = source.tasks.filter((t) => t.id !== task.id);
      destination.tasks.unshift({ ...moved });
    });
    request(
      r,
      r.repository.moveTask(list.id, target.id, task.id, {
        snapshot: moved,
        beforeId,
      })
    );
  }
  toString = () => `MoveToList(${this.list}, ${this.task} -> ${this.target})`;
}

class RenameList implements Cmd {
  constructor(readonly list: number, readonly title: string) {}
  check = (m: Readonly<Model>) => m.state.lists.length > 0;
  async run(m: Model, r: Real) {
    const list = pick(m.state.lists, this.list);
    if (list.title === this.title) return;
    change(m, (s) => {
      s.lists.find((x) => x.id === list.id)!.title = this.title;
    });
    request(r, r.repository.renameList(list.id, this.title));
  }
  toString = () => `RenameList(${this.list}, ${JSON.stringify(this.title)})`;
}

class CreateList implements Cmd {
  constructor(readonly title: string) {}
  check = (m: Readonly<Model>) => m.state.lists.length < 4;
  async run(m: Model, r: Real) {
    const id = newId(m, "list");
    change(m, (s) => {
      s.lists.push({ id, title: this.title, tasks: [] });
    });
    request(r, r.repository.createList({ listId: id, title: this.title }));
  }
  toString = () => `CreateList(${JSON.stringify(this.title)})`;
}

class Undo implements Cmd {
  check = (m: Readonly<Model>) => m.undo.length > 0;
  async run(m: Model, r: Real) {
    m.redo.push(cloneState(m.state));
    m.state = m.undo.pop()!;
    request(r, r.repository.undo());
  }
  toString = () => "Undo";
}

class Redo implements Cmd {
  check = (m: Readonly<Model>) => m.redo.length > 0;
  async run(m: Model, r: Real) {
    m.undo.push(cloneState(m.state));
    m.state = m.redo.pop()!;
    request(r, r.repository.redo());
  }
  toString = () => "Redo";
}

class Settle implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    await settle(r);
    assertMatches(m, r, "after settling");
  }
  toString = () => "Settle";
}

class Reload implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
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
  toString = () => "Reload";
}

export const commands = [
  fc.tuple(index, index, text).map(([l, a, t]) => new AddTask(l, a, t)),
  fc.tuple(index, index, text).map(([l, a, t]) => new EditText(l, a, t)),
  fc.tuple(index, index, text).map(([l, a, t]) => new EditNote(l, a, t)),
  fc.tuple(index, index).map(([l, a]) => new Toggle(l, a)),
  fc.tuple(index, index).map(([l, a]) => new RemoveTask(l, a)),
  fc.tuple(index, index, index).map(([l, a, c]) => new Split(l, a, c)),
  fc.tuple(index, index).map(([l, a]) => new Merge(l, a)),
  fc.tuple(index, index, index).map(([l, a, b]) => new MoveWithin(l, a, b)),
  fc.tuple(index, index, index).map(([l, a, b]) => new MoveToList(l, a, b)),
  fc.tuple(index, text).map(([l, t]) => new RenameList(l, t)),
  text.map((t) => new CreateList(t)),
  fc.constant(new Undo()),
  fc.constant(new Redo()),
  fc.constant(new Settle()),
  fc.constant(new Reload()),
];

