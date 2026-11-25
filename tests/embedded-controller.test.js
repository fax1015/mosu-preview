import test from 'node:test';
import assert from 'node:assert/strict';
import { CleanupRegistry } from '../src/core/cleanup.js';
import { EMBEDDED_MESSAGE_CHANNEL, OSU_ORIGIN } from '../src/core/embeddedPlayer.js';

// src/webextension.js takes hold of the extension API object once, when it is
// first imported, so every test here works on this one object, filled in
// afresh for each.
const browserMock = {};
const useBrowser = (api) => {
  for (const key of Object.keys(browserMock)) {
    delete browserMock[key];
  }
  Object.assign(browserMock, api);
  globalThis.browser = browserMock;
};

test('embeddedController opens embedded player once, closes detached window, and surfaces reload hint on missing receiver', async () => {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  const prevWindow = globalThis.window;
  delete globalThis.chrome;

  let windowClosed = 0;
  let detachedClosed = 0;
  const sentMessages = [];
  const injectedScripts = [];
  let failSendCount = 0;
  let shouldFailInject = false;
  let refuseOpenCount = 0;
  let closeQueryGate = null;

  globalThis.window = {
    close: () => { windowClosed += 1; },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  useBrowser({
    scripting: {
      executeScript: async (injection) => {
        injectedScripts.push(injection);
        if (shouldFailInject) {
          throw new Error('Cannot access contents of url');
        }
        return [{ result: true }];
      },
    },
    tabs: {
      query: async (q) => {
        if (q?.url === 'https://osu.ppy.sh/*') {
          if (closeQueryGate) {
            await closeQueryGate;
          }
          return [{ id: 10, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }, { id: 11, url: 'https://osu.ppy.sh/home' }];
        }
        return [{ id: 10, active: true, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }];
      },
      sendMessage: async (tabId, message) => {
        sentMessages.push({ tabId, message });
        if (failSendCount > 0) {
          failSendCount -= 1;
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        if (message.type === 'mosuEmbeddedOpen' && refuseOpenCount > 0) {
          refuseOpenCount -= 1;
          return { ok: false };
        }
        return message.type === 'mosuEmbeddedClose' ? { ok: true, closed: tabId === 10 } : { ok: true };
      },
      onUpdated: { addListener: () => {} },
    },
  });

  try {
    const { createEmbeddedController } = await import(`../src/ui/embeddedController.js?case=open-${Date.now()}`);
    const state = {
      detachContext: { beatmapId: '123', setId: '55', mode: 0 },
      embedContext: { tabId: 10, tabUrl: 'https://osu.ppy.sh/beatmapsets/55#osu/123' },
      embeddedPlayer: false,
      embeddedCollapsed: false,
      mapData: { mode: 0 },
      currentTimeMs: 12_345,
      hasAutoStarted: true,
      isPlaying: true,
      playbackSpeed: 1,
      followEnabled: false,
      followTarget: null,
      followSyncTimer: null,
    };
    const embedButton = { disabled: true };
    const toasts = [];

    let cacheFlushCount = 0;
    const controller = createEmbeddedController({
      state,
      registry: new CleanupRegistry(),
      isEmbedded: false,
      elements: { embedButton, followButton: null },
      addDebugLog: () => {},
      showPopupToast: (msg) => toasts.push(msg),
      loadPreview: async () => {},
      closeDetachedWindowIfOpen: async () => { detachedClosed += 1; return true; },
      flushPendingCacheWrite: async () => { cacheFlushCount += 1; },
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
    assert.equal(cacheFlushCount, 1);

    // Fast click right after the popup loads (before autoplay has run): must NOT
    // carry a spurious paused=1 handoff.
    state.hasAutoStarted = false;
    state.isPlaying = false;
    const fastOpenIndex = sentMessages.length;
    assert.equal(await controller.openEmbeddedPlayer(), true);
    assert.equal(sentMessages[fastOpenIndex].message.resumeTimeMs, -1);
    assert.equal(sentMessages[fastOpenIndex].message.resumePaused, false);

    // Explicit pause after autoplay ran DOES preserve the paused timestamp.
    state.hasAutoStarted = true;
    state.isPlaying = false;
    const pausedOpenIndex = sentMessages.length;
    assert.equal(await controller.openEmbeddedPlayer(), true);
    assert.equal(sentMessages[pausedOpenIndex].message.resumeTimeMs, 12_345);
    assert.equal(sentMessages[pausedOpenIndex].message.resumePaused, true);
    state.isPlaying = true;

    // Closing across osu tabs returns how many tabs actually closed an overlay.
    const closedCount = await controller.closeEmbeddedPlayersOnOsuTabs();
    assert.equal(closedCount, 1);

    // An in-flight startup close sweep finishes before openEmbeddedPlayer sends mosuEmbeddedOpen.
    let releaseClose;
    closeQueryGate = new Promise((resolve) => { releaseClose = resolve; });
    const orderStart = sentMessages.length;
    const closing = controller.closeEmbeddedPlayersOnOsuTabs();
    const opening = controller.openEmbeddedPlayer();
    releaseClose();
    await Promise.all([closing, opening]);
    closeQueryGate = null;
    const types = sentMessages.slice(orderStart).map((entry) => entry.message.type);
    assert.equal(types[types.length - 1], 'mosuEmbeddedOpen');
    assert.ok(types.slice(0, -1).every((t) => t === 'mosuEmbeddedClose'));

    // Missing content script triggers on-demand scripting.executeScript and retries cleanly.
    failSendCount = 1;
    const recoveredOpen = await controller.openEmbeddedPlayer();
    assert.equal(recoveredOpen, true);
    assert.deepEqual(injectedScripts, [{ target: { tabId: 10 }, files: ['src/content.js'] }]);

    // A content script that is there and turns the mount down (a close
    // overtook it) is not injected again: that would change nothing.
    refuseOpenCount = 1;
    const refusedOpen = await controller.openEmbeddedPlayer();
    assert.equal(refusedOpen, false);
    assert.equal(injectedScripts.length, 1, 'no second injection');
    assert.match(toasts[toasts.length - 1], /Could not pin preview/i);

    // If injection itself also fails, surface an error toast without crashing.
    failSendCount = 1;
    shouldFailInject = true;
    const failedOpen = await controller.openEmbeddedPlayer();
    assert.equal(failedOpen, false);
    assert.match(toasts[toasts.length - 1], /Could not pin preview/i);
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
  const runtimeListeners = [];
  // What happened, in order: the runtime listener has to be up before 'ready'.
  const sequence = [];

  const mockParent = {
    postMessage: (msg, origin) => {
      postedToParent.push({ msg, origin });
      sequence.push(`posted:${msg.type}`);
    },
  };
  const removeFrom = (list) => (fn) => {
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
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

  useBrowser({
    runtime: {
      onMessage: {
        addListener: (fn) => {
          runtimeListeners.push(fn);
          sequence.push('runtime-listener');
        },
        removeListener: removeFrom(runtimeListeners),
      },
    },
    tabs: {
      getCurrent: async () => ({ id: 42, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }),
      onUpdated: { addListener: (fn) => tabUpdatedListeners.push(fn), removeListener: removeFrom(tabUpdatedListeners) },
    },
  });
  const MOUNT_ID = 'ab'.repeat(16);
  const TOKEN = 'cd'.repeat(32);

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
      attributes: {},
      classList: { toggle() {} },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      title: '',
    };
    const loaded = [];
    const collapsedEvents = [];
    let closingCalls = 0;

    const controller = createEmbeddedController({
      state,
      registry,
      isEmbedded: true,
      hostMountId: MOUNT_ID,
      elements: { embedButton: null, followButton },
      addDebugLog: () => {},
      showPopupToast: () => {},
      loadPreview: async (opts) => loaded.push(opts),
      onCollapsedChange: (val) => collapsedEvents.push(val),
      onHostClosing: () => {
        closingCalls += 1;
      },
    });

    controller.startEmbeddedBridge({ initialFollowEnabled: true });

    // Ready handshake and initial snapshot posted strictly to OSU_ORIGIN.
    assert.ok(postedToParent.some((entry) => entry.origin === OSU_ORIGIN && entry.msg.type === 'ready'));
    assert.ok(postedToParent.some((entry) => entry.origin === OSU_ORIGIN && entry.msg.type === 'playbackSnapshot'));
    assert.ok(
      sequence.indexOf('runtime-listener') < sequence.indexOf('posted:ready'),
      'listening for the secret before saying ready',
    );
    assert.equal(postedToParent.some((entry) => JSON.stringify(entry.msg).includes(TOKEN)), false);

    // The shell's secret, handed over by extension messaging. Another
    // shell's, or one from outside an osu! page, is not taken.
    const handOver = (message, sender = { url: 'https://osu.ppy.sh/beatmapsets/55' }) => {
      let answer = null;
      for (const listener of runtimeListeners) {
        listener({ type: 'mosuEmbeddedHostToken', ...message }, sender, (response) => { answer = response; });
      }
      return answer;
    };
    assert.equal(handOver({ mount: 'ef'.repeat(16), token: TOKEN }), null, 'another shell');
    assert.equal(handOver({ mount: MOUNT_ID, token: TOKEN }, { url: 'https://evil.example/' }), null);
    assert.equal(handOver({ mount: MOUNT_ID, token: 'short' }), null);

    const dispatchHost = (data, origin = OSU_ORIGIN, source = mockParent) => {
      for (const listener of messageListeners) {
        listener({ origin, source, data: { token: TOKEN, ...data } });
      }
    };

    // Until the secret has arrived, even a message from the shell is not taken.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true });
    assert.deepEqual(collapsedEvents, []);
    assert.deepEqual(handOver({ mount: MOUNT_ID, token: TOKEN }), { ok: true });

    // Untrusted origin is ignored.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true }, 'https://evil.example');
    assert.deepEqual(collapsedEvents, []);

    // The osu! page's own scripts share the shell's origin and can post to
    // this window, but they do not have the secret.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true, token: undefined });
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true, token: 'ee'.repeat(32) });
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true }, OSU_ORIGIN, null);
    assert.deepEqual(collapsedEvents, []);

    // Valid collapse message updates state & invokes callback.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'collapsedChanged', collapsed: true });
    assert.equal(state.embeddedCollapsed, true);
    assert.deepEqual(collapsedEvents, [true]);

    // The shell starting to close stops playback straight away; a page that
    // is not the shell cannot ask for it.
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'closing' }, 'https://evil.example');
    assert.equal(closingCalls, 0);
    dispatchHost({ channel: EMBEDDED_MESSAGE_CHANNEL, type: 'closing' });
    assert.equal(closingCalls, 1);

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
    // Pinned is the state the button shows as on.
    assert.equal(followButton.attributes['aria-pressed'], 'true');
    dispatchHost({
      channel: EMBEDDED_MESSAGE_CHANNEL,
      type: 'pageUrlChanged',
      url: 'https://osu.ppy.sh/beatmapsets/55#osu/777',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(loaded.length, 1);

    // Unpinning catches up immediately to the latest URL.
    controller.toggleEmbeddedFollowEnabled();
    assert.equal(followButton.attributes['aria-pressed'], 'false');
    await Promise.resolve();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1].sourceUrlOverride, 'https://osu.ppy.sh/beatmapsets/55#osu/777');

    // requestCloseEmbedded notifies parent shell.
    controller.requestCloseEmbedded();
    assert.ok(postedToParent.some((entry) => entry.msg.type === 'requestClose'));

    controller.disposeEmbeddedBridge();
    assert.equal(messageListeners.length, 0);
    assert.equal(runtimeListeners.length, 0, 'stops listening for a secret');
    assert.equal(tabUpdatedListeners.length, 0, 'stops watching the tab');
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

  let storedLocalBounds = {};
  let boundsReadGate = null;
  const mockBrowser = {
    runtime: {
      getURL: (p) => `moz-extension://test-uuid/${p}`,
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      // The iframe taking the shell's secret.
      sendMessage: async (message) => (message?.type === 'mosuEmbeddedHostToken' ? { ok: true } : undefined),
    },
    storage: {
      local: {
        get: async () => {
          if (boundsReadGate) {
            await boundsReadGate;
          }
          return { mosuEmbeddedPlayerBoundsV1: storedLocalBounds };
        },
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
    crypto: globalThis.crypto,
    TextEncoder,
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
  // The secret is handed over before anything goes in.
  await new Promise((resolve) => setTimeout(resolve, 0));

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

  // Reopening from the toolbar popup when previously collapsed expands both the
  // shell and the iframe URL (no stale collapsed=1 hiding the playfield).
  storedLocalBounds = { width: 440, height: 443, right: 20, bottom: 72, collapsed: true };
  const reopened = await new Promise((resolve) => {
    runtimeListeners[0]({
      type: 'mosuEmbeddedOpen',
      beatmapId: '123',
      setId: '55',
      mode: 0,
      resumeTimeMs: -1,
      resumePaused: false,
    }, {}, resolve);
  });
  assert.equal(reopened.ok, true);
  const reopenedHost = htmlEl.children[1];
  const reopenedIframe = reopenedHost.shadowRoot.children[1].children[1].children[0];
  assert.doesNotMatch(reopenedIframe.src, /collapsed=1/);
  runtimeListeners[0]({ type: 'mosuEmbeddedClose' }, {}, () => {});
  assert.equal(htmlEl.children.length, 1);

  // A close arriving while mountOverlay is awaiting stored bounds cancels the stale mount.
  let releaseBounds;
  boundsReadGate = new Promise((resolve) => { releaseBounds = resolve; });
  const staleMountPromise = new Promise((resolve) => {
    runtimeListeners[0]({
      type: 'mosuEmbeddedOpen',
      beatmapId: '123',
      setId: '55',
      mode: 0,
    }, {}, resolve);
  });
  runtimeListeners[0]({ type: 'mosuEmbeddedClose' }, {}, () => {});
  releaseBounds();
  boundsReadGate = null;
  const staleMountRes = await staleMountPromise;
  assert.equal(staleMountRes.ok, false);
  assert.equal(htmlEl.children.length, 1);
});
