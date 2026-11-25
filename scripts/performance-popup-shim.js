// Lightweight in-browser WebExtension + fetch shim injected ONLY into
// /popup-bench.html by the local benchmark server so we can time the real
// popup.html + popup.css + src/mapRequest.js + src/popup.js cold/cached open
// and embedded miniplayer (expanded/collapsed, OKLCH cover palette, wavy bar)
// lifecycles without touching production extension code or external networks.
(() => {
  const params = new URLSearchParams(window.location.search);
  const benchMode = params.get('benchMode') || 'cached';
  const benchMapId = params.get('benchMapId') || '5839914';
  const benchSetId = params.get('benchSetId') || '2400000';
  const benchRunId = params.get('benchRunId') || '';
  const isEmbeddedBench = params.get('embedded') === '1'
    || benchMode === 'miniplayer-expanded'
    || benchMode === 'miniplayer-collapsed';

  const parentWin = window.parent;
  const nowEpoch = () => performance.timeOrigin + performance.now();
  const t0Epoch = Number.isFinite(parentWin?.__MOSU_BENCH_T0_EPOCH__)
    ? parentWin.__MOSU_BENCH_T0_EPOCH__
    : nowEpoch();
  const elapsed = () => Math.max(0, nowEpoch() - t0Epoch);

  const cachedOsuText = parentWin?.__MOSU_BENCH_MAPS__?.[benchMapId] || '';

  // Local textured cover art data URI so the collapsed miniplayer displays real
  // artwork without touching external hosts.
  const MOCK_COVER_DATA_URI = 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27320%27 height=%27180%27 viewBox=%270 0 320 180%27%3E%3Cdefs%3E%3ClinearGradient id=%27g%27 x1=%270%27 y1=%270%27 x2=%271%27 y2=%271%27%3E%3Cstop offset=%270%25%27 stop-color=%27%236e46ff%27/%3E%3Cstop offset=%2755%25%27 stop-color=%27%23d9538f%27/%3E%3Cstop offset=%27100%25%27 stop-color=%27%23f2b84b%27/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=%27320%27 height=%27180%27 fill=%27url(%23g)%27/%3E%3Ccircle cx=%27225%27 cy=%2772%27 r=%2758%27 fill=%27rgba(255,255,255,0.28)%27/%3E%3Ccircle cx=%2790%27 cy=%27130%27 r=%2770%27 fill=%27rgba(20,14,40,0.35)%27/%3E%3C/svg%3E")';

  // Build a real 32x24 PNG Blob once so `src/ui/miniTheme.js` runs its real
  // fetch -> createImageBitmap -> pixel sampling -> OKLCH palette pipeline offline!
  let thumbBlobPromise = null;
  const getMockThumbBlob = () => {
    if (thumbBlobPromise) return thumbBlobPromise;
    thumbBlobPromise = new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 24;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 32, 24);
        grad.addColorStop(0, '#6e46ff');
        grad.addColorStop(0.55, '#d9538f');
        grad.addColorStop(1, '#f2b84b');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 32, 24);
        canvas.toBlob((blob) => resolve(blob || new Blob([], { type: 'image/png' })), 'image/png');
      } catch {
        resolve(new Blob([], { type: 'image/png' }));
      }
    });
    return thumbBlobPromise;
  };

  const makeStorageArea = (initial = {}) => {
    const store = new Map(Object.entries(initial));
    return {
      get: async (keys) => {
        if (keys == null) return Object.fromEntries(store.entries());
        if (typeof keys === 'string') {
          return store.has(keys) ? { [keys]: store.get(keys) } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) {
            if (store.has(key)) out[key] = store.get(key);
          }
          return out;
        }
        if (typeof keys === 'object') {
          const out = {};
          for (const [key, fallback] of Object.entries(keys)) {
            out[key] = store.has(key) ? store.get(key) : fallback;
          }
          return out;
        }
        return {};
      },
      set: async (items) => {
        if (items && typeof items === 'object') {
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value);
          }
        }
      },
      remove: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) store.delete(key);
      },
      clear: async () => store.clear(),
    };
  };

  const useWarmSessionCache = (
    benchMode === 'cached'
    || benchMode === 'miniplayer-expanded'
    || benchMode === 'miniplayer-collapsed'
  ) && Boolean(cachedOsuText);

  const sessionInitial = useWarmSessionCache
    ? {
      mosuPreviewCacheV1: {
        version: 1,
        beatmapId: benchMapId,
        savedAt: Date.now(),
        osuContent: cachedOsuText,
      },
    }
    : {};

  const syncInitial = {
    autoplay: false,
    enableHitsounds: false,
    embeddedPlayer: true,
    audioVolume: 0.5,
  };

  const tabUrl = benchMode === 'unsupported'
    ? 'https://example.com/'
    : `https://osu.ppy.sh/beatmapsets/${benchSetId}#osu/${benchMapId}`;

  const noop = () => {};
  const eventStub = { addListener: noop, removeListener: noop, hasListener: () => false };

  const browserMock = {
    tabs: {
      query: async () => [{ id: 1, url: tabUrl, active: true, windowId: 1 }],
      getCurrent: async () => ({ id: 1, url: tabUrl, active: true, windowId: 1 }),
      create: async () => ({ id: 2 }),
      update: async () => ({ id: 1 }),
      sendMessage: async () => null,
      onUpdated: eventStub,
      onActivated: eventStub,
    },
    windows: {
      getAll: async () => [],
      getCurrent: async () => ({ id: 1, type: 'normal' }),
      create: async () => ({ id: 2 }),
      update: async () => ({ id: 1 }),
      remove: async () => {},
      onFocusChanged: eventStub,
    },
    storage: {
      sync: makeStorageArea(syncInitial),
      local: makeStorageArea({}),
      session: makeStorageArea(sessionInitial),
      onChanged: eventStub,
    },
    runtime: {
      id: 'mosu-benchmark-harness',
      getURL: (path = '') => `/${String(path).replace(/^\/+/, '')}`,
      sendMessage: async () => ({ ok: false }),
      openOptionsPage: async () => {},
      onMessage: eventStub,
    },
    commands: {
      getAll: async () => [],
    },
  };

  globalThis.browser = browserMock;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : (input?.url || '');
    if (rawUrl.startsWith('https://osu.ppy.sh/osu/')) {
      if (cachedOsuText) {
        return new Response(cachedOsuText, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      return nativeFetch(`/scripts/benchmark-maps/${benchMapId}.osu`, init);
    }
    if (rawUrl.startsWith('https://b.ppy.sh/thumb/')) {
      const blob = await getMockThumbBlob();
      return new Response(blob, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (/^https?:\/\/(osu|b|assets)\.ppy\.sh\//i.test(rawUrl)) {
      return new Response('', { status: 404, statusText: 'Mocked offline in benchmark' });
    }
    return nativeFetch(input, init);
  };

  const marks = {
    domReadyMs: null,
    bootMs: null,
    revealMs: null,
    readyMs: null,
    firstPaintMs: null,
  };
  let finished = false;
  let observer = null;
  let treeObserver = null;

  const replaceExternalMiniCover = (popup) => {
    if (!isEmbeddedBench || !popup) return;
    const current = popup.style.getPropertyValue('--mini-cover-image');
    if (current && current.includes('assets.ppy.sh')) {
      popup.style.setProperty('--mini-cover-image', MOCK_COVER_DATA_URI);
    }
  };

  const postDone = () => {
    const readyMs = marks.readyMs ?? elapsed();
    const domReadyMs = marks.domReadyMs ?? readyMs;
    const bootMs = marks.bootMs ?? domReadyMs;
    const revealMs = marks.revealMs ?? readyMs;
    const totalMs = marks.firstPaintMs ?? elapsed();
    const phases = {
      domCssMs: Math.min(domReadyMs, bootMs),
      jsBootMs: Math.max(0, bootMs - Math.min(domReadyMs, bootMs)),
      revealMs: Math.max(0, revealMs - bootMs),
      parseRenderMs: Math.max(0, readyMs - revealMs),
      paintMs: Math.max(0, totalMs - readyMs),
    };
    parentWin?.postMessage({
      type: 'mosu-popup-bench-done',
      runId: benchRunId,
      mode: benchMode,
      metrics: {
        domReadyMs,
        bootMs,
        revealMs,
        readyMs,
        firstPaintMs: totalMs,
        totalMs,
        phases,
      },
    }, window.location.origin);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    observer?.disconnect();
    treeObserver?.disconnect();

    let posted = false;
    const completePaint = () => {
      if (posted) return;
      posted = true;
      marks.firstPaintMs = elapsed();
      postDone();
    };

    requestAnimationFrame(completePaint);
    setTimeout(completePaint, 250);
  };

  const inspectPopupClasses = (popup) => {
    if (!popup) return;
    replaceExternalMiniCover(popup);
    if (finished) return;
    const isLoading = popup.classList.contains('is-loading');
    const isOpen = popup.classList.contains('is-open');
    if (isLoading && marks.bootMs === null) {
      marks.bootMs = elapsed();
    }
    if (isOpen && marks.revealMs === null) {
      marks.revealMs = elapsed();
      if (marks.bootMs === null) marks.bootMs = marks.revealMs;
    }
    if (isOpen && !isLoading) {
      marks.readyMs = elapsed();
      finish();
    }
  };

  const attachPopupObserver = (popup) => {
    if (!popup || observer || finished) return;
    treeObserver?.disconnect();
    observer = new MutationObserver(() => inspectPopupClasses(popup));
    observer.observe(popup, { attributes: true, attributeFilter: ['class', 'style'] });
    inspectPopupClasses(popup);
  };

  if (document.documentElement) {
    treeObserver = new MutationObserver(() => {
      const popup = document.querySelector('#mapPreviewPopup');
      if (popup) {
        if (marks.domReadyMs === null) marks.domReadyMs = elapsed();
        attachPopupObserver(popup);
      }
    });
    treeObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (marks.domReadyMs === null) marks.domReadyMs = elapsed();
    attachPopupObserver(document.querySelector('#mapPreviewPopup'));
  }, { once: true });

  setTimeout(() => {
    if (!finished) {
      marks.readyMs = marks.readyMs ?? elapsed();
      finish();
    }
  }, 10000);
})();
