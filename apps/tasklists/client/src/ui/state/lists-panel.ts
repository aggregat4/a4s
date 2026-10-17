type Listener = (open: boolean) => void;

/** Whether something that opens and closes is open, with listeners. */
class OpenState {
  private open = false;
  private listeners = new Set<Listener>();

  isOpen() {
    return this.open;
  }

  setOpen(next: boolean) {
    if (next === this.open) return;
    this.open = next;
    this.listeners.forEach((listener) => listener(next));
  }

  toggle() {
    this.setOpen(!this.open);
  }

  /** Calls the listener on every change; returns the unsubscribe. */
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Whether the lists panel is open. On narrow screens the sidebar (the lists
 * and the options) is folded behind the list title and drops down from it;
 * the title buttons and the app shell follow this state. Wide screens show
 * the sidebar regardless.
 */
export const listsPanel = new OpenState();

/**
 * Whether the search row is open. On narrow screens the search field is a
 * row under the list title, opened with the search button; it stays open
 * while there is a query, so closing it clears the search. Wide screens show
 * the field in the sidebar regardless.
 */
export const searchRow = new OpenState();
