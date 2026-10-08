import assert from "node:assert/strict";
import * as fc from "fast-check";
import { ListRepository } from "../../../src/app/list-repository.js";
import type { TaskItem } from "../../../src/types/domain.js";
import type { ListStorage } from "../../../src/types/storage.js";

// --- Model ---------------------------------------------------------------
//
// Two devices, a and b, share one set of lists. Each device changes only the
// lists it created, so each device's undo reverts its own last change and
// leaves the other device's lists as they are.

export type Device = "a" | "b";
const DEVICES: Device[] = ["a", "b"];

type ModelTask = { id: string; text: string; done: boolean; note: string };
type ModelList = { id: string; owner: Device; title: string; tasks: ModelTask[] };
type ModelState = { lists: ModelList[] };
/** One undo step: the device's own lists as they were before a change. */
type OwnLists = ModelList[];
export type Model = {
  state: ModelState;
  undo: Record<Device, OwnLists[]>;
  redo: Record<Device, OwnLists[]>;
  nextId: number;
  /** The time, in ms, as on the shared clock. */
  time: number;
  /**
   * The task a device last edited the text of, and when, as long as the
   * device did nothing else since. Typing into it merges into that undo step.
   */
  typing: Record<Device, { taskId: string; at: number } | null>;
};

/** Text edits this close together, within a word, merge into one undo step. */
const MERGE_WINDOW_MS = 1000;
const WORD_BOUNDARY = /[\s.,;:!?]/;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const ownLists = (state: ModelState, device: Device) =>
  state.lists.filter((list) => list.owner === device);
const restoreOwnLists = (state: ModelState, device: Device, lists: OwnLists) => {
  state.lists = state.lists.filter((list) => list.owner !== device).concat(clone(lists));
};

const newId = (model: Model, prefix: string) => `${prefix}-${model.nextId++}`;

// Picks an element by a random number, so commands stay valid as the model
// changes while shrinking.
const pick = <T>(items: T[], n: number) => items[n % items.length];

// --- Real system ---------------------------------------------------------

export type DeviceReal = {
  repository: ListRepository;
  storage: ListStorage;
  /** Opens a new connection to the device's storage, as a page load does. */
  openStorage: () => Promise<ListStorage>;
  identity: Storage;
  /** How many entries of the device's outbox were delivered to the other. */
  delivered: number;
};

