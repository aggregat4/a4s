// Model-based tests for ListRepository.
//
// fast-check generates random sequences of changes (add, edit, toggle,
// split, merge, move, delete, rename, undo, redo, reload...). Each change is
// applied to a plain reference model and requested from the repository
// without waiting for earlier ones, as the UI does. The real IndexedDB storage
// runs on fake-indexeddb, and fast-check's scheduler decides when each save
// starts, so different interleavings are explored. After settling, and after reloading from storage, the repository
// must match the model. A failing run is shrunk to a minimal sequence.
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
  type Model,
  type Real,
} from "../helpers/repository-model.js";

// --- Property ------------------------------------------------------------

test("the repository matches the model for any sequence of changes", async () => {
  let runs = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.commands(commands, { maxCommands: 60, size: "large" }),
      async (scheduler, cmds) => {
        const dbName = `repository-model-${runs++}`;
        const openStorage = () => openScheduledStorage(dbName, scheduler);
        const identity = createIdentityStorage();
        const now = createSpacedClock();
        const repository = createRepository(await openStorage(), identity, now);
        await scheduler.waitFor(repository.initialize());
        await scheduler.waitFor(
          repository.createList({ listId: "list-0", title: "Inbox" })
        );
        const real: Real = {
          repository,
          openStorage,
          identity,
          now,
          scheduler,
          pending: [],
        };
        // Creating the first list is an undo step like any other.
        const model: Model = {
          state: { lists: [{ id: "list-0", title: "Inbox", tasks: [] }] },
          undo: [{ lists: [] }],
          redo: [],
          nextId: 1,
        };
        await fc.asyncModelRun(() => ({ model, real }), cmds);
        await settle(real);
        assertMatches(model, real, "at the end");
        real.repository.dispose();
      }
    ),
    {
      numRuns: Number(process.env.MODEL_RUNS ?? 200),
      includeErrorInReport: true,
    }
  );
});
