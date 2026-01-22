import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizePosition,
    comparePositions,
    between,
    clonePosition,
    positionToKey,
} from "../../../src/domain/crdt/position.js";

test("normalizePosition sanitizes non-arrays and component shapes", () => {
    assert.deepEqual(normalizePosition(null), []);
    assert.deepEqual(normalizePosition("not-an-array"), []);

    const result = normalizePosition([
        { digit: 3.7, actor: "bob" },
        { digit: -4, actor: null },
        { digit: 0, actor: "" },
    ]);

    assert.deepEqual(result, [
        { digit: 3, actor: "bob" },
        { digit: 0, actor: "" },
    ]);
});

test("comparePositions orders by digit, actor, and depth", () => {
    const a = [{ digit: 1, actor: "alice" }];
    const b = [{ digit: 2, actor: "alice" }];
    assert.equal(comparePositions(a, b), -1);
    assert.equal(comparePositions(b, a), 1);

    const withActors = [
        { digit: 5, actor: "alice" },
        { digit: 5, actor: "carol" },
    ];
    const withActors2 = [
        { digit: 5, actor: "alice" },
        { digit: 5, actor: "dave" },
    ];
    assert.equal(comparePositions(withActors, withActors2), -1);

    const shorter = [{ digit: 8, actor: "alice" }];
    const longer = [
        { digit: 8, actor: "alice" },
        { digit: 100, actor: "alice" },
    ];
    assert.equal(comparePositions(shorter, longer), -1);
});

test("between() creates midpoint positions when space exists", () => {
    const result = between(null, null, { actor: "alice" });
    assert.deepEqual(result, [{ digit: 512, actor: "alice" }]);

    const left = [{ digit: 100, actor: "alice" }];
    const right = [{ digit: 900, actor: "bob" }];
    const mid = between(left, right, { actor: "carol" });
    assert.deepEqual(mid, [{ digit: 500, actor: "carol" }]);
});

test("between() throws for missing actor or invalid ordering", () => {
    assert.throws(() => between(null, null), /requires an actor identifier/);

    const same = [{ digit: 200, actor: "alice" }];
    assert.throws(
        () => between(same, same, { actor: "bob" }),
        /left position to be strictly less/,
    );
});

test("between() uses actor tie-breakers when digits match", () => {
    const left = [{ digit: 30, actor: "alice" }];
    const right = [{ digit: 30, actor: "dave" }];

    const betweenActors = between(left, right, { actor: "carol" });
    assert.deepEqual(betweenActors, [{ digit: 30, actor: "carol" }]);
});

test("between() falls back to deeper components when actors cannot insert between", () => {
    const left = [{ digit: 40, actor: "delta" }];
    const right = [{ digit: 40, actor: "epsilon" }];

    const result = between(left, right, { actor: "beta" });
    assert.deepEqual(result, [
        { digit: 40, actor: "delta" },
        { digit: 512, actor: "beta" },
    ]);
});

test("clonePosition returns a detached, sanitized copy", () => {
    const original = [
        { digit: 5, actor: "alice" },
        { digit: 7, actor: "bob" },
    ];
    const cloned = clonePosition(original);

    assert.notEqual(cloned, original);
    assert.deepEqual(cloned, original);

    cloned[0].digit = 999;
    assert.equal(original[0].digit, 5);
});

test("positionToKey flattens positions deterministically", () => {
    const pos = [
        { digit: 3, actor: "alice" },
        { digit: 9, actor: "bob" },
    ];
    assert.equal(positionToKey(pos), "3:alice|9:bob");
});