export type Real = {
  devices: Record<Device, DeviceReal>;
  clock: Clock;
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

/** A clock the steps move forward; the repository reads it to merge edits. */
type Clock = { time: number; now: () => number };
export function createClock(start: number): Clock {
  const clock: Clock = { time: start, now: () => clock.time };
  return clock;
}

/** Moves the shared clock and the model's time forward together. */
function wait(m: Model, r: Real, ms: number) {
  m.time += ms;
  r.clock.time = m.time;
}

// Ordinary changes are this far apart, so they never merge.
const PAUSE_MS = 10_000;

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

/**
 * Delivers what each device has saved to its outbox so far to the other
 * device, as sync does. Returns whether anything was delivered.
 */
async function exchange(real: Real) {
  let delivered = false;
  for (const from of DEVICES) {
    const sender = real.devices[from];
    const receiver = real.devices[from === "a" ? "b" : "a"];
    const outbox = await sender.storage.loadOutbox();
    const fresh = outbox.slice(sender.delivered);
    sender.delivered = outbox.length;
    if (fresh.length) {
      delivered = true;
      real.pending.push(receiver.repository.applyRemoteOps(fresh));
    }
  }
  return delivered;
}

/** Lets every requested change, its saves and its delivery complete. */
export async function settle(real: Real) {
  do {
    while (real.pending.length) {
      const pending = real.pending.splice(0);
      await real.scheduler.waitFor(Promise.all(pending));
    }
    await real.scheduler.waitIdle();
  } while (await exchange(real));
}

function snapshot(repository: ListRepository) {
  return repository.getRegistrySnapshot().map((entry) => {
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
  });
}

/**
 * Both devices show the same lists, in the same order; each device's lists
 * match the model; and each device can undo and redo as the model says. The
 * order of one device's lists relative to the other's is up to the CRDT.
 */
export function assertMatches(model: Model, real: Real, when: string) {
  const [a, b] = DEVICES.map((device) => snapshot(real.devices[device].repository));
  assert.deepStrictEqual(b, a, `${when}: devices agree`);
  const owner = new Map(model.state.lists.map((list) => [list.id, list.owner]));
  assert.deepStrictEqual(
    a.map((list) => list.id).sort(),
    [...owner.keys()].sort(),
    `${when}: lists`
  );
  for (const device of DEVICES) {
    const shown = a
      .filter((list) => owner.get(list.id) === device)
      .map((list) => ({ id: list.id, owner: device, title: list.title, tasks: list.tasks }));
    assert.deepStrictEqual(shown, ownLists(model.state, device), `${when}: ${device}'s lists`);
    const { repository } = real.devices[device];
    assert.equal(repository.canUndo(), model.undo[device].length > 0, `${when}: ${device} canUndo`);
    assert.equal(repository.canRedo(), model.redo[device].length > 0, `${when}: ${device} canRedo`);
  }
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
 * Requests a change from the device's repository and makes the same change
 * to the model, as one undo step of that device. The request is made first,
 * so its arguments are read before the model changes.
 */
function perform(
  m: Model,
  r: Real,
  device: Device,
  request: (repository: ListRepository) => Promise<unknown>,
  mutate: (state: ModelState) => void
) {
  wait(m, r, PAUSE_MS);
  r.pending.push(request(r.devices[device].repository));
  m.undo[device].push(clone(ownLists(m.state, device)));
  m.redo[device] = [];
  m.typing[device] = null;
  mutate(m.state);
}

const listIn = (state: ModelState, listId: string) =>
  state.lists.find((list) => list.id === listId)!;

const hasLists =
  (count = 1) =>
  (device: Device) =>
  (m: Readonly<Model>) =>
    ownLists(m.state, device).length >= count;
const hasTasks =
  (count = 1) =>
  (device: Device) =>
  (m: Readonly<Model>) =>
    ownLists(m.state, device).some((list) => list.tasks.length >= count);

/** A task in one of the device's lists that have at least `minTasks` tasks. */
function pickTask(m: Model, device: Device, list: number, task: number, minTasks = 1) {
  const l = pick(
    ownLists(m.state, device).filter((x) => x.tasks.length >= minTasks),
    list
  );
  const index = task % l.tasks.length;
  return { list: l, index, task: l.tasks[index] };
}

const quote = (value: string) => JSON.stringify(value);
const text = fc.stringMatching(/^[a-z]{0,5}( [a-z]{1,4})?$/);
const index = fc.nat(50);
const device = fc.constantFrom<Device>(...DEVICES);

const addTask = fc.tuple(device, index, index, text).map(
  ([d, l, at, value]) =>
    new Step(`${d}: AddTask(${l}, at ${at}, ${quote(value)})`, hasLists()(d), (m, r) => {
      const list = pick(ownLists(m.state, d), l);
      const position = at % (list.tasks.length + 1);
      const id = newId(m, "task");
      const afterId = list.tasks[position - 1]?.id ?? null;
      const beforeId = list.tasks[position]?.id ?? null;
      const task = { id, text: value, done: false, note: "" };
      perform(
        m,
        r,
        d,
        (repo) => repo.insertTask(list.id, { itemId: id, text: value, afterId, beforeId }),
        (s) => { listIn(s, list.id).tasks.splice(position, 0, task); }
      );
      return `${id} in ${list.id}`;
    })
);

const editField = (field: "text" | "note") =>
  fc.tuple(device, index, index, text).map(
    ([d, l, t, value]) =>
      new Step(`${d}: Edit ${field}(${l}, ${t}, ${quote(value)})`, hasTasks()(d), (m, r) => {
        const { list, index: i, task } = pickTask(m, d, l, t);
        if (task[field] === value) return;
        perform(
          m,
          r,
          d,
          (repo) => repo.updateTask(list.id, task.id, { [field]: value }),
          (s) => { listIn(s, list.id).tasks[i][field] = value; }
        );
        // Replacing the text is its own undo step, but typing right after it
        // continues that step.
        if (field === "text") m.typing[d] = { taskId: task.id, at: m.time };
        return task.id;
      })
  );

/**
 * Types a burst of keys at the end of a task's text: letters, a space, a
 * period, or Backspace, each after a delay. A key merges into the previous
 * undo step if that step edited the same task's text at most a second
 * earlier and the key does not add or remove a space or punctuation.
 */
const keystroke = fc.record({
  key: fc.constantFrom("a", "b", " ", ".", "Backspace"),
  delay: fc.constantFrom(100, 999, 1000, 1001, 5000),
});
const describeKeys = (keys: Array<{ key: string; delay: number }>) =>
  keys.map(({ key, delay }) => `${key === " " ? "Space" : key}+${delay}`).join(" ");

const type = fc
  .tuple(device, index, index, fc.array(keystroke, { minLength: 2, maxLength: 8 }))
  .map(
    ([d, l, t, keys]) =>
      new Step(`${d}: Type(${l}, ${t}, ${describeKeys(keys)})`, hasTasks()(d), (m, r) => {
        const { list, index: i, task } = pickTask(m, d, l, t);
        let merged = 0;
        for (const { key, delay } of keys) {
          const text = listIn(m.state, list.id).tasks[i].text;
          if (key === "Backspace" && !text.length) continue;
          const changed = key === "Backspace" ? text.slice(-1) : key;
          const value = key === "Backspace" ? text.slice(0, -1) : text + key;
          wait(m, r, delay);
          const last = m.typing[d];
          const merges =
            last?.taskId === task.id &&
            m.time - last.at <= MERGE_WINDOW_MS &&
            !WORD_BOUNDARY.test(changed);
          r.pending.push(r.devices[d].repository.updateTask(list.id, task.id, { text: value }));
          if (merges) merged += 1;
          else m.undo[d].push(clone(ownLists(m.state, d)));
          m.redo[d] = [];
          listIn(m.state, list.id).tasks[i].text = value;
          m.typing[d] = { taskId: task.id, at: m.time };
        }
        return `${task.id}, ${merged} merged`;
      })
  );

const toggle = fc.tuple(device, index, index).map(
  ([d, l, t]) =>
    new Step(`${d}: Toggle(${l}, ${t})`, hasTasks()(d), (m, r) => {
      const { list, index: i, task } = pickTask(m, d, l, t);
      const done = !task.done;
      perform(
        m,
        r,
        d,
        (repo) => repo.toggleTask(list.id, task.id, done),
        (s) => { listIn(s, list.id).tasks[i].done = done; }
      );
      return task.id;
    })
);

const removeTask = fc.tuple(device, index, index).map(
  ([d, l, t]) =>
    new Step(`${d}: RemoveTask(${l}, ${t})`, hasTasks()(d), (m, r) => {
      const { list, index: i, task } = pickTask(m, d, l, t);
      perform(
        m,
        r,
        d,
        (repo) => repo.removeTask(list.id, task.id),
        (s) => { listIn(s, list.id).tasks.splice(i, 1); }
      );
      return task.id;
    })
);

const split = fc.tuple(device, index, index, index).map(
  ([d, l, t, cut]) =>
    new Step(`${d}: Split(${l}, ${t}, cut ${cut})`, hasTasks()(d), (m, r) => {
      const { list, index: i, task } = pickTask(m, d, l, t);
      const at = cut % (task.text.length + 1);
      const beforeText = task.text.slice(0, at);
      const afterText = task.text.slice(at);
      const id = newId(m, "task");
      perform(
        m,
        r,
        d,
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

const merge = fc.tuple(device, index, index).map(
  ([d, l, t]) =>
    new Step(`${d}: Merge(${l}, ${t})`, hasTasks(2)(d), (m, r) => {
      const { list, index: picked } = pickTask(m, d, l, t, 2);
      const i = Math.max(1, picked);
      const [previous, current] = [list.tasks[i - 1], list.tasks[i]];
      const mergedText = previous.text + current.text;
      perform(
        m,
        r,
        d,
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

const moveWithin = fc.tuple(device, index, index, index).map(
  ([d, l, t, to]) =>
    new Step(`${d}: MoveWithin(${l}, ${t} to ${to})`, hasTasks(2)(d), (m, r) => {
      const { list, index: from, task } = pickTask(m, d, l, t, 2);
      const rest = list.tasks.filter((x) => x.id !== task.id);
      const position = to % (rest.length + 1);
      if (position === from) return;
      const afterId = rest[position - 1]?.id ?? null;
      const beforeId = rest[position]?.id ?? null;
      perform(
        m,
        r,
        d,
        (repo) => repo.moveTaskWithinList(list.id, task.id, { afterId, beforeId }),
        (s) => {
          const tasks = listIn(s, list.id).tasks;
          tasks.splice(position, 0, tasks.splice(from, 1)[0]);
        }
      );
      return `${task.id} to ${position}`;
    })
);

const canMoveToList = (d: Device) => (m: Readonly<Model>) =>
  hasLists(2)(d)(m) && hasTasks()(d)(m);
const moveToList = fc.tuple(device, index, index, index).map(
  ([d, l, t, target]) =>
    new Step(`${d}: MoveToList(${l}, ${t} to ${target})`, canMoveToList(d), (m, r) => {
      const { list, index: i, task } = pickTask(m, d, l, t);
      const destination = pick(
        ownLists(m.state, d).filter((x) => x.id !== list.id),
        target
      );
      const beforeId = destination.tasks[0]?.id ?? null;
      perform(
        m,
        r,
        d,
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

const removeList = fc.tuple(device, index).map(
  ([d, l]) =>
    new Step(`${d}: RemoveList(${l})`, hasLists()(d), (m, r) => {
      const list = pick(ownLists(m.state, d), l);
      perform(
        m,
        r,
        d,
        (repo) => repo.removeList(list.id),
        (s) => { s.lists = s.lists.filter((x) => x.id !== list.id); }
      );
      return list.id;
    })
);

// Reorders among the device's own lists; where the other device's lists end
// up in between is up to the CRDT.
const moveList = fc.tuple(device, index, index).map(
  ([d, l, to]) =>
    new Step(`${d}: MoveList(${l} to ${to})`, hasLists(2)(d), (m, r) => {
      const own = ownLists(m.state, d);
      const from = l % own.length;
      const list = own[from];
      const rest = own.filter((x) => x.id !== list.id);
      const position = to % (rest.length + 1);
      if (position === from) return;
      const afterId = rest[position - 1]?.id ?? null;
      const beforeId = rest[position]?.id ?? null;
      perform(
        m,
        r,
        d,
        (repo) => repo.reorderList(list.id, { afterId, beforeId }),
        (s) => {
          restoreOwnLists(s, d, [...rest.slice(0, position), list, ...rest.slice(position)]);
        }
      );
      return `${list.id} to ${position}`;
    })
);

const renameList = fc.tuple(device, index, text).map(
  ([d, l, title]) =>
    new Step(`${d}: RenameList(${l}, ${quote(title)})`, hasLists()(d), (m, r) => {
      const list = pick(ownLists(m.state, d), l);
      if (list.title === title) return;
      perform(
        m,
        r,
        d,
        (repo) => repo.renameList(list.id, title),
        (s) => { listIn(s, list.id).title = title; }
      );
      return list.id;
    })
);

const createList = fc.tuple(device, text).map(
  ([d, title]) =>
    new Step(`${d}: CreateList(${quote(title)})`, (m) => m.state.lists.length < 6, (m, r) => {
      const id = newId(m, "list");
      perform(
        m,
        r,
        d,
        (repo) => repo.createList({ listId: id, title }),
        (s) => { s.lists.push({ id, owner: d, title, tasks: [] }); }
      );
      return id;
    })
);

/** Undo puts the device's own lists back as they were; redo the reverse. */
const history = (direction: "undo" | "redo") =>
  device.map(
    (d) =>
      new Step(
        `${d}: ${direction === "undo" ? "Undo" : "Redo"}`,
        (m) => m[direction][d].length > 0,
        (m, r) => {
          const other = direction === "undo" ? "redo" : "undo";
          wait(m, r, PAUSE_MS);
          m.typing[d] = null;
          r.pending.push(r.devices[d].repository[direction]());
          m[other][d].push(clone(ownLists(m.state, d)));
          restoreOwnLists(m.state, d, m[direction][d].pop()!);
        }
      )
  );

// Delivers what has been saved so far, while other changes may be in flight.
const exchangeStep = new Step(
  "Exchange",
  () => true,
  async (_m, r) => {
    await exchange(r);
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

const reload = device.map(
  (d) =>
    new Step(`${d}: Reload`, () => true, async (m, r) => {
      await settle(r);
      assertMatches(m, r, "before reload");
      const real = r.devices[d];
      real.repository.dispose();
      real.storage = await real.openStorage();
      real.repository = createRepository(real.storage, real.identity, r.clock.now);
      await r.scheduler.waitFor(real.repository.initialize());
      // The undo history is not kept across reloads.
      m.undo[d] = [];
      m.redo[d] = [];
      m.typing[d] = null;
      assertMatches(m, r, "after reload");
    })
);

// fast-check picks each entry equally often, so typing and undo, where
// merging is decided and observed, are listed more than once.
export const commands = [
  addTask,
  editField("text"),
  editField("note"),
  type,
  type,
  type,
  toggle,
  removeTask,
  split,
  merge,
  moveWithin,
  moveToList,
  renameList,
  createList,
  removeList,
  moveList,
  history("undo"),
  history("undo"),
  history("redo"),
  fc.constant(exchangeStep),
  fc.constant(settleStep),
  reload,
];
