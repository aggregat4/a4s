type Gesture = {
  startX: number;
  startY: number;
  item: HTMLElement;
  revealWidth: number;
  swiping: boolean;
  wasOpen: boolean;
};

// Parts of a task with touch behaviour of their own: swiping there does nothing.
const NO_SWIPE = ".handle, .task-item-actions, .task-item-toggle, .task-note-toggle, .task-note-panel";

/**
 * Which task shows its actions (Move, Delete). They open with the task's
 * actions button or by swiping the task to the left, and close by swiping
 * it back or by tapping anywhere else.
 */
export class TaskActions {
  /** The task whose actions show, if any. */
  openItemId: string | null;
  private gestures: Map<number, Gesture>;
  private itemElement: (itemId: string) => HTMLElement | null;
  /** Called when the open task changes, to render it. */
  private onChange: () => void;

  constructor({
    itemElement,
    onChange,
  }: {
    itemElement: (itemId: string) => HTMLElement | null;
    onChange: () => void;
  }) {
    this.openItemId = null;
    this.gestures = new Map();
    this.itemElement = itemElement;
    this.onChange = onChange;
  }

  /** Follows the touches on the list, and taps anywhere, until `signal` aborts. */
  listen(list: HTMLElement, signal: AbortSignal) {
    list.addEventListener("touchstart", (event) => this.handleTouchStart(event), {
      passive: true,
      signal,
    });
    list.addEventListener("touchmove", (event) => this.handleTouchMove(event), {
      passive: false,
      signal,
    });
    list.addEventListener("touchend", (event) => this.handleTouchEnd(event), {
      passive: true,
      signal,
    });
    list.addEventListener("touchcancel", (event) => this.handleTouchCancel(event), {
      passive: true,
      signal,
    });
    document.addEventListener("pointerdown", (event) => this.handlePointerDown(event), {
      signal,
    });
  }

  toggle(itemId: string) {
    this.setOpen(this.openItemId === itemId ? null : itemId);
  }

  /**
   * Closes the actions, of `itemId` or of whichever task shows them, without
   * rendering. Returns whether they were open.
   */
  close(itemId?: string) {
    if (!this.openItemId || (itemId && this.openItemId !== itemId)) return false;
    this.openItemId = null;
    return true;
  }

  reset() {
    this.gestures.clear();
    this.openItemId = null;
  }

  private setOpen(itemId: string | null) {
    this.openItemId = itemId;
    this.onChange();
  }

  /** A tap outside the task whose actions show closes them. */
  private closeUnless(target: Node) {
    if (!this.openItemId) return;
    if (this.itemElement(this.openItemId)?.contains(target)) return;
    this.setOpen(null);
  }

  private handlePointerDown(event: PointerEvent) {
    if (event.target instanceof Node) this.closeUnless(event.target);
  }

  private handleTouchStart(event: TouchEvent) {
    for (const touch of Array.from(event.changedTouches)) {
      const element =
        touch.target instanceof Element
          ? touch.target
          : event.target instanceof Element
            ? event.target
            : null;
      if (!element) continue;
      this.closeUnless(element);
      const item = element.closest("li");
      if (!item || element.closest(NO_SWIPE)) continue;
      const itemId = item.dataset.itemId ?? null;
      this.gestures.set(touch.identifier, {
        startX: touch.clientX,
        startY: touch.clientY,
        item,
        revealWidth: revealWidth(item),
        swiping: false,
        wasOpen: itemId !== null && this.openItemId === itemId,
      });
    }
  }

  private handleTouchMove(event: TouchEvent) {
    for (const touch of Array.from(event.changedTouches)) {
      const gesture = this.gestures.get(touch.identifier);
      if (!gesture) continue;
      if (!gesture.item.isConnected) {
        this.gestures.delete(touch.identifier);
        continue;
      }
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;
      if (!gesture.swiping) {
        if (Math.abs(deltaX) < 8) continue;
        // Mostly vertical: a scroll, not a swipe.
        if (Math.abs(deltaX) < Math.abs(deltaY)) {
          clearReveal(gesture.item);
          this.gestures.delete(touch.identifier);
          continue;
        }
        gesture.swiping = true;
      }
      event.preventDefault();
      setReveal(gesture.item, reveal(gesture, deltaX), gesture.revealWidth);
    }
  }

  private handleTouchEnd(event: TouchEvent) {
    for (const touch of Array.from(event.changedTouches)) {
      const gesture = this.gestures.get(touch.identifier);
      if (!gesture) continue;
      this.gestures.delete(touch.identifier);
      if (!gesture.item.isConnected) continue;
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;
      clearReveal(gesture.item);
      if (Math.abs(deltaX) < 30 || Math.abs(deltaX) < Math.abs(deltaY)) continue;
      // Swiped more than halfway open: the actions stay open.
      const open = reveal(gesture, deltaX) > gesture.revealWidth / 2;
      this.setOpen(open ? gesture.item.dataset.itemId ?? null : null);
    }
  }

  private handleTouchCancel(event: TouchEvent) {
    for (const touch of Array.from(event.changedTouches)) {
      const gesture = this.gestures.get(touch.identifier);
      if (gesture) clearReveal(gesture.item);
      this.gestures.delete(touch.identifier);
    }
  }
}

/** How far the actions show, from how far the task was swiped. */
function reveal(gesture: Gesture, deltaX: number) {
  const start = gesture.wasOpen ? gesture.revealWidth : 0;
  return Math.max(0, Math.min(gesture.revealWidth, start - deltaX));
}

function revealWidth(item: HTMLElement) {
  const actions = item.querySelector<HTMLElement>(".task-item-actions");
  if (!actions) return 128;
  return Math.max(96, Math.min(actions.scrollWidth || 128, 180));
}

function setReveal(item: HTMLElement, width: number, revealWidth: number) {
  item.style.setProperty("--task-swipe-translate", `${-width}px`);
  item.style.setProperty("--task-actions-reveal-width", `${revealWidth}px`);
  item.classList.toggle("task-item-swiping", width > 0);
}

function clearReveal(item: HTMLElement) {
  item.classList.remove("task-item-swiping");
  item.style.removeProperty("--task-swipe-translate");
  item.style.removeProperty("--task-actions-reveal-width");
}
