import test from "node:test";
import assert from "node:assert/strict";
import { Outbox } from "../../../src/app/outbox.js";
import type { ListStorage } from "../../../src/types/storage.js";
import type { SyncOp } from "../../../src/types/sync.js";

/** Storage whose outbox reads and writes wait until the test releases them. */
function slowStorage(stored: SyncOp[]) {
  let outbox = stored;
  const waiting: Array<() => void> = [];
  const later = <T>(value: () => T) =>
    new Promise<T>((resolve) => waiting.push(() => resolve(value())));
  const storage = {
    loadOutbox: () => later(() => outbox.slice()),
    persistOutbox: (ops: SyncOp[]) =>
      later(() => {
        outbox = ops.slice();
      }),
  } as unknown as ListStorage;
  return {
    storage,
    stored: () => outbox.map((op) => op.clock),
    /** Lets every waiting read and write finish, in the order they were made. */
    async release() {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const next = waiting.shift();
        if (!next) return;
        next();
      }
    },
  };
}

const op = (clock: number) =>
  ({ scope: "list", resourceId: "list-1", actor: "actor-1", clock, payload: {} }) as SyncOp;
const local = (clock: number) => [{ type: "insert", actor: "actor-1", clock } as never];

test("operations added while the outbox loads are kept after the stored ones", async () => {
  const slow = slowStorage([op(1)]);
  const outbox = new Outbox(slow.storage);
  void outbox.load();
  const saved = outbox.add("list", "list-1", local(2));
  await slow.release();
  await saved;
  assert.deepEqual(slow.stored(), [1, 2]);
  assert.deepEqual(outbox.pending().map((entry) => entry.clock), [1, 2]);
});

test("the stored outbox ends up as the outbox, however its saves interleave", async () => {
  const slow = slowStorage([]);
  const outbox = new Outbox(slow.storage);
  void outbox.load();
  await slow.release();
  void outbox.add("list", "list-1", local(1));
  void outbox.add("list", "list-1", local(2));
  const sent = outbox.pending();
  void outbox.add("list", "list-1", local(3));
  const done = outbox.confirm(sent);
  await slow.release();
  await done;
  assert.deepEqual(slow.stored(), [3]);
});
