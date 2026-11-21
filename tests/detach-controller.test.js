import test from 'node:test';
import assert from 'node:assert/strict';
import { CleanupRegistry } from '../src/core/cleanup.js';

test('detachController prevents double-spawn via openInFlight lock and preserves Pin toggle (H20)', async () => {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;

  let createdWindows = 0;
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const storage = {};
  const tabListeners = { updated: [], activated: [], focus: [] };

  globalThis.browser = {
    runtime: { getURL: (p) => `moz-extension://id/${p}` },
    storage: {
      session: {
        get: async (keys) => {
          const out = {};
          for (const k of keys) out[k] = storage[k];
          return out;
        },
        set: async (items) => { Object.assign(storage, items); },
      },
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    windows: {
      create: async () => {
        createdWindows += 1;
        await createGate;
        return { id: 99 };
      },
      get: async () => null,
      getCurrent: async () => ({ id: 99 }),
      remove: async () => {},
      update: async () => ({}),
      onFocusChanged: { addListener: (fn) => tabListeners.focus.push(fn) },
    },
    tabs: {
      query: async () => [{ id: 1, active: true, windowId: 10, url: 'https://osu.ppy.sh/beatmapsets/55#osu/123' }],
      onUpdated: { addListener: (fn) => tabListeners.updated.push(fn) },
      onActivated: { addListener: (fn) => tabListeners.activated.push(fn) },
    },
  };

  try {
    const { createDetachController } = await import(`../src/ui/detachController.js?t=${Date.now()}`);
    const state = {
      detachContext: { beatmapId: '123', setId: '55', mode: 0 },
      followEnabled: false,
      followTarget: null,
      followSyncTimer: null,
      detachedWindowId: null,
      lastFocusedBrowsingWindowId: null,
      detachedBoundsTimer: null,
    };
    const followButton = {
      hidden: true,
      classList: { toggle() {} },
      setAttribute() {},
      title: '',
      textContent: '',
    };
    const detachButton = { disabled: false };
    const loadedUrls = [];

    const controller = createDetachController({
      state,
      registry: new CleanupRegistry(),
      elements: { detachButton, followButton },
      addDebugLog: () => {},
      showPopupToast: () => {},
      loadPreview: async ({ sourceUrlOverride }) => { loadedUrls.push(sourceUrlOverride); },
    });

    // Double-click Detach: only ONE window should be created.
    const firstOpen = controller.openDetachedWindow();
    const secondOpen = controller.openDetachedWindow();
    releaseCreate();
    await Promise.all([firstOpen, secondOpen]);
    assert.equal(createdWindows, 1, 'concurrent openDetachedWindow calls must not spawn two windows');

    // User clicks Pin (toggleFollowEnabled) before startFollowingBrowsingTabs: must remain pinned (false).
    state.followEnabled = true;
    controller.toggleFollowEnabled();
    controller.startFollowingBrowsingTabs();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(state.followEnabled, false, 'explicit user Pin toggle must not be overridden');
    assert.equal(state.detachedWindowId, 99, 'own window id read via windows.getCurrent()');
  } finally {
    if (prevBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = prevBrowser;
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});
