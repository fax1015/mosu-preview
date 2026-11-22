import test from 'node:test';
import assert from 'node:assert/strict';
import { CleanupRegistry } from '../src/core/cleanup.js';
import { EMBEDDED_MESSAGE_CHANNEL, OSU_ORIGIN } from '../src/core/embeddedPlayer.js';

test('embeddedController opens embedded player once, closes detached window, and surfaces reload hint on missing receiver', async () => {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  const prevWindow = globalThis.window;
  delete globalThis.chrome;

  let windowClosed = 0;
  let detachedClosed = 0;
  const sentMessages = [];
  let shouldFailSend = false;

  globalThis.window = {
    close: () => { windowClosed += 1; },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  globalThis.browser = {
    tabs: {
      query: async (q) => {
        if (q?.url === 'https://osu.ppy.sh/*') {
          return [{ id: 10, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }, { id: 11, url: 'https://osu.ppy.sh/home' }];
        }
        return [{ id: 10, active: true, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }];
      },
      sendMessage: async (tabId, message) => {
        sentMessages.push({ tabId, message });
        if (shouldFailSend) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return message.type === 'mosuEmbeddedClose' ? { ok: true, closed: tabId === 10 } : { ok: true };
      },
      onUpdated: { addListener: () => {} },
    },
  };

  try {
    const { createEmbeddedController } = await import(`../src/ui/embeddedController.js?case=open-${Date.now()}`);
    const state = {
      detachContext: { beatmapId: '123', setId: '55', mode: 0 },
      embedContext: { tabId: 10, tabUrl: 'https://osu.ppy.sh/beatmapsets/55#osu/123' },
      embeddedPlayer: false,
      embeddedCollapsed: false,
      mapData: { mode: 0 },
      currentTimeMs: 12_345,
      isPlaying: true,
      playbackSpeed: 1,
      followEnabled: false,
      followTarget: null,
      followSyncTimer: null,
    };
    const embedButton = { disabled: true };
    const toasts = [];

    const controller = createEmbeddedController({
      state,
      registry: new CleanupRegistry(),
      isEmbedded: false,
      elements: { embedButton, followButton: null },
      addDebugLog: () => {},
      showPopupToast: (msg) => toasts.push(msg),
      loadPreview: async () => {},
      closeDetachedWindowIfOpen: async () => { detachedClosed += 1; return true; },
    });

    // Disabled while the experimental toggle is off.
    controller.updateEmbedButtonState();
    assert.equal(embedButton.disabled, true);
    assert.equal(await controller.openEmbeddedPlayer(), false);

    // Enable the experimental toggle -> button becomes active on osu.ppy.sh.
    state.embeddedPlayer = true;
    controller.updateEmbedButtonState();
    assert.equal(embedButton.disabled, false);

    // Non-osu tab disables the embed button.
    controller.setEmbedContext({ tabId: 2, tabUrl: 'https://example.com/' });
    assert.equal(embedButton.disabled, true);

    // Restore osu tab and open embedded player.
    controller.setEmbedContext({ tabId: 10, tabUrl: 'https://osu.ppy.sh/beatmapsets/55#osu/123' });
    const opened = await controller.openEmbeddedPlayer();
    assert.equal(opened, true);
    assert.equal(detachedClosed, 1);
    assert.equal(windowClosed, 1);
    assert.equal(sentMessages[0].tabId, 10);
    assert.equal(sentMessages[0].message.type, 'mosuEmbeddedOpen');
    assert.equal(sentMessages[0].message.resumeTimeMs, 12_345);
    assert.equal(sentMessages[0].message.resumePaused, false);

    // Closing across osu tabs returns how many tabs actually closed an overlay.
    const closedCount = await controller.closeEmbeddedPlayersOnOsuTabs();
    assert.equal(closedCount, 1);

    // Missing content script fails cleanly with a helpful reload toast.
    shouldFailSend = true;
    const failedOpen = await controller.openEmbeddedPlayer();
    assert.equal(failedOpen, false);
    assert.match(toasts[toasts.length - 1], /Reload the osu! tab/i);
  } finally {
    if (prevBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = prevBrowser;
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('embeddedController iframe bridge follows Turbo/hash URLs, respects pin toggle, and emits snapshots', async () => {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  const prevWindow = globalThis.window;
  const prevParent = globalThis.parent;
  delete globalThis.chrome;

  const messageListeners = [];
  const postedToParent = [];
  const tabUpdatedListeners = [];

  const mockParent = {
    postMessage: (msg, origin) => postedToParent.push({ msg, origin }),
  };

  globalThis.parent = mockParent;
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (type === 'message') messageListeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'message') {
        const idx = messageListeners.indexOf(fn);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }
    },
  };

  globalThis.browser = {
    tabs: {
      getCurrent: async () => ({ id: 42, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }),
      onUpdated: { addListener: (fn) => tabUpdatedListeners.push(fn) },
    },
  };

  const registry = new CleanupRegistry();
  try {
    const { createEmbeddedController } = await import(`../src/ui/embeddedController.js?case=bridge-${Date.now()}`);
    const state = {
      detachContext: { beatmapId: '123', setId: '55', mode: 0 },
      embedContext: { tabId: null, tabUrl: '' },
      embeddedCollapsed: false,
      mapData: { mode: 0 },
      sourceMapData: { mode: 0 },
      currentTimeMs: 45_000,
      isPlaying: true,
      playbackSpeed: 1,
      followEnabled: true,
      followTarget: { beatmapId: '123', mode: 0 },
      followSyncTimer: null,
    };
    const followButton = {
      classList: { toggle() {} },
      setAttribute() {},
      title: '',
    };
    const loaded = [];
    const collapsedEvents = [];

    const controller = createEmbeddedController({
      state,
      registry,
      isEmbedded: true,
      elements: { embedButton: null, followButton },
      addDebugLog: () => {},
      showPopupToast: () => {},
      loadPreview: async (opts) => loaded.push(opts),
      onCollapsedChange: (val) => collapsedEvents.push(val),
    });

    controller.startEmbeddedBridge({ initialFollowEnabled: true });

    // Ready handshake and initial snapshot posted strictly to OSU_ORIGIN.
    assert.ok(postedToParent.some((entry) => entry.origin === OSU_ORIGIN && entry.msg.type === 'ready'));
    assert.ok(postedToParent.some((entry) => entry.origin === OSU_ORIGIN && entry.msg.type === 'playbackSnapshot'));

    const dispatchHost = (data, origin = OSU_ORIGIN, source = mockParent) => {
      for (const listener of messageListeners) {
        listener({ origin, source, data });
      }
    };

    // Untrusted origin is ignored.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true }, 'https://evil.example');
    assert.deepEqual(collapsedEvents, []);

    // Valid collapse message updates state & invokes callback.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true });
    assert.equal(state.embeddedCollapsed, true);
    assert.deepEqual(collapsedEvents, [true]);

    // requestExpand only posts while collapsed.
    assert.equal(controller.requestExpandEmbedded(), true);
    assert.ok(postedToParent.some((entry) => entry.msg.type === 'requestExpand'));

    // Navigating to a non-beatmap osu! page leaves the preview untouched.
    dispatchHost({
      channel: EMBEDDED_MESSAGE_CHANNEL,
      type: 'pageUrlChanged',
      url: 'https://osu.ppy.sh/rankings/osu/performance',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(loaded.length, 0);

    // Navigating to a new beatmap triggers a follow load.
    dispatchHost({
      channel: EMBEDDED_MESSAGE_CHANNEL,
      type: 'pageUrlChanged',
      url: 'https://osu.ppy.sh/beatmapsets/55#osu/999',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].sourceUrlOverride, 'https://osu.ppy.sh/beatmapsets/55#osu/999');

    // Pinning prevents follow switches until unpinned.
    controller.toggleEmbeddedFollowEnabled();
    assert.equal(state.followEnabled, false);
    dispatchHost({
      channel: EMBEDDED_MESSAGE_CHANNEL,
      type: 'pageUrlChanged',
      url: 'https://osu.ppy.sh/beatmapsets/55#osu/777',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(loaded.length, 1);

    // Unpinning catches up immediately to the latest URL.
    controller.toggleEmbeddedFollowEnabled();
    await Promise.resolve();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1].sourceUrlOverride, 'https://osu.ppy.sh/beatmapsets/55#osu/777');

    // requestCloseEmbedded notifies parent shell.
    controller.requestCloseEmbedded();
    assert.ok(postedToParent.some((entry) => entry.msg.type === 'requestClose'));

    controller.disposeEmbeddedBridge();
    assert.equal(messageListeners.length, 0);
  } finally {
    registry.cleanup();
    if (prevBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = prevBrowser;
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevParent === undefined) delete globalThis.parent;
    else globalThis.parent = prevParent;
  }
});

test('content.js mounts Shadow DOM host on documentElement (outside body) and survives Turbo body swap', async () => {
  const fs = await import('node:fs/promises');
  const vm = await import('node:vm');
  const source = await fs.readFile(new URL('../src/content.js', import.meta.url), 'utf8');

  const docListeners = new Map();
  const winListeners = new Map();
  const runtimeListeners = [];
  const postedToIframe = [];
  const sessionStore = new Map();

  const makeNode = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      type: '',
      title: '',
      src: '',
      innerHTML: '',
      textContent: '',
      style: {},
      children: [],
      parentNode: null,
      attributes: new Map(),
      classList: {
        set: new Set(),
        add(...names) { names.forEach((n) => this.set.add(n)); },
        remove(...names) { names.forEach((n) => this.set.delete(n)); },
        toggle(name, force) {
          if (force === undefined) {
            if (this.set.has(name)) this.set.delete(name);
            else this.set.add(name);
          } else if (force) {
            this.set.add(name);
          } else {
            this.set.delete(name);
          }
        },
        contains(name) { return this.set.has(name); },
      },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) ?? null; },
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      remove() {
        if (this.parentNode) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx >= 0) this.parentNode.children.splice(idx, 1);
          this.parentNode = null;
        }
      },
      attachShadow() {
        const shadow = makeNode('shadow-root');
        this.shadowRoot = shadow;
        return shadow;
      },
    };
    if (tag === 'iframe') {
      node.contentWindow = {
        postMessage: (msg, origin) => postedToIframe.push({ msg, origin }),
      };
    }
    return node;
  };

  const htmlEl = makeNode('html');
  const bodyEl = makeNode('body');
  htmlEl.appendChild(bodyEl);

  const mockDocument = {
    documentElement: htmlEl,
    body: bodyEl,
    createElement: (tag) => makeNode(tag),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const mockWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    location: { href: 'https://osu.ppy.sh/beatmapsets/55#osu/123' },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); },
      removeItem: (k) => { sessionStore.delete(k); },
    },
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };

  const mockBrowser = {
    runtime: {
      getURL: (p) => `moz-extension://test-uuid/${p}`,
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };

  const sandbox = {
    globalThis: null,
    window: mockWindow,
    document: mockDocument,
    browser: mockBrowser,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Set,
    JSON,
    Promise,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);

  // Lazy mount: nothing attached to <html> until explicitly opened.
  assert.equal(htmlEl.children.length, 1);
  assert.equal(runtimeListeners.length, 1);

  const openResponse = await new Promise((resolve) => {
    runtimeListeners[0]({
      type: 'mosuEmbeddedOpen',
      beatmapId: '123',
      setId: '55',
      mode: 0,
      resumeTimeMs: 1000,
      resumePaused: false,
    }, {}, resolve);
  });

  assert.equal(openResponse.ok, true);
  // Host is mounted directly on <html> as a sibling of <body>, NOT inside <body>.
  assert.equal(htmlEl.children.length, 2);
  assert.equal(bodyEl.children.length, 0);
  const host = htmlEl.children[1];
  assert.equal(host.id, 'mosu-preview-embedded-host');

  const iframe = host.shadowRoot.children[1].children[1].children[0];
  assert.match(iframe.src, /^moz-extension:\/\/test-uuid\/popup\.html\?embedded=1&beatmapId=123/);

  // Simulate iframe ready handshake + Hotwire Turbo body swap.
  for (const fn of winListeners.get('message') || []) {
    fn({
      source: iframe.contentWindow,
      origin: 'moz-extension://test-uuid',
      data: { channel: EMBEDDED_MESSAGE_CHANNEL, type: 'ready' },
    });
  }

  // Turbo replaces <body>; host on <html> stays untouched and URL update is forwarded.
  const nextBody = makeNode('body');
  htmlEl.children[0] = nextBody;
  mockDocument.body = nextBody;
  mockWindow.location.href = 'https://osu.ppy.sh/beatmapsets/55#osu/456';
  for (const fn of docListeners.get('turbo:load') || []) {
    fn();
  }

  assert.equal(host.parentNode, htmlEl);
  assert.ok(postedToIframe.some((m) => (
    m.origin === 'moz-extension://test-uuid'
    && m.msg.type === 'pageUrlChanged'
    && m.msg.url === 'https://osu.ppy.sh/beatmapsets/55#osu/456'
  )));

  // Closing unmounts cleanly and clears reload-resume storage.
  let closeResponse = null;
  runtimeListeners[0]({ type: 'mosuEmbeddedClose' }, {}, (res) => { closeResponse = res; });
  assert.deepEqual({ ...closeResponse }, { ok: true, closed: true });
  assert.equal(htmlEl.children.length, 1);
});
