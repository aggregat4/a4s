const EMPTY_DRAG_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";

export class FlipAnimator {
  snapshot(container: HTMLElement, dragging: HTMLElement | null) {

    const map = new Map<Element, number>();
    Array.from(container.querySelectorAll("li")).forEach((li) => {
      if (li !== dragging) {
        map.set(li, li.getBoundingClientRect().top);
      }
    });
    return map;
  }

  play(
    container: HTMLElement,
    dragging: HTMLElement | null,
    prevTops: Map<Element, number> | null
  ) {
    if (!prevTops) return;
    Array.from(container.querySelectorAll("li")).forEach((li) => {
      if (li === dragging) return;
      const prevTop = prevTops.get(li);
      if (prevTop == null) return;

      const nowTop = li.getBoundingClientRect().top;
      const dy = prevTop - nowTop;
      if (dy === 0) return;

      li.style.transform = `translateY(${dy}px)`;
      // force reflow so the browser picks up the initial transform before transitioning back
      // eslint-disable-next-line no-unused-expressions
      li.offsetHeight;

      li.classList.add("flip-animating");
      li.style.transform = "translateY(0)";

      const done = () => {
        li.classList.remove("flip-animating");
        li.style.transform = "";
        li.removeEventListener("transitionend", done);
      };
      li.addEventListener("transitionend", done, { once: true });
    });
  }
}

export default class DraggableBehavior {
  private container: HTMLElement | null;
  private options: {
    handleClass: string;
    threshold: number;
    onReorder: ((fromIndex: number, toIndex: number) => void) | null;
    animator: FlipAnimator | null;
    debug: boolean;
    pointerFallback?: boolean;
  };
  private dragging: HTMLElement | null;
  private touchStartY: number;
  private touchStartX: number;
  private isTouchDragging: boolean;
  private rafId: number | null;
  private cachedItems: HTMLElement[] | null;
  private enabled: boolean;
  private originalPosition: number | null;
  private animator: FlipAnimator | null;
  private _currentPlaceholderIndex: number | null;
  private _dropHandled: boolean;
  private dragStartIndex: number | null;
  private _lastClientY: number | null;
  private _lastDragOverLogTs: number;
  private _onDragStart: (event: DragEvent) => void;
  private _onDragEnd: (event: DragEvent) => void;
  private _onDragOver: (event: DragEvent) => void;
  private _onDrop: (event: DragEvent) => void;
  private _onTouchStart: (event: TouchEvent) => void;
  private _onTouchMove: (event: TouchEvent) => void;
  private _onTouchEnd: (event: TouchEvent) => void;
  private deferFloatingInit: boolean;
  private _pendingInitCoords: { x: number; y: number } | null;

  constructor(
    container: HTMLElement,
    options: {
      handleClass?: string;
      threshold?: number;
      onReorder?: ((fromIndex: number, toIndex: number) => void) | null;
      animator?: FlipAnimator | null;
      debug?: boolean;
      pointerFallback?: boolean;
    } = {}
  ) {
    this.container = container;
    this.options = {
      handleClass: "handle",
      threshold: 10,
      onReorder: null,
      animator: null,
      debug: false,
      ...options,
    };
    this.dragging = null;
    this.touchStartY = 0;
    this.touchStartX = 0;
    this.isTouchDragging = false;
    this.rafId = null;
    this.cachedItems = null;
    this.enabled = false;
    this.originalPosition = null;
    this.animator = this.options.animator;
    this._currentPlaceholderIndex = null;
    this._dropHandled = false;
    this.dragStartIndex = null;
    this._lastClientY = null;
    this._lastDragOverLogTs = 0;

    this._onDragStart = this.handleDragStart.bind(this);
    this._onDragEnd = this.handleDragEnd.bind(this);
    this._onDragOver = this.handleDragOver.bind(this);
    this._onDrop = this.handleDrop.bind(this);

    this._onTouchStart = this.handleTouchStart.bind(this);
    this._onTouchMove = this.handleTouchMove.bind(this);
    this._onTouchEnd = this.handleTouchEnd.bind(this);

    this.deferFloatingInit = false;
    this._pendingInitCoords = null;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.setupEventListeners();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.removeEventListeners();
  }

