import test from "node:test";
import assert from "node:assert/strict";
import { ListState } from "../../../src/ui/state/list-state.js";
import type { ListRepository } from "../../../src/app/list-repository.js";
import type { TaskItem, TaskListState } from "../../../src/types/domain.js";

const task = (id: string, text = id): TaskItem => ({ id, text, done: false, note: "" });

/** A repository holding one list, whose snapshots the test sends. */
function fakeRepository(items: TaskItem[]) {
  let state: TaskListState = { title: "List", items };
  let listener: ((state: TaskListState) => void) | null = null;
  const saves: Array<{ note: string }> = [];
  const repository = {
    isInitialized: () => true,
    initialize: async () => [],
    getListState: () => state,
    subscribeList: (_listId: string, handler: (state: TaskListState) => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    updateTask: async (_listId: string, _itemId: string, payload: { note: string }) => {
      saves.push(payload);
    },
  };
  return {
    repository: repository as unknown as ListRepository,
    saves,
    /** The repository saves or receives a change and reports it. */
    report(items: TaskItem[]) {
      state = { title: "List", items };
      listener?.(state);
    },
  };
}

/** A save the test settles. */
function pendingSave() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const ids = (list: ListState) => list.shown.items.map((item) => item.id);

function connected(items: TaskItem[]) {
  const repo = fakeRepository(items);
  const list = new ListState(() => "", () => {});
  list.connect(repo.repository, "list-1");
  return { repo, list };
}

test("a change stays on top of snapshots taken before it was saved", async () => {
  const { repo, list } = connected([task("a")]);
  const save = pendingSave();
  list.change(
    [{ type: "insert", item: task("new"), afterId: null, beforeId: "a" }],
    save.promise
  );
  assert.deepEqual(ids(list), ["new", "a"]);

  repo.report([task("a")]);
  assert.deepEqual(ids(list), ["new", "a"]);

  repo.report([task("new"), task("a")]);
  save.resolve();
  await settled();
  assert.deepEqual(ids(list), ["new", "a"]);
});

test("a change from another device shows while the user's change is unsaved", () => {
  const { repo, list } = connected([task("a")]);
  list.change(
    [{ type: "update", id: "a", fields: { text: "typed" } }],
    pendingSave().promise
  );

  repo.report([task("remote"), task("a")]);
  assert.deepEqual(
    list.shown.items.map((item) => item.text),
    ["remote", "typed"]
  );
});

test("a change whose save fails is undone and the failure shown", async () => {
  const { list } = connected([task("a")]);
  const save = pendingSave();
  list.change([{ type: "remove", id: "a" }], save.promise);
  assert.deepEqual(ids(list), []);

  save.reject(new Error("offline"));
  await settled();
  assert.deepEqual(ids(list), ["a"]);
  assert.deepEqual(list.shown.headerError, { message: "offline" });

  list.dismissError();
  assert.equal(list.shown.headerError, null);
});

test("without a repository a change is final", () => {
  const list = new ListState(() => "Title", () => {});
  assert.equal(list.save(() => Promise.resolve()), null);
  list.change([{ type: "insert", item: task("a"), afterId: null, beforeId: null }], null);
  assert.deepEqual(ids(list), ["a"]);
  assert.equal(list.shown.title, "Title");
});

test("a note being typed shows, and is saved once committed if it changed", async () => {
  const { repo, list } = connected([task("a")]);
  list.draftNote("a", "draft");
  assert.equal(list.shown.items[0].note, "draft");
  assert.deepEqual(repo.saves, []);

  list.commitNote("a", "");
  await settled();
  assert.deepEqual(repo.saves, []);

  list.commitNote("a", "final");
  await settled();
  assert.deepEqual(repo.saves, [{ note: "final" }]);
});

test("every change of what is shown is reported", () => {
  const repo = fakeRepository([task("a")]);
  let reports = 0;
  const list = new ListState(() => "", () => (reports += 1));
  list.connect(repo.repository, "list-1");
  const afterConnect = reports;
  repo.report([task("b")]);
  list.change([{ type: "remove", id: "b" }], null);
  assert.equal(reports, afterConnect + 2);
});
