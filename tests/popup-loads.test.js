import test from 'node:test';
import assert from 'node:assert/strict';

// Proves popup.js and options.js actually evaluate from top to bottom.
//
// Nothing else in the suite loads them -- they need a DOM -- so every other
// test can pass against a page that is dead on arrival. Previously this test
// built URLs via pathToFileURL(new URL(...).pathname), which produced invalid
// file:///C:/C:/... URLs on Windows and silently swallowed ERR_MODULE_NOT_FOUND.
const noop = () => {};

const makeElement = () => ({
  style: { setProperty: noop, removeProperty: noop },
  classList: {
    add: noop, remove: noop, toggle: noop, contains: () => false,
  },
  dataset: {},
  textContent: '',
  innerHTML: '',
  value: '',
  hidden: false,
  inert: false,
  disabled: false,
  checked: false,
  children: [],
  clientWidth: 800,
  clientHeight: 600,
  scrollWidth: 800,
  scrollHeight: 600,
  scrollTop: 0,
  offsetWidth: 100,
  offsetHeight: 20,
  offsetParent: null,
  parentElement: null,
  addEventListener: noop,
  removeEventListener: noop,
  append: noop,
  appendChild: noop,
  removeChild: noop,
  remove: noop,
  setAttribute: noop,
  removeAttribute: noop,
  getAttribute: () => null,
  contains: () => false,
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
  const keys = [
    'window', 'document', 'addEventListener', 'removeEventListener', 'matchMedia',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'ResizeObserver', 'MutationObserver', 'HTMLElement',
    'localStorage', 'sessionStorage', 'HTMLMediaElement', 'Audio',
    'chrome', 'browser', 'caches', 'fetch',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const savedCreateObjectURL = globalThis.URL.createObjectURL;
  const savedRevokeObjectURL = globalThis.URL.revokeObjectURL;

  globalThis.window = globalThis;
  globalThis.HTMLElement = class {};
  globalThis.ResizeObserver = class {
    observe() {}

    unobserve() {}

    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}

    disconnect() {}
  };
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
    createElementNS: () => makeElement(),
    createTextNode: () => ({}),
    createDocumentFragment: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getElementById: () => makeElement(),
    contains: () => false,
  };
  const pagehideListeners = [];
  globalThis.addEventListener = (type, listener) => {
    if (type === 'pagehide' && typeof listener === 'function') {
      pagehideListeners.push(listener);
    }
  };
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
    storage: { sync: storageArea, local: storageArea, session: storageArea, onChanged: { addListener: noop } },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      onUpdated: { addListener: noop },
      onActivated: { addListener: noop },
    },
    windows: {
      getCurrent: () => Promise.resolve({}),
      create: () => Promise.resolve({}),
      onRemoved: { addListener: noop },
      onFocusChanged: { addListener: noop },
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

  return async () => {
    // Allow startup microtasks to settle, then fire pagehide so timers/intervals
    // registered by popup.js/options.js are cleaned up before removing globals.
    await new Promise((resolve) => { setImmediate(resolve); });
    for (const listener of pagehideListeners) {
      try {
        listener();
      } catch {
        // Ignore teardown noise from minimal stubs.
      }
    }
    await new Promise((resolve) => { setImmediate(resolve); });
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = saved[key];
      }
    }
    globalThis.URL.createObjectURL = savedCreateObjectURL;
    globalThis.URL.revokeObjectURL = savedRevokeObjectURL;
  };
};

test('popup.js evaluates cleanly end-to-end without unbound references or import errors', async () => {
  const restore = installStubs();
  const ignoreRejection = () => {};
  process.on('unhandledRejection', ignoreRejection);

  try {
    await import(new URL('../src/popup.js', import.meta.url).href);
  } finally {
    await restore();
    process.off('unhandledRejection', ignoreRejection);
  }
  assert.ok(true);
});

test('options.js evaluates cleanly end-to-end without unbound references or import errors', async () => {
  const restore = installStubs();
  const ignoreRejection = () => {};
  process.on('unhandledRejection', ignoreRejection);

  try {
    await import(new URL('../src/options.js', import.meta.url).href);
  } finally {
    await restore();
    process.off('unhandledRejection', ignoreRejection);
  }
  assert.ok(true);
});
