import { directive, Directive, PartType } from "../directive.js";
import { setCommittedValue } from "../directive-helpers.js";

/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
class RefValue {
  constructor() {
    this.value = undefined;
  }
}

const createRef = () => new RefValue();

const ref = directive(
  class extends Directive {
    constructor(partInfo) {
      super(partInfo);
      const type = partInfo.type;
      if (
        type !== PartType.ATTRIBUTE &&
        type !== PartType.PROPERTY &&
        type !== PartType.BOOLEAN_ATTRIBUTE &&
        type !== PartType.EVENT &&
        type !== PartType.ELEMENT
      ) {
        throw new Error(
          "The `ref` directive must be used in attribute, property, boolean attribute, event, or element positions"
        );
      }
    }

    render(refTarget) {
      return refTarget;
    }

    update(part, [refTarget]) {
      const element = part.element;
      if (typeof refTarget === "function") {
        const value = refTarget(element);
        setCommittedValue(part, value);
        return value;
      }
      if (refTarget != null) {
        refTarget.value = element;
      }
      setCommittedValue(part, refTarget);
      return refTarget;
    }
  }
);

export { createRef, ref };
