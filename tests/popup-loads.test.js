import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Proves popup.js actually evaluates.
//
// Nothing else in the suite loads it -- it needs a DOM -- so every other test can
// pass against a popup that is dead on arrival. `node --check` does not help: an
// identifier that is referenced but never bound is valid syntax and throws only
// at evaluation, and in an extension that means the CSS renders, nothing
// responds, and the error sits in a devtools console no test ever opens. That
// shipped once, when a range-based deletion removed a function that was still
// referenced.
//
// The stub only has to be good enough to get through module evaluation. Anything
// that fails past that point is this file falling short of a real browser rather
// than a defect, so only a binding error fails the test.
const noop = () => {};

const makeElement = () => ({
  style: { setProperty: noop, removeProperty: noop },
  classList: {
    add: noop, remove: noop, toggle: noop, contains: () => false,
  },
  dataset: {},
  textContent: '',
  value: '',
  hidden: false,
  disabled: false,
  checked: false,
  children: [],
  addEventListener: noop,
  removeEventListener: noop,
  appendChild: noop,
  removeChild: noop,
  remove: noop,
  setAttribute: noop,
  removeAttribute: noop,
  getAttribute: () => null,
  focus: noop,
  blur: noop,
  click: noop,
  scrollIntoView: noop,
  getBoundingClientRect: () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
  }),
  getContext: () => new Proxy({}, {
    get: (_target, prop) => (prop === 'canvas'
      ? { width: 800, height: 600 }
      : (typeof prop === 'string' ? noop : undefined)),
    set: () => true,
  }),
  querySelector: () => makeElement(),
  querySelectorAll: () => [],
  closest: () => null,
  insertAdjacentHTML: noop,
  replaceChildren: noop,
});

const storageArea = {
  get: () => Promise.resolve({}),
  set: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  onChanged: { addListener: noop, removeListener: noop },
};

const installStubs = () => {
  globalThis.window = globalThis;
  globalThis.document = {
    documentElement: makeElement(),
    body: makeElement(),
    head: makeElement(),
    title: '',
    hidden: false,
    visibilityState: 'visible',
    addEventListener: noop,
    removeEventListener: noop,
    createElement: () => makeElement(),
    createDocumentFragment: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getElementById: () => makeElement(),
  };
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.sessionStorage = globalThis.localStorage;
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  globalThis.Audio = class {
    constructor() {
      this.paused = true;
      this.currentTime = 0;
      this.duration = Number.NaN;
      this.playbackRate = 1;
      this.src = '';
      this.preload = '';
      this.volume = 1;
    }

    addEventListener() {}

    removeEventListener() {}

    load() {}

    pause() {}

    play() { return Promise.resolve(); }

    removeAttribute() {}
  };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = noop;
  globalThis.chrome = {
    runtime: {
      id: 'stub',
      getURL: (path) => `chrome-extension://stub/${path}`,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: noop, removeListener: noop },
      lastError: null,
    },
    storage: { sync: storageArea, local: storageArea, onChanged: { addListener: noop } },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      onUpdated: { addListener: noop },
    },
    windows: {
      getCurrent: () => Promise.resolve({}),
      create: () => Promise.resolve({}),
      onRemoved: { addListener: noop },
    },
    action: { setBadgeText: noop },
  };
  globalThis.browser = globalThis.chrome;
  globalThis.caches = {
    open: () => Promise.resolve({
      match: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    }),
  };
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 0, headers: { get: () => null } });
};

test('popup.js evaluates without an unbound reference', async () => {
  installStubs();
  // The popup kicks off async work on load that the stubs cannot satisfy; those
  // rejections are not what this test is about.
  const ignoreRejection = () => {};
  process.on('unhandledRejection', ignoreRejection);

  let failure = null;
  try {
    await import(pathToFileURL(new URL('../src/popup.js', import.meta.url).pathname).href);
  } catch (error) {
    failure = error;
  } finally {
    process.off('unhandledRejection', ignoreRejection);
  }

  if (failure && (failure instanceof ReferenceError || / is not defined/.test(failure.message))) {
    assert.fail(`popup.js throws at evaluation: ${failure.name}: ${failure.message}`);
  }
  // Anything else means the stub ran out of browser, which is fine here.
  assert.ok(true);
});
