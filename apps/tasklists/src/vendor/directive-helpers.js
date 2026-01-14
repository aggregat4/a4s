import { _$LH as legacyHelpers } from "./lit-html.js";

/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const { I: ChildPart } = legacyHelpers;

const isPrimitive = (value) =>
  value === null || (typeof value !== "object" && typeof value !== "function");

const TemplateResultType = {
  HTML: 1,
  SVG: 2,
  MATHML: 3,
};

const isTemplateResult = (value, type) =>
  type === undefined ? value?._$litType$ !== undefined : value?._$litType$ === type;

const isCompiledTemplateResult = (value) => value?._$litType$?.h != null;

const isDirectiveResult = (value) => value?._$litDirective$ !== undefined;

const getDirectiveClass = (value) => value?._$litDirective$;

const isSingleExpression = (part) => part?.strings === undefined;

const createMarker = () => document.createComment("");

const insertPart = (part, refNode, newPart) => {
  const container = part._$AA.parentNode;
  const end =
    refNode === undefined ? part._$AB : refNode._$AA;

  if (newPart === undefined) {
    const start = container.insertBefore(createMarker(), end);
    const stop = container.insertBefore(createMarker(), end);
    newPart = new ChildPart(start, stop, part, part.options);
  } else {
    const next = newPart._$AB.nextSibling;
    const prevParent = newPart._$AM;
    const parentChanged = prevParent !== part;

    if (parentChanged) {
      newPart._$AQ?.(part);
      newPart._$AM = part;
      const oldIsConnected = newPart._$AU;
      const nextIsConnected = part._$AU;
      if (oldIsConnected !== nextIsConnected && newPart._$AP !== undefined) {
        newPart._$AP(nextIsConnected);
      }
    }

    if (next !== end || parentChanged) {
      let node = newPart._$AA;
      while (node !== next) {
        const nextNode = node.nextSibling;
        container.insertBefore(node, end);
        node = nextNode;
      }
    }
  }

  return newPart;
};

const setChildPartValue = (part, value, directiveParent = part) =>
  part._$AI(value, directiveParent);

const noChangeSentinel = {};

const setCommittedValue = (part, value = noChangeSentinel) => {
  part._$AH = value;
  return value;
};

const getCommittedValue = (part) => part._$AH;

const removePart = (part) => {
  part._$AR();
  part._$AA.remove();
};

const clearPart = (part) => {
  part._$AR();
};

export {
  TemplateResultType,
  clearPart,
  getCommittedValue,
  getDirectiveClass,
  insertPart,
  isCompiledTemplateResult,
  isDirectiveResult,
  isPrimitive,
  isSingleExpression,
  isTemplateResult,
  removePart,
  setChildPartValue,
  setCommittedValue,
};
