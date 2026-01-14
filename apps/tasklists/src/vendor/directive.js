/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */
const PartType = {
  ATTRIBUTE: 1,
  CHILD: 2,
  PROPERTY: 3,
  BOOLEAN_ATTRIBUTE: 4,
  EVENT: 5,
  ELEMENT: 6,
};

const directive = (fn) => (...values) => ({ _$litDirective$: fn, values });

class Directive {
  constructor(partInfo) {}

  get _$AU() {
    return this._$AM._$AU;
  }

  _$AT(part, parent, attributeIndex) {
    this._$Ct = part;
    this._$AM = parent;
    this._$Ci = attributeIndex;
  }

  _$AS(part, args) {
    return this.update(part, args);
  }

  // eslint-disable-next-line class-methods-use-this
  update(part, args) {
    return this.render(...args);
  }
}

export { Directive, PartType, directive };
