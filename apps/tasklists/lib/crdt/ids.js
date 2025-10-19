const DEFAULT_STORAGE_KEY = "prototypeLists.actorId";

/**
 * Attempts to access a persistent storage area (localStorage) while remaining safe when
 * unavailable (server-side rendering, private browsing restrictions, unit tests).
 */
function resolveStorage(customStorage) {
    if (customStorage) return customStorage;
    try {
        if (typeof window !== "undefined" && window.localStorage) {
            return window.localStorage;
        }
    } catch (err) {
        // Accessing localStorage can throw in certain privacy contexts; fall back to memory store.
    }
    let memoryStore = null;
    return {
        getItem(key) {
            if (!memoryStore) return null;
            return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
        },
        setItem(key, value) {
            if (!memoryStore) memoryStore = {};
            memoryStore[key] = value;
        },
    };
}

function generateActorId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `actor-${crypto.randomUUID()}`;
    }
    const rand = Math.random().toString(36).slice(2, 10);
    const time = Date.now().toString(36);
    return `actor-${time}-${rand}`;
}

/**
 * Ensures the current device has a stable actor identifier.
 * @param {Object} options
 * @param {string} [options.storageKey]
 * @param {Storage} [options.storage]
 */
export function ensureActorId(options = {}) {
    const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    const storage = resolveStorage(options.storage);
    let actorId = null;
    try {
        actorId = storage.getItem(storageKey);
    } catch (err) {
        actorId = null;
    }
    if (typeof actorId === "string" && actorId.length > 0) {
        return actorId;
    }
    const next = generateActorId();
    try {
        storage.setItem(storageKey, next);
    } catch (err) {
        // Ignore write failures; in-memory fallback keeps the id for session duration.
    }
    return next;
}

/**
 * Basic Lamport clock implementation with a simple API for CRDT operations.
 */
export class LamportClock {
    constructor(initialTime = 0) {
        this.time = Number.isFinite(initialTime) && initialTime > 0 ? Math.floor(initialTime) : 0;
    }

    /**
     * Returns the current Lamport time.
     */
    value() {
        return this.time;
    }

    /**
     * Advances the clock in response to a local event, optionally observing a remote timestamp.
     * @param {number} [remoteTime]
     */
    tick(remoteTime) {
        const remote = Number.isFinite(remoteTime) ? remoteTime : 0;
        this.time = Math.max(this.time, Math.floor(remote)) + 1;
        return this.time;
    }

    /**
     * Merges a remote Lamport time into this clock without creating a new event.
     * @param {number} remoteTime
     */
    merge(remoteTime) {
        if (!Number.isFinite(remoteTime)) return this.time;
        const candidate = Math.floor(remoteTime);
        if (candidate > this.time) {
            this.time = candidate;
        }
        return this.time;
    }
}

/**
 * Convenience helper that returns a memoized actor id and Lamport clock tuple.
 * This is useful for modules that prefer a single callsite.
 */
export function createIdentityBundle(options = {}) {
    const actorId = ensureActorId(options);
    const clock = new LamportClock();
    return { actorId, clock };
}
