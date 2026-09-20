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

test("between() inserts before a digit-zero head from another actor", () => {
    const head = [
        { digit: 0, actor: "actor-a" },
        { digit: 128, actor: "actor-a" },
    ];
    const result = between(null, head, { actor: "actor-z" });
    assert.deepEqual(result, [
        { digit: 0, actor: "actor-a" },
        { digit: 64, actor: "actor-z" },
    ]);
    assert.equal(comparePositions(result, head), -1);
});

test("between() keeps a digit-zero head insertable before", () => {
    const result = between(null, [{ digit: 0, actor: "actor-z" }], {
        actor: "actor-a",
    });
    // The actor sorts before the head, so it is preserved, but the result must
    // not terminate in a digit-zero component.
    assert.equal(result[0].digit, 0);
    assert.ok(result.length > 1);
    assert.notEqual(result[result.length - 1].digit, 0);
});

test("between() never terminates a position with a digit-zero component", () => {
    const actor = "actor-z";
    const samples: Array<[unknown, unknown]> = [
        [null, [{ digit: 0, actor: "actor-a" }]],
        [null, [{ digit: 0, actor: "actor-a" }, { digit: 0, actor: "actor-a" }]],
        [null, [{ digit: 0, actor: "actor-z" }]],
        [[{ digit: 0, actor: "actor-a" }], [{ digit: 0, actor: "actor-b" }]],
        // The actor fits between the bounds, but a digit-zero component must
        // still be followed by a suffix.
        [[{ digit: 0, actor: "actor-a" }], [{ digit: 0, actor: "actor-zz" }]],
    ];
    for (const [left, right] of samples) {
        const result = between(left, right, { actor });
        assert.ok(result.length > 0);
        assert.notEqual(result[result.length - 1].digit, 0);
    }
});

test("between() always produces a position strictly inside its bounds", () => {
    type Position = ReturnType<typeof normalizePosition>;

    // A spread of shapes: digit-zero prefixes, shared prefixes, trailing
    // non-zero digits, and a range of actor orderings.
    const rawBounds: unknown[] = [
        null,
        [{ digit: 0, actor: "actor-a" }, { digit: 1, actor: "actor-a" }],
        [{ digit: 0, actor: "actor-z" }, { digit: 128, actor: "actor-z" }],
        [
            { digit: 0, actor: "actor-a" },
            { digit: 0, actor: "actor-a" },
            { digit: 4, actor: "actor-a" },
        ],
        [{ digit: 1, actor: "alice" }],
        [{ digit: 1, actor: "bob" }],
        [{ digit: 2, actor: "alice" }],
        [{ digit: 5, actor: "alice" }, { digit: 3, actor: "bob" }],
        [{ digit: 5, actor: "alice" }, { digit: 3, actor: "carol" }],
        [{ digit: 5, actor: "mike" }],
        [{ digit: 512, actor: "alice" }],
        [{ digit: 1023, actor: "alice" }],
    ];
    const bounds: Position[] = rawBounds.map((bound) =>
        normalizePosition(bound)
    );
    const actors = [
        "actor-0",
        "actor-a",
        "actor-m",
        "actor-z",
        "alice",
        "carol",
        "zulu",
    ];

    // Only positions that do not terminate in a digit-zero component are valid
    // right bounds; `between` never produces any other kind after this change.
    const isValidRight = (position: Position) =>
        position.length === 0 || position[position.length - 1].digit !== 0;

    for (const left of bounds) {
        for (const right of bounds) {
            if (!isValidRight(right)) continue;
            const hasLeft = left.length > 0;
            const hasRight = right.length > 0;
            if (hasLeft && hasRight && comparePositions(left, right) >= 0) {
                continue;
            }
            for (const actor of actors) {
                const result = between(
                    hasLeft ? left : null,
                    hasRight ? right : null,
                    { actor }
                );
                assert.ok(result.length > 0);
                if (hasLeft) {
                    assert.equal(
                        comparePositions(result, left) > 0,
                        true,
                        `${positionToKey(result)} must sort after ${positionToKey(left)}`
                    );
                }
                if (hasRight) {
                    assert.equal(
                        comparePositions(result, right) < 0,
                        true,
                        `${positionToKey(result)} must sort before ${positionToKey(right)}`
                    );
                }
                assert.notEqual(
                    result[result.length - 1].digit,
                    0,
                    "position must not terminate in a digit-zero component"
                );
            }
        }
    }
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
