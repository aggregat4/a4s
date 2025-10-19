const DEFAULT_BASE = 1024;
const DEFAULT_DEPTH = 6;

function sanitizeDigit(value) {
    if (!Number.isFinite(value)) return 0;
    const digit = Math.floor(value);
    return digit < 0 ? 0 : digit;
}

function sanitizeActor(value) {
    return typeof value === "string" ? value : "";
}

export function normalizePosition(position) {
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

function compareComponents(left = null, right = null) {
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

export function comparePositions(left, right) {
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

function chooseDigit(leftDigit, rightDigit) {
    return Math.floor((leftDigit + rightDigit) / 2);
}

/**
 * Generates a position strictly between two existing positions.
 * When either bound is omitted, the algorithm assumes a virtual minimum (0) or
 * maximum (base) component for that depth.
 */
export function between(left, right, options = {}) {
    const actor = sanitizeActor(options.actor);
    if (!actor) {
        throw new Error("between() requires an actor identifier");
    }
    const base = Number.isFinite(options.base) && options.base > 2 ? Math.floor(options.base) : DEFAULT_BASE;
    const depth = Number.isFinite(options.depth) && options.depth > 0 ? Math.floor(options.depth) : DEFAULT_DEPTH;
    const leftNorm = normalizePosition(left);
    const rightNorm = normalizePosition(right);

    if (leftNorm.length && rightNorm.length) {
        const ordering = comparePositions(leftNorm, rightNorm);
        if (ordering >= 0) {
            throw new Error("between() expects left position to be strictly less than right position");
        }
    }

    const result = [];
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

export function clonePosition(position) {
    return normalizePosition(position).map((component) => ({ ...component }));
}

export function positionToKey(position) {
    return normalizePosition(position)
        .map((component) => `${component.digit}:${component.actor}`)
        .join("|");
}
