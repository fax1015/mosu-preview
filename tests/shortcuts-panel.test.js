// The shortcuts panel against a stand-in DOM: what a chip shows, what a
// keypress does while one is armed, and what is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultKeybindings, normalizeKeybindings } from '../src/core/keybindings.js';

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
      contains: (name) => this.classes.has(name),
    };
    this.hidden = false;
    this.textContent = '';
    this.title = '';
  }

  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }

  get className() { return [...this.classes].join(' '); }

  append(...nodes) { this.children.push(...nodes); }

  replaceChildren(...nodes) { this.children = [...nodes]; }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  fire(type) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; } };
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
    return event;
  }

  find(predicate) {
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (predicate(node)) return node;
      stack.push(...node.children);
    }
    return null;
  }
}

// The module reads `document` when it builds, not when it loads, so the
// stand-in only has to be there by the time a panel is made.
const { createShortcutsPanel } = await import('../src/ui/shortcutsPanel.js');

const setup = ({ keybindings = defaultKeybindings(), persist = async () => true } = {}) => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };

  const listElement = new FakeElement('div');
  const state = { keybindings, capturingShortcutAction: null };
  const saved = [];
  const toasts = [];
  const panel = createShortcutsPanel({
    listElement,
    state,
    persistKeybindings: async (bindings) => {
      saved.push(bindings);
      return persist(bindings);
    },
    showPopupToast: (message) => toasts.push(message),
  });
  panel.render();

  const chip = (actionId) => listElement.find((node) => node.dataset.action === actionId);
  const resetAll = () => listElement.find((node) => node.classes.has('map-preview-shortcut-reset'));
  const key = (name, modifiers = {}) => ({ key: name, ...modifiers });
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });

  return {
    panel, state, saved, toasts, chip, resetAll, key, settle, listElement,
    restore: () => { globalThis.document = previousDocument; },
  };
};

test('every remappable action gets a chip showing its key', () => {
  const { chip, resetAll, restore } = setup();
  try {
    assert.equal(chip('playPause').textContent, 'Space');
    assert.equal(chip('mute').textContent, 'M');
    assert.equal(chip('seekBackward').textContent, '←');
    assert.equal(chip('zoomIn').textContent, '=', 'a binding of several keys shows its first');
    assert.equal(resetAll().hidden, true, 'nothing to reset on the defaults');
  } finally {
    restore();
  }
});

test('clicking a chip arms it, and the next key is bound and saved', async () => {
  const { panel, state, saved, chip, key, settle, restore } = setup();
  try {
    assert.equal(panel.consumeCaptureKey(key('x')), false, 'nothing armed, nothing taken');

    chip('mute').fire('click');
    assert.equal(state.capturingShortcutAction, 'mute');
    assert.equal(chip('mute').textContent, 'Press…');
    assert.equal(panel.isCapturing(), true);

    assert.equal(panel.consumeCaptureKey(key('X')), true);
    await settle();
    assert.equal(state.capturingShortcutAction, null);
    assert.deepEqual(state.keybindings.mute, ['x']);
    assert.equal(chip('mute').textContent, 'X');
    assert.equal(saved.length, 1);
  } finally {
    restore();
  }
});

test('a key taken from another action leaves that one unset and says so', async () => {
  const { panel, state, toasts, chip, key, settle, restore } = setup();
  try {
    chip('mute').fire('click');
    panel.consumeCaptureKey(key('r'));
    await settle();

    assert.deepEqual(state.keybindings.mute, ['r']);
    assert.deepEqual(state.keybindings.restart, []);
    assert.equal(chip('restart').textContent, 'Unset');
    assert.equal(chip('restart').classList.contains('is-unset'), true);
    assert.deepEqual(toasts, ['Restart is now unset']);
  } finally {
    restore();
  }
});

test('Escape, a reserved key and a chord all leave the binding alone', async () => {
  const { panel, state, saved, toasts, chip, key, settle, restore } = setup();
  try {
    chip('mute').fire('click');
    assert.equal(panel.consumeCaptureKey(key('Escape')), true);
    assert.equal(state.capturingShortcutAction, null);

    chip('mute').fire('click');
    assert.equal(panel.consumeCaptureKey(key('Shift')), true, 'a modifier on its own is waited out');
    assert.equal(state.capturingShortcutAction, 'mute');
    assert.equal(panel.consumeCaptureKey(key('5')), true);
    assert.equal(state.capturingShortcutAction, null);

    chip('mute').fire('click');
    assert.equal(panel.consumeCaptureKey(key('k', { ctrlKey: true })), true);
    await settle();

    assert.deepEqual(state.keybindings.mute, ['m']);
    assert.deepEqual(saved, []);
    assert.deepEqual(toasts, ['5 is kept by the preview', 'Shortcuts are single keys']);
  } finally {
    restore();
  }
});

test('right-click puts one action back, and reset all puts them all back', async () => {
  const keybindings = normalizeKeybindings({ mute: ['x'], restart: ['y'] });
  const { state, saved, toasts, chip, resetAll, settle, restore } = setup({ keybindings });
  try {
    assert.equal(resetAll().hidden, false);

    const event = chip('mute').fire('contextmenu');
    assert.equal(event.prevented, true, 'no browser menu over the panel');
    await settle();
    assert.deepEqual(state.keybindings.mute, ['m']);
    assert.deepEqual(state.keybindings.restart, ['y']);

    resetAll().fire('click');
    await settle();
    assert.deepEqual(state.keybindings, defaultKeybindings());
    assert.equal(chip('restart').textContent, 'R');
    assert.equal(resetAll().hidden, true);
    assert.equal(saved.length, 2);
    assert.deepEqual(toasts, ['Shortcuts reset']);
  } finally {
    restore();
  }
});

test('a keymap that cannot be saved is reported rather than lost quietly', async () => {
  const { panel, toasts, chip, key, settle, restore } = setup({
    persist: async () => {
      throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
    },
  });
  try {
    chip('mute').fire('click');
    panel.consumeCaptureKey(key('x'));
    await settle();
    assert.deepEqual(toasts, ['Could not save that shortcut']);
  } finally {
    restore();
  }
});

test('closing the panel disarms a chip left waiting', () => {
  const { panel, state, chip, restore } = setup();
  try {
    assert.equal(panel.dismiss(), false);
    chip('mute').fire('click');
    assert.equal(panel.dismiss(), true);
    assert.equal(state.capturingShortcutAction, null);
    assert.equal(chip('mute').textContent, 'M');
  } finally {
    restore();
  }
});

test('the browser-owned shortcut leads the list and cannot be rebound', () => {
  const { panel, listElement, restore } = setup();
  try {
    panel.setBrowserShortcut('Alt + Shift + O');
    const fixed = listElement.find((node) => node.classes.has('is-fixed') && node.textContent === 'Alt+Shift+O');
    assert.ok(fixed, 'shown the way the browser writes it');
    assert.equal(fixed.tagName, 'SPAN', 'a label, not a button');

    panel.setBrowserShortcut('');
    assert.ok(listElement.find((node) => node.classes.has('is-fixed') && node.textContent === 'Not set'));
  } finally {
    restore();
  }
});
