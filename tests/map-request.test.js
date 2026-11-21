import test from 'node:test';
import assert from 'node:assert/strict';

// src/mapRequest.js starts fetching the tab's map as it is evaluated, which is
// the whole reason popup.html loads it ahead of popup.js. So the browser it
// talks to has to be in place before the import, and is shared by every test.
const OSU_FILE = 'osu file format v14\n\n[HitObjects]\n256,192,1000,1,0\n';
const CACHE_KEY = 'mosuPreviewCacheV1';

const browser = {
  tabUrl: 'https://osu.ppy.sh/beatmapsets/123#osu/456',
  session: {},
  fetched: [],
  written: [],
  respond: () => ({ ok: true, status: 200, text: async () => OSU_FILE }),
};

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

globalThis.chrome = {
  runtime: { lastError: null },
  tabs: {
    query: (_query, callback) => callback([{ url: browser.tabUrl }]),
  },
  storage: {
    session: {
      get: (_keys, callback) => callback({ ...browser.session }),
      set: (items, callback) => {
        browser.written.push(items);
        Object.assign(browser.session, items);
        callback();
      },
    },
  },
};
globalThis.fetch = async (url) => {
  browser.fetched.push(url);
  return browser.respond(url);
};

test.after(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
});

const {
  fetchBeatmapFile,
  isCachedPreviewUsable,
  requestBeatmapForLoad,
  takeInitialMapRequest,
} = await import('../src/mapRequest.js');

const reset = () => {
  browser.session = {};
  browser.fetched = [];
  browser.written = [];
  browser.respond = () => ({ ok: true, status: 200, text: async () => OSU_FILE });
};

test('the page\'s map is already being fetched by the time the popup asks for it', async () => {
  // Nothing has asked for anything yet: importing the module was enough.
  const request = takeInitialMapRequest(() => false);
  assert.ok(request, 'a request was started as the module loaded');

  const { info, content } = await request;
  assert.equal(info.valid, true);
  assert.equal(info.beatmapId, '456');
  assert.deepEqual(await content, { osuContent: OSU_FILE, fromCache: false });
  assert.deepEqual(browser.fetched, ['https://osu.ppy.sh/osu/456']);
});

test('the request made as the page loaded is handed over once', () => {
  assert.equal(takeInitialMapRequest(() => false), null);
});

test('a fetched map is kept for the next time the popup opens on it', async () => {
  reset();
  const { content } = await requestBeatmapForLoad({ sourceUrlOverride: 'https://osu.ppy.sh/beatmaps/789' });
  await content;

  assert.equal(browser.written.length, 1);
  const saved = browser.written[0][CACHE_KEY];
  assert.equal(saved.beatmapId, '789');
  assert.equal(saved.osuContent, OSU_FILE);
  assert.equal(isCachedPreviewUsable(saved, '789'), true);
  assert.equal(isCachedPreviewUsable(saved, '790'), false);
});

test('a map in the session cache is used without asking osu.ppy.sh for it', async () => {
  reset();
  browser.session[CACHE_KEY] = {
    version: 1,
    beatmapId: '789',
    savedAt: Date.now(),
    osuContent: OSU_FILE,
  };

  const { content } = await requestBeatmapForLoad({ sourceUrlOverride: 'https://osu.ppy.sh/beatmaps/789' });
  assert.deepEqual(await content, { osuContent: OSU_FILE, fromCache: true });
  assert.deepEqual(browser.fetched, []);
});

test('a cached map that has aged out is fetched again', async () => {
  reset();
  browser.session[CACHE_KEY] = {
    version: 1,
    beatmapId: '789',
    savedAt: Date.now() - (13 * 60 * 60 * 1000),
    osuContent: OSU_FILE,
  };

  const { content } = await requestBeatmapForLoad({ sourceUrlOverride: 'https://osu.ppy.sh/beatmaps/789' });
  assert.equal((await content).fromCache, false);
  assert.deepEqual(browser.fetched, ['https://osu.ppy.sh/osu/789']);
});

test('a load that was superseded does not put its map back in the cache', async () => {
  reset();
  const { content } = await requestBeatmapForLoad({
    sourceUrlOverride: 'https://osu.ppy.sh/beatmaps/789',
    isStaleLoad: () => true,
  });
  await content;
  assert.deepEqual(browser.written, []);
});

test('a page with no map asks for nothing', async () => {
  reset();
  browser.tabUrl = 'https://example.com/';
  const { info, content } = await requestBeatmapForLoad();
  assert.equal(info.valid, false);
  assert.equal(content, null);
  assert.deepEqual(browser.fetched, []);
});

test('a tab whose URL the browser withholds is a page with no map, not an error', async () => {
  reset();
  browser.tabUrl = undefined;
  const { info, content } = await requestBeatmapForLoad();
  assert.equal(info.valid, false);
  assert.equal(content, null);
});

test('a response that is not a beatmap fails the load rather than reaching the parser', async () => {
  reset();
  browser.respond = () => ({ ok: true, status: 200, text: async () => '<html>not a map</html>' });
  const { content } = await requestBeatmapForLoad({ sourceUrlOverride: 'https://osu.ppy.sh/beatmaps/789' });
  await assert.rejects(content, /not a valid \.osu beatmap file/);
  assert.deepEqual(browser.written, []);
});

test('a refused request fails the load with the status it came back with', async () => {
  reset();
  browser.respond = () => ({ ok: false, status: 404, text: async () => '' });
  const { content } = await requestBeatmapForLoad({ sourceUrlOverride: 'https://osu.ppy.sh/beatmaps/789' });
  await assert.rejects(content, /Beatmap request failed \(404\)/);
});

test('fetchBeatmapFile validates beatmapId, accepts case-insensitive [HitObjects], and enforces size cap', async () => {
  reset();
  await assert.rejects(fetchBeatmapFile('../evil'), /Invalid beatmap ID/);
  await assert.rejects(fetchBeatmapFile('0'), /Invalid beatmap ID/);

  browser.respond = () => ({
    ok: true,
    status: 200,
    text: async () => 'osu file format v14\n[hitobjects]\n256,192,1000,1,0\n',
  });
  const text = await fetchBeatmapFile('789');
  assert.match(text, /\[hitobjects\]/i);

  let cancelled = false;
  browser.respond = () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(32 * 1024 * 1024) }),
    body: { cancel: async () => { cancelled = true; } },
  });
  await assert.rejects(fetchBeatmapFile('789'), /exceeds maximum supported size/);
  assert.equal(cancelled, true);
});

test('isCachedPreviewUsable rejects far-future savedAt timestamps', () => {
  const futureEntry = {
    version: 1,
    beatmapId: '789',
    savedAt: Date.now() + (10 * 60 * 1000),
    osuContent: OSU_FILE,
  };
  assert.equal(isCachedPreviewUsable(futureEntry, '789'), false);
});
