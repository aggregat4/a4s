import test from "node:test";
import assert from "node:assert/strict";
import { ListsState, applyListsChange } from "../../../src/ui/state/lists-state.js";
import type { ListEntry } from "../../../src/ui/state/lists-state.js";
import type { ListRepository } from "../../../src/app/list-repository.js";

/** A repository whose lists the test reports, and whose saves it settles. */
function fakeRepository(lists: ListEntry[]) {
  let current = lists;
  let listener: (() => void) | null = null;
  const repository = {
    initialize: async () => [],
    getRegistrySnapshot: () => current.map(({ id }) => ({ id, title: "" })),
    getListState: (id: string) => ({
      title: current.find((list) => list.id === id)?.title ?? "",
      items: [],
    }),
    subscribeRegistry: (handler: () => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    reorderList: () => new Promise(() => {}),
    removeList: () => new Promise(() => {}),
  };
  return {
    repository: repository as unknown as ListRepository,
    /** The repository saves or receives a change and reports its lists. */
    report(next: ListEntry[]) {
      current = next;
      listener?.();
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
const lists = (...titles: string[]) => titles.map((title, i) => ({ id: `list-${i}`, title }));
const titles = (state: ListsState) => state.shown.map((list) => list.title);

async function connected(entries: ListEntry[]) {
  const repo = fakeRepository(entries);
  const state = new ListsState(() => {});
  await state.connect(repo.repository);
  return { repo, state };
}

test("a rename stays on top of the lists reported before it was saved", async () => {
  const { repo, state } = await connected(lists("Inbox", "Work"));
  const first = pendingSave();
  const second = pendingSave();
  state.rename("list-0", "G", first.promise);
  state.rename("list-0", "Gr", second.promise);

  // The first save lands; the repository reports its title, not the second's.
  repo.report(lists("G", "Work"));
  first.resolve();
  await settled();
  assert.deepEqual(titles(state), ["Gr", "Work"]);

  repo.report(lists("Gr", "Work"));
  second.resolve();
  await settled();
  assert.deepEqual(titles(state), ["Gr", "Work"]);
});

test("a move stays on top of lists reported before it was saved", async () => {
  const { repo, state } = await connected(lists("Inbox", "Work", "Home"));
  state.move("list-2", null, "list-0");
  assert.deepEqual(titles(state), ["Home", "Inbox", "Work"]);

  // A change saved before the move: the repository still has the old order.
  repo.report(lists("Inbox", "Work", "Home"));
  assert.deepEqual(titles(state), ["Home", "Inbox", "Work"]);
});

test("a rename whose save fails is dropped", async () => {
  const { state } = await connected(lists("Inbox"));
  const save = pendingSave();
  state.rename("list-0", "Renamed", save.promise);
  assert.deepEqual(titles(state), ["Renamed"]);
  save.reject(new Error("offline"));
  await settled();
  assert.deepEqual(titles(state), ["Inbox"]);
});

test("applying a change again changes nothing more", () => {
  const changes = [
    { type: "move" as const, id: "list-2", afterId: null, beforeId: "list-0" },
    { type: "rename" as const, id: "list-0", title: "Renamed" },
    { type: "remove" as const, id: "list-1" },
  ];
  const once = changes.reduce(applyListsChange, lists("Inbox", "Work", "Home"));
  assert.deepEqual(changes.reduce(applyListsChange, once), once);
});
