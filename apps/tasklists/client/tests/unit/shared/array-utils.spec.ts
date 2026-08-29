import { describe, it } from "node:test";
import assert from "node:assert";
import { arraysEqual } from "../../../src/shared/array-utils.js";

describe("arraysEqual", () => {
  it("returns true for same reference", () => {
    const arr = [1, 2, 3];
    assert.strictEqual(arraysEqual(arr, arr), true);
  });

  it("returns true for equal arrays", () => {
    assert.strictEqual(arraysEqual([1, 2, 3], [1, 2, 3]), true);
  });

  it("returns false for different lengths", () => {
    assert.strictEqual(arraysEqual([1, 2], [1, 2, 3]), false);
  });

  it("returns false for different elements", () => {
    assert.strictEqual(arraysEqual([1, 2, 3], [1, 2, 4]), false);
  });

  it("returns true for empty arrays", () => {
    assert.strictEqual(arraysEqual([], []), true);
  });

  it("uses default parameters", () => {
    assert.strictEqual(arraysEqual(), true);
    assert.strictEqual(arraysEqual([1]), false);
    assert.strictEqual(arraysEqual(undefined, [1]), false);
  });

  it("works with string arrays", () => {
    assert.strictEqual(arraysEqual(["a", "b"], ["a", "b"]), true);
    assert.strictEqual(arraysEqual(["a", "b"], ["a", "c"]), false);
  });
});
