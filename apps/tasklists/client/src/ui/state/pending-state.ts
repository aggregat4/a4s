/**
 * Something the repository keeps, as the user sees it: the repository's
 * latest state, with the user's changes it has not saved yet applied on top.
 *
 * The repository saves changes one at a time, and on a slow device it lags
 * behind. Until it has saved a change, its snapshots predate it, so the
 * change stays on top of them; changes from other devices show as soon as
 * they arrive.
 */
export class PendingState<State, Change> {
  /** The state as the repository last reported it. */
  private saved: State | null;
  /** The user's changes the repository has not saved yet, in order. */
  private pending: Change[][];
  /** Why the last save failed, until a save succeeds or it is dismissed. */
  private lastFailure: Error | null;

  constructor(
    private readonly options: {
      /** The state before the repository reports one. */
      empty: () => State;
      /** Applies a change; applying it again changes nothing more. */
      apply: (state: State, change: Change) => State;
      /** The repository's state now, read again once a save settles. */
      read: () => State | null;
      /** Called whenever the state, the changes or the failure change. */
      onChange: () => void;
    }
  ) {
    this.saved = null;
    this.pending = [];
    this.lastFailure = null;
  }

  /** The state as the repository last reported it, if it did. */
  get savedState() {
    return this.saved;
  }

  get failure() {
    return this.lastFailure;
  }

  /** Takes the repository's state. */
  setSaved(state: State) {
    this.saved = state;
    this.options.onChange();
  }

  /** The state with the unsaved changes, and then `extra` changes, applied. */
  shown(extra: Change[] = []) {
    return [...this.pending.flat(), ...extra].reduce(this.options.apply, this.base());
  }

  /**
   * Shows a change of the user right away, on top of the repository's state
   * until `saved` settles. Without a save the change is final.
   */
  change(changes: Change[], saved: Promise<unknown> | null) {
    if (!saved) {
      this.saved = changes.reduce(this.options.apply, this.base());
      this.options.onChange();
      return;
    }
    this.pending.push(changes);
    this.options.onChange();
    saved
      .finally(() => {
        this.pending = this.pending.filter((entry) => entry !== changes);
        this.saved = this.options.read() ?? this.saved;
      })
      .then(
        () => this.setFailure(null),
        (err) => this.setFailure(err instanceof Error ? err : new Error(String(err ?? "")))
      );
  }

  dismissFailure() {
    this.setFailure(null);
  }

  private setFailure(failure: Error | null) {
    this.lastFailure = failure;
    this.options.onChange();
  }

  private base() {
    return this.saved ?? this.options.empty();
  }
}
