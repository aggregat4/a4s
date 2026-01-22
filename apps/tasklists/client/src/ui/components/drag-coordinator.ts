import DraggableBehavior, { FlipAnimator } from "../../shared/drag-behavior.js";

type DragCoordinatorOptions = {
  handleClass?: string;
  animator?: FlipAnimator | null;
  onReorder?: ((fromIndex: number, toIndex: number) => void) | null;
  onDragStart?: ((event: DragEvent) => void) | null;
  onDragEnd?: ((event: DragEvent) => void) | null;
  onDrop?: ((event: DragEvent) => void) | null;
};

class DragCoordinator {
  private container: HTMLElement | null;
  private behavior: DraggableBehavior | null;
  private options: Required<DragCoordinatorOptions>;
  private handleDragStart: (event: DragEvent) => void;
  private handleDragEnd: (event: DragEvent) => void;
  private handleDrop: (event: DragEvent) => void;

  constructor(options: DragCoordinatorOptions = {}) {
    this.container = null;
    this.behavior = null;
    this.options = {
      handleClass: "handle",
      animator: null,
      onReorder: null,
      onDragStart: null,
      onDragEnd: null,
      onDrop: null,
      ...options,
    };
    this.handleDragStart = (event) => this.options.onDragStart?.(event);
    this.handleDragEnd = (event) => this.options.onDragEnd?.(event);
    this.handleDrop = (event) => this.options.onDrop?.(event);
  }

  attach(container: HTMLElement | null) {
    if (!container) return;
    if (this.container === container && this.behavior) {
      this.behavior.invalidateItemsCache();
      return;
    }
    this.detach();
    this.container = container;
    this.behavior = new DraggableBehavior(container, {
      handleClass: this.options.handleClass,
      animator: this.options.animator ?? null,
      onReorder: this.options.onReorder ?? null,
    });
    this.behavior.enable();
    container.addEventListener("dragstart", this.handleDragStart);
    container.addEventListener("dragend", this.handleDragEnd);
    container.addEventListener("drop", this.handleDrop);
  }

  invalidateItemsCache() {
    this.behavior?.invalidateItemsCache();
  }

  cancel() {
    this.behavior?.cancel?.();
  }

  destroy() {
    this.detach();
    this.behavior?.destroy();
    this.behavior = null;
  }

  private detach() {
    if (!this.container) return;
    this.container.removeEventListener("dragstart", this.handleDragStart);
    this.container.removeEventListener("dragend", this.handleDragEnd);
    this.container.removeEventListener("drop", this.handleDrop);
    this.container = null;
  }
}

export { DragCoordinator };
