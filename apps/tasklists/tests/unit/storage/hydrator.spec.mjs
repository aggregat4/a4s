import test from "node:test";
import assert from "node:assert/strict";
import { createListStorage } from "../../../lib/storage/list-storage.js";
import { seedDefaultsIfEmpty, hydrateFromStorage } from "../../../lib/storage/hydrator.js";
import { ListIndexCRDT } from "../../../lib/crdt/list-index.js";
import { ListCRDT } from "../../../lib/crdt/list-crdt.js";

test("hydrator seeds defaults and hydrates stored lists", async () => {
    const storage = await createListStorage({ forceFallback: true });
    await storage.clear();

    const index = new ListIndexCRDT({ actorId: "seed-index" });
    const seeded = await seedDefaultsIfEmpty({
        storage,
        listIndexCrdt: index,
        createListCrdt: () => new ListCRDT({ actorId: "seed-list" }),
        seedConfigs: [
            {
                id: "alpha",
                title: "Alpha",
                items: [
                    { id: "alpha-1", text: "One", done: false },
                    { id: "alpha-2", text: "Two", done: true },
                ],
            },
            { id: "beta", title: "Beta", items: [] },
        ],
    });
    assert.equal(seeded, true);

    const seededAgain = await seedDefaultsIfEmpty({
        storage,
        listIndexCrdt: index,
        seedConfigs: [{ title: "Should not apply" }],
    });
    assert.equal(seededAgain, false);

    const newIndex = new ListIndexCRDT({ actorId: "hydrate-index" });
    const hydrateResult = await hydrateFromStorage({
        storage,
        listIndexCrdt: newIndex,
        createListCrdt: (listId, state) =>
            new ListCRDT({ actorId: `hydrate-${listId}`, title: state?.title }),
    });

    const lists = newIndex.getVisibleLists();
    assert.equal(lists.length, 2);
    assert.deepEqual(
        lists.map((entry) => entry.id).sort(),
        ["alpha", "beta"],
    );

    const alpha = hydrateResult.lists.get("alpha");
    assert.ok(alpha);
    const alphaSnapshot = alpha.crdt.getSnapshot();
    assert.equal(alphaSnapshot.length, 2);
    assert.equal(alphaSnapshot[0].text.length > 0, true);
    assert.equal(typeof alphaSnapshot[0].done, "boolean");

    assert.ok(Array.isArray(hydrateResult.registryOperations));
});