  destroy() {
    this.disable();
    this.container = null;
  }

  setupEventListeners() {
    this.container.addEventListener("dragstart", this._onDragStart);
    this.container.addEventListener("dragend", this._onDragEnd);
    this.container.addEventListener("dragover", this._onDragOver);
    this.container.addEventListener("drop", this._onDrop);

    this.container.addEventListener("touchstart", this._onTouchStart, {
      passive: false,
    });
    this.container.addEventListener("touchmove", this._onTouchMove, {
      passive: false,
    });
    this.container.addEventListener("touchend", this._onTouchEnd, {
      passive: true,
    });
  }

  removeEventListeners() {
    this.container.removeEventListener("dragstart", this._onDragStart);
    this.container.removeEventListener("dragend", this._onDragEnd);
    this.container.removeEventListener("dragover", this._onDragOver);
    this.container.removeEventListener("drop", this._onDrop);

    this.container.removeEventListener("touchstart", this._onTouchStart);
    this.container.removeEventListener("touchmove", this._onTouchMove);
    this.container.removeEventListener("touchend", this._onTouchEnd);
  }

  handleDragStart(event: DragEvent) {
    const li = (event.target as HTMLElement | null)?.closest("li");
    if (!li) return;

    this.deferFloatingInit = false;
    this._pendingInitCoords = null;

    this.startDrag(li, event.clientX, event.clientY);

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      const id = li.dataset?.itemId ?? "drag";
      event.dataTransfer.setData("text/plain", id);
      try {
        event.dataTransfer.dropEffect = "move";
      } catch {
        // ignore
      }
      const emptyImg = document.createElement("img");
      emptyImg.src = EMPTY_DRAG_IMAGE;
      event.dataTransfer.setDragImage(emptyImg, 0, 0);
    }
  }

  handleDragEnd(_event: DragEvent) {
    if (
      this.dragging &&
      !this._dropHandled &&
      this._currentPlaceholderIndex != null
    ) {
      const fromIndex =
        this.dragStartIndex ??
        this.originalPosition ??
        this.getIndex(this.dragging);
      const toIndex = this._currentPlaceholderIndex;
      if (fromIndex !== toIndex) {
        this.options.onReorder?.(fromIndex, toIndex);
        this._dropHandled = true;
        this.originalPosition = null;
      }
    }
    this.endDrag();
    this._dropHandled = false;
    this._currentPlaceholderIndex = null;
    this._lastClientY = null;
  }

  handleDragOver(event: DragEvent) {
    event.preventDefault();

    if (this.dragging && this.deferFloatingInit) {
      this.deferFloatingInit = false;
      const coords = this._pendingInitCoords || {
        x: event.clientX,
        y: event.clientY,
      };
      this.beginFloating(coords.x, coords.y);
      this._pendingInitCoords = null;
    }

    if (Number.isFinite(event.clientY)) {
      this._lastClientY = event.clientY;
    }
    this.debouncedDragOver(event.clientY);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }

    const now = Date.now();
    if (now - this._lastDragOverLogTs > 120) {
      this._lastDragOverLogTs = now;
    }
  }

  handleDrop(event: DragEvent) {
    event.preventDefault();
    const dropY =
      event.clientY !== 0 && Number.isFinite(event.clientY)
        ? event.clientY
        : Number.isFinite(this._lastClientY)
        ? this._lastClientY
        : event.clientY;
    this.drop(dropY);
    this.endDrag();
  }

  handleTouchStart(event: TouchEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains(this.options.handleClass)) return;
    const li = target.closest("li");
    if (!li) return;
    if (event.cancelable) event.preventDefault();
    this.touchStartY = event.touches[0].clientY;
    this.touchStartX = event.touches[0].clientX;
    this.isTouchDragging = false;
  }

  handleTouchMove(event: TouchEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains(this.options.handleClass)) return;
    if (event.cancelable) event.preventDefault();

    const deltaY = event.touches[0].clientY - this.touchStartY;
    const deltaX = event.touches[0].clientX - this.touchStartX;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (!this.isTouchDragging && distance < this.options.threshold) {
      return;
    }

    if (!this.isTouchDragging) {
      this.isTouchDragging = true;
      const li = target.closest("li");
      if (!li) return;
      this.deferFloatingInit = false;
      this.startDrag(li, event.touches[0].clientX, event.touches[0].clientY);
    } else {
      this.debouncedDragOver(event.touches[0].clientY);
    }
  }

  handleTouchEnd(event: TouchEvent) {
    if (this.isTouchDragging && this.dragging) {
      this.drop(event.changedTouches[0].clientY);
      this.endDrag();
    }
  }

  startDrag(li, startClientX = null, startClientY = null) {
    this.dragging = li;
    this.dragStartIndex = this.getIndex(li);
    this.originalPosition = this.dragStartIndex;
    this._lastClientY = Number.isFinite(startClientY) ? startClientY : null;
    this.invalidateItemsCache();
    this._currentPlaceholderIndex = this.originalPosition;
    this._dropHandled = false;
    this.dragging.classList.add("dragging");

    if (
      !this.deferFloatingInit &&
      startClientX != null &&
      startClientY != null
    ) {
      this.beginFloating(startClientX, startClientY);
    }
  }

  endDrag() {
    if (!this.dragging) return;
    const draggedRef = this.dragging;

    this.dragging = null;
    this.isTouchDragging = false;
    this.originalPosition = null;
    this.dragStartIndex = null;
    draggedRef.classList.remove("dragging");
    draggedRef.style.position = "";
    draggedRef.style.top = "";
    draggedRef.style.left = "";
    draggedRef.style.width = "";
    draggedRef.style.zIndex = "";
    draggedRef.style.pointerEvents = "";
    draggedRef.style.boxShadow = "";
    draggedRef.style.opacity = "";
    this.invalidateItemsCache();
    this._lastClientY = null;
  }

  dragOver(clientY) {
    if (!this.dragging) return;
    const after = this.getDropTarget(clientY);
    this.moveDraggedElement(after);
  }

  debouncedDragOver(clientY) {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      this.dragOver(clientY);
      this.rafId = null;
    });
  }

  drop(clientY) {
    if (!this.dragging) return;
    const after = this.getDropTarget(clientY);
    this.moveDraggedElement(after);
    const draggedRef = this.dragging;
    const startIndex =
      this.dragStartIndex ?? this.originalPosition ?? this.getIndex(draggedRef);
    this.originalPosition = null;
    draggedRef.classList.add("drop-animation");
    setTimeout(() => draggedRef.classList.remove("drop-animation"), 300);
    if (this.options.onReorder) {
      const items = Array.from(this.container.children);
      const toIndex = items.indexOf(draggedRef);
      this.options.onReorder(startIndex, toIndex);
    }
    this._dropHandled = true;
  }

  beginFloating(eClientX, eClientY) {
    const li = this.dragging;
    if (!li) return;
    const rect = li.getBoundingClientRect();

    void (eClientY != null ? eClientY - rect.top : rect.height / 2);
    void (eClientX != null ? eClientX - rect.left : 16);
  }

  getDropTarget(mouseY) {
    if (!this.cachedItems) {
      this.cachedItems = Array.from(
        this.container.querySelectorAll("li:not(.dragging):not(.placeholder)")
      );
    }
    if (this.cachedItems.length === 0) return null;

    let left = 0;
    let right = this.cachedItems.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      const rect = this.cachedItems[mid].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (mouseY < midY) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }

    return left < this.cachedItems.length ? this.cachedItems[left] : null;
  }

  getIndex(element) {
    return Array.from(this.container.children).indexOf(element);
  }

  invalidateItemsCache() {
    this.cachedItems = null;
  }

  moveDraggedElement(after) {
    if (!this.dragging) return;

    const prevSnapshot = this.animator?.snapshot(this.container, this.dragging);

    if (after == null) {
      this.container.appendChild(this.dragging);
    } else {
      this.container.insertBefore(this.dragging, after);
    }

    this.invalidateItemsCache();
    this._currentPlaceholderIndex = this.getIndex(this.dragging);
    this.animator?.play(this.container, this.dragging, prevSnapshot);
  }

  cancel() {
    if (!this.dragging) return;
    this.endDrag();
  }
}
