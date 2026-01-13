const DEFAULT_STORAGE_KEY = "prototypeLists.actorId";

function resolveStorage(customStorage) {
  if (customStorage) return customStorage;
  const storage = globalThis?.localStorage;
  if (!storage) {
    throw new Error(
      "localStorage is required for actor identity persistence; provide options.storage when running outside the browser."
    );
  }
  return storage;
}

function generateActorId() {
  return `actor-${crypto.randomUUID()}`;
}

/**
 * Ensures the current device has a stable actor identifier.
 * @param {Object} options
 * @param {string} [options.storageKey]
 * @param {Storage} [options.storage]
 */
export function ensureActorId(options: any = {}) {
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
    // Ignore write failures; caller-provided storage shims may be read-only in tests.
  }
  return next;
}

/**
 * Basic Lamport clock implementation with a simple API for CRDT operations.
 */
export class LamportClock {
  time: number;

  constructor(initialTime = 0) {
    this.time =
      Number.isFinite(initialTime) && initialTime > 0
        ? Math.floor(initialTime)
        : 0;
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
