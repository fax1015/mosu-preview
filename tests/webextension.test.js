import test from 'node:test';
import assert from 'node:assert/strict';

const importFreshWebExtension = (suffix) => import(`../src/webextension.js?case=${suffix}`);

test('webextension promise API (Firefox) handles storageGet empty fallback and getCommandShortcut rejection', async () => {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;
  const listeners = [];
  globalThis.browser = {
    storage: {
      local: {
        get: async () => undefined,
        set: async () => {},
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => `moz-extension://id/${p}`,
    },
    commands: {
      getAll: async () => { throw new Error('commands unsupported'); },
    },
    tabs: {
      getCurrent: async () => ({ id: 7, url: 'https://osu.ppy.sh/beatmaps/123' }),
      sendMessage: async (tabId, message) => ({ tabId, echoed: message.type }),
    },
    scripting: {
      executeScript: async (injection) => [injection],
    },
  };
  try {
    const ext = await importFreshWebExtension('promise');
    assert.deepEqual(await ext.storageGet('local', ['a']), {});
    assert.equal(await ext.getCommandShortcut('_execute_action'), null);
    assert.equal(ext.getExtensionUrl('popup.html'), 'moz-extension://id/popup.html');
    assert.equal('addTabsRemovedListener' in ext, false, 'dead export removed');
    assert.deepEqual(await ext.getCurrentTab(), { id: 7, url: 'https://osu.ppy.sh/beatmaps/123' });
    assert.deepEqual(await ext.sendTabMessage(7, { type: 'ping' }), { tabId: 7, echoed: 'ping' });
    assert.deepEqual(await ext.executeContentScript(7, ['src/content.js']), [{ target: { tabId: 7 }, files: ['src/content.js'] }]);

    const fn = () => {};
    ext.addRuntimeMessageListener(fn);
    assert.deepEqual(listeners, [fn]);
  } finally {
    if (prevBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = prevBrowser;
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('webextension callback API (Chrome) surfaces runtime.lastError and resolves command shortcuts', async () => {
  const prevBrowser = globalThis.browser;
  const prevChrome = globalThis.chrome;
  delete globalThis.browser;
  let lastError = null;
  globalThis.chrome = {
    runtime: {
      get lastError() { return lastError; },
    },
    storage: {
      local: {
        get: (_keys, cb) => cb({ key: 'val' }),
        set: (_items, cb) => cb(),
      },
    },
    commands: {
      getAll: (cb) => cb([{ name: '_execute_action', shortcut: 'Alt+P' }]),
    },
    tabs: {
      getCurrent: (cb) => cb({ id: 9, url: 'https://osu.ppy.sh/home' }),
      sendMessage: (tabId, message, cb) => cb({ tabId, type: message.type }),
    },
    scripting: {
      executeScript: (injection, cb) => cb([injection]),
    },
  };
  try {
    const ext = await importFreshWebExtension('callback');
    assert.deepEqual(await ext.storageGet('local', ['key']), { key: 'val' });
    assert.equal(await ext.getCommandShortcut('_execute_action'), 'Alt+P');
    assert.deepEqual(await ext.getCurrentTab(), { id: 9, url: 'https://osu.ppy.sh/home' });
    assert.deepEqual(await ext.sendTabMessage(9, { type: 'open' }), { tabId: 9, type: 'open' });
    assert.deepEqual(await ext.executeContentScript(9, ['src/content.js']), [{ target: { tabId: 9 }, files: ['src/content.js'] }]);

    lastError = { message: 'quota error' };
    await assert.rejects(ext.storageSet('local', { key: 'x' }), /quota error/);
    await assert.rejects(ext.sendTabMessage(9, { type: 'open' }), /quota error/);
    await assert.rejects(ext.executeContentScript(9, ['src/content.js']), /quota error/);
    assert.equal(await ext.getCommandShortcut('_execute_action'), null);
  } finally {
    if (prevBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = prevBrowser;
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});
