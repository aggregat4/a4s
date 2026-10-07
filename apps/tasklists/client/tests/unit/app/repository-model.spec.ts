// Model-based tests for ListRepository.
//
// Two devices share lists and exchange their changes as sync does. fast-check
// generates random sequences of changes on either device (add, edit text and
// notes, toggle, delete, split, merge, move tasks, create, rename, delete and
// reorder lists, undo, redo), deliveries between the devices, and reloads.
// Each change is applied to a plain reference model and requested from the
// device's real ListRepository without waiting for earlier ones, as the UI
// does. The real IndexedDB storage runs on fake-indexeddb, and fast-check's
// scheduler decides when each save starts, so different interleavings are
// explored. After settling, both devices must show the same lists and match
// the model. A failing run is shrunk to a minimal sequence.
import test from "node:test";
import * as fc from "fast-check";
import { openScheduledStorage } from "../helpers/scheduled-storage.js";
import {
  assertMatches,
  commands,
  createIdentityStorage,
  createRepository,
  createSpacedClock,
  settle,
  type Device,
  type DeviceReal,
  type Model,
  type Real,
} from "../helpers/repository-model.js";

test("devices match the model for any sequence of changes", async () => {
  let runs = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.commands(commands, { maxCommands: 60, size: "large" }),
      async (scheduler, cmds) => {
        const run = runs++;
        const now = createSpacedClock();
        const openDevice = async (device: Device): Promise<DeviceReal> => {
          const openStorage = () =>
            openScheduledStorage(`repository-model-${run}-${device}`, scheduler);
          const storage = await openStorage();
          const identity = createIdentityStorage();
          const repository = createRepository(storage, identity, now);
          await scheduler.waitFor(repository.initialize());
          return { repository, storage, openStorage, identity, delivered: 0 };
        };
        const real: Real = {
          devices: { a: await openDevice("a"), b: await openDevice("b") },
          now,
          scheduler,
          pending: [],
        };
        // Device a creates the first list, an undo step like any other.
        real.pending.push(
          real.devices.a.repository.createList({ listId: "list-0", title: "Inbox" })
        );
        await settle(real);
        const model: Model = {
          state: { lists: [{ id: "list-0", owner: "a", title: "Inbox", tasks: [] }] },
          undo: { a: [[]], b: [] },
          redo: { a: [], b: [] },
          nextId: 1,
        };
        await fc.asyncModelRun(() => ({ model, real }), cmds);
        await settle(real);
        assertMatches(model, real, "at the end");
        real.devices.a.repository.dispose();
        real.devices.b.repository.dispose();
      }
    ),
    {
      numRuns: Number(process.env.MODEL_RUNS ?? 200),
      includeErrorInReport: true,
    }
  );
});
