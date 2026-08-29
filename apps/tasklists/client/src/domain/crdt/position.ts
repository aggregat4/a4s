/**
 * Positions implement the identifier logic for our list CRDT. Each position is an
 * ordered array of components shaped as `{ digit: number, actor: string }`.
 * - `digit` sits in a numeric slot at a given depth. Larger digits sort after smaller
 *   ones, so they encode the relative ordering within that level (241 is “after”
 *   112). Think of it as an exponentially large, sparse index space that we can
 *   sub-divide as needed.
 * - `actor` ensures uniqueness when two peers land on the same digit. Actor ids are
 *   compared lexicographically, so `actor-a` sorts before `actor-b`.
 *
 * Successive edits play out as follows (assuming base 1024 and actors alice/bob/carol/dave/aaron):
 *   1. First insert (no neighbors) → `[{ digit: 512, actor: "alice" }]`.
 *   2. Insert before the head → `between(null, first)` yields `[{ digit: 256, actor: "bob" }]`.
 *   3. Insert between the two → `between(before, first)` averages the digits
 *      `(256 + 512) / 2 = 384`, giving `[{ digit: 384, actor: "carol" }]`.
 *   4. Another concurrent insert between the same neighbors by dave lands on the same
 *      midpoint digit, but the actor breaks the tie:
 *      `[{ digit: 384, actor: "dave" }]` sorts after carol’s entry.
 *   5. Later, actor `"aaron"` (lexicographically before `"carol"`) tries to slot an
 *      item between carol’s and dave’s positions. Because the digits are identical and
 *      `"carol" < "aaron"` is false, `between()` copies the shared prefix
 *      `{ digit: 384, actor: "carol" }` and emits a new suffix component:
 *      `[{ digit: 384, actor: "carol" }, { digit: 512, actor: "aaron" }]`.
 *
 * Comparing positions lexicographically preserves list order, and generating a position
 * “between” two neighbors lets us insert without reshuffling existing identifiers.
 *
 * The helpers below sanitize incoming positions (whether from local code or remote
 * replicas), compare them deterministically, and produce new ones via `between()`.
 * The latter walks component-by-component, picking a digit that fits between the
 * supplied bounds, extending the array as needed. When both digits collide it falls
 * back to actor lexicographic ordering, guaranteeing uniqueness even under heavy
 * contention. This infrastructure underpins list insert/move operations in
 * `OrderedSetCRDT` and friends, letting replicas converge regardless of operation
 * order or batching.
 */
const DEFAULT_BASE = 1024;
const DEFAULT_DEPTH = 6;

type PositionComponent = { digit: number; actor: string };
type Position = PositionComponent[];

function sanitizeDigit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const digit = Math.floor(value);
  return digit < 0 ? 0 : digit;
}

function sanitizeActor(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function normalizePosition(position: unknown): Position {
  if (!Array.isArray(position)) return [];
  return position
    .map((component) => ({
      digit: sanitizeDigit(component?.digit),
      actor: sanitizeActor(component?.actor),
    }))
    .filter((component, index, array) => {
      if (index === array.length - 1) return true;
      return !(component.digit === 0 && component.actor === "");
    });
}

function compareComponents(
  left: PositionComponent | null = null,
  right: PositionComponent | null = null
) {
  const leftDigit = left ? left.digit : 0;
  const rightDigit = right ? right.digit : 0;
  if (leftDigit !== rightDigit) {
    return leftDigit < rightDigit ? -1 : 1;
  }
  const leftActor = left ? left.actor : "";
  const rightActor = right ? right.actor : "";
  if (leftActor === rightActor) return 0;
  return leftActor < rightActor ? -1 : 1;
}

export function comparePositions(left: unknown, right: unknown) {
  const a = normalizePosition(left);
  const b = normalizePosition(right);
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    const cmp = compareComponents(a[i], b[i]);
    if (cmp !== 0) {
      return cmp;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function chooseDigit(leftDigit: number, rightDigit: number) {
  return Math.floor((leftDigit + rightDigit) / 2);
}

/**
 * Generates a position strictly between two existing positions.
 * When either bound is omitted, the algorithm assumes a virtual minimum (0) or
 * maximum (base) component for that depth.
 */
export function between(
  left: unknown,
  right: unknown,
  options: { actor?: string; base?: number; depth?: number } = {}
): Position {
  const actor = sanitizeActor(options.actor);
  if (!actor) {
    throw new Error("between() requires an actor identifier");
  }
  const base =
    typeof options.base === "number" &&
    Number.isFinite(options.base) &&
    options.base > 2
      ? Math.floor(options.base)
      : DEFAULT_BASE;
  const depth =
    typeof options.depth === "number" &&
    Number.isFinite(options.depth) &&
    options.depth > 0
      ? Math.floor(options.depth)
      : DEFAULT_DEPTH;
  const leftNorm = normalizePosition(left);
  const rightNorm = normalizePosition(right);

  if (leftNorm.length && rightNorm.length) {
    const ordering = comparePositions(leftNorm, rightNorm);
    if (ordering >= 0) {
      throw new Error(
        "between() expects left position to be strictly less than right position"
      );
    }
  }

  const result: Position = [];
  for (let level = 0; level < depth; level++) {
    const leftComponent = leftNorm[level] ?? null;
    const rightComponent = rightNorm[level] ?? null;
    const leftDigit = leftComponent ? leftComponent.digit : 0;
    const rightDigit = rightComponent ? rightComponent.digit : base;

    if (rightDigit - leftDigit > 1) {
      result.push({
        digit: chooseDigit(leftDigit, rightDigit),
        actor,
      });
      return result;
    }

    const digitGap = rightDigit - leftDigit;
    const sameDigit = digitGap === 0;
    if (sameDigit) {
      const leftActor = leftComponent ? leftComponent.actor : "";
      const rightActor = rightComponent ? rightComponent.actor : "";
      if (leftActor < actor && (rightActor === "" || actor < rightActor)) {
        result.push({
          digit: leftDigit,
          actor,
        });
        return result;
      }
    }

    if (leftComponent) {
      result.push({ digit: leftComponent.digit, actor: leftComponent.actor });
    } else {
      result.push({ digit: leftDigit, actor });
    }
  }

  result.push({
    digit: Math.floor(base / 2),
    actor,
  });
  return result;
}

export function clonePosition(position: unknown): Position {
  return normalizePosition(position).map((component) => ({ ...component }));
}

export function positionToKey(position: unknown) {
  return normalizePosition(position)
    .map((component) => `${component.digit}:${component.actor}`)
    .join("|");
}
