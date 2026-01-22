import type { Locator } from "@playwright/test";

type DragOptions = {
  sourcePosition?: { x: number; y: number };
  targetPosition?: { x: number; y: number };
};

const DEFAULT_POSITION = { x: 8, y: 12 };

async function dragHandleToTarget(
  handle: Locator,
  target: Locator,
  options: DragOptions = {}
) {
  await handle.dragTo(target, {
    sourcePosition: options.sourcePosition ?? DEFAULT_POSITION,
    targetPosition: options.targetPosition ?? DEFAULT_POSITION,
  });
}

export { dragHandleToTarget };
