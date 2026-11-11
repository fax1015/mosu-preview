import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPopover } from '../src/ui/popupUI.js';

// Just enough DOM for a popover: the class it toggles, the attributes the
// button reports, and listener capture so a test can fire the events a browser
// would. `contains` only has to answer for the popover's own parts.
const makeElement = (children = []) => {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    contains: (target) => target === element || children.includes(target),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fire(type, event = {}) {
      (listeners.get(type) || []).forEach((listener) => listener({ target: element, ...event }));
    },
    focus() {},
  };
  return element;
};

const setup = () => {
  const documentListeners = new Map();
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
  };
  const inner = makeElement();
  const control = makeElement([inner]);
  const button = makeElement();
  const popover = bindPopover({ control, button, openClass: 'is-open' });
  const isOpen = () => control.classList.contains('is-open');
  control.classList.toggle('is-open', true);
  return {
    control,
    button,
    inner,
    popover,
    isOpen,
    fireDocument(type, event) {
      (documentListeners.get(type) || []).forEach((listener) => listener(event));
    },
    restore() {
      globalThis.document = previousDocument;
    },
  };
};

test('a click on a plain part of the popover does not close it', () => {
  const { control, inner, isOpen, fireDocument, restore } = setup();
  try {
    fireDocument('pointerdown', { target: inner });
    control.fire('focusout', { relatedTarget: null });
    assert.ok(isOpen(), 'focus dropping to the body is not leaving the popover');
  } finally {
    restore();
  }
});

test('a click outside the popover closes it', () => {
  const { isOpen, fireDocument, restore } = setup();
  try {
    const outside = makeElement();
    fireDocument('pointerdown', { target: outside });
    assert.ok(!isOpen());
  } finally {
    restore();
  }
});

test('focus moving to another element outside closes the popover', () => {
  const { control, isOpen, restore } = setup();
  try {
    control.fire('focusout', { relatedTarget: makeElement() });
    assert.ok(!isOpen(), 'tabbing away from the popover still dismisses it');
  } finally {
    restore();
  }
});
