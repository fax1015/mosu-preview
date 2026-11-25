// Finding out which map the popup is for, and fetching its .osu file.
//
// This is its own module, with almost nothing under it, so that popup.html can
// load it ahead of popup.js: the map is the slowest thing the popup waits for,
// and popup.js cannot run until all of its several dozen modules have arrived.
// Loaded first, this one has the request on its way while they are still
// coming in. popup.js then picks that request up for its first load
// (takeInitialMapRequest), and asks for another for each map after it.
import { hasStorageArea, queryTabs, storageGet, storageSet } from './webextension.js';
import { registry } from './core/cleanup.js';
import { extractBeatmapInfoFromUrl, normalizeNumericId } from './core/beatmapUrl.js';
import { buildBeatmapSourceUrl, readDetachedParams } from './core/detachedWindow.js';
import { readEmbeddedParams } from './core/embeddedPlayer.js';

const CACHE_KEY = 'mosuPreviewCacheV1';
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 12;
const CACHE_FUTURE_SKEW_MS = 60 * 1000;
const BEATMAP_FETCH_TIMEOUT_MS = 15000;
const MAX_OSU_FILE_BYTES = 16 * 1024 * 1024;
const HIT_OBJECTS_SECTION_RE = /\[hitobjects\]/i;
const UTF8_DECODER = new TextDecoder('utf-8');

// Whether this page is the toolbar popup, a detached window, or an embedded
// in-page miniplayer, and for the latter two, the map it was opened on.
const detachedParams = readDetachedParams(globalThis.location?.search || '');
const embeddedParams = readEmbeddedParams(globalThis.location?.search || '');

const queryActiveTab = async () => {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return Array.isArray(tabs) ? tabs[0] : null;
};

const readTextWithLimit = async (response, maxBytes) => {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw new Error('Beatmap file exceeds maximum supported size.');
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('Beatmap file exceeds maximum supported size.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return UTF8_DECODER.decode(combined);
  }

  const text = await response.text();
  if (text.length > maxBytes) {
    throw new Error('Beatmap file exceeds maximum supported size.');
  }
  return text;
};

const fetchBeatmapFile = async (beatmapId) => {
  const normalizedId = normalizeNumericId(beatmapId);
  if (!normalizedId) {
    throw new Error('Invalid beatmap ID.');
  }

  const controller = registry.createAbortController();
  // A .osu file is a few hundred KB at most. Without a deadline a stalled
  // request left "Fetching beatmap" on screen until the popup was closed.
  const timeout = registry.addTimeout(setTimeout(() => controller.abort(), BEATMAP_FETCH_TIMEOUT_MS));
  try {
    const response = await fetch(`https://osu.ppy.sh/osu/${normalizedId}`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Beatmap request failed (${response.status}).`);
    }

    // Reading the body has to stay inside the controller's lifetime, otherwise
    // closing the popup mid-download leaves the read running unaborted.
    const text = await readTextWithLimit(response, MAX_OSU_FILE_BYTES);
    if (!HIT_OBJECTS_SECTION_RE.test(text)) {
      throw new Error('Fetched data is not a valid .osu beatmap file.');
    }

    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('osu.ppy.sh did not answer in time.');
    }
    throw error;
  } finally {
    registry.clearTimeout(timeout);
    registry.releaseAbortController(controller);
  }
};

const readCachedPreview = async () => {
  if (!hasStorageArea('session', 'local')) {
    return null;
  }

  try {
    const items = await storageGet('session', [CACHE_KEY], { fallbackAreaName: 'local' });
    return items?.[CACHE_KEY] || null;
  } catch {
    return null;
  }
};

let cacheWriteInFlight = null;
let queuedCacheWrite = null;

const drainCacheWrite = async (value) => {
  try {
    await storageSet('session', { [CACHE_KEY]: value }, { fallbackAreaName: 'local' });
    return true;
  } catch {
    return false;
  } finally {
    const next = queuedCacheWrite;
    queuedCacheWrite = null;
    if (next !== null) {
      cacheWriteInFlight = drainCacheWrite(next);
    } else {
      cacheWriteInFlight = null;
    }
  }
};

const writeCachedPreview = (value) => {
  if (!hasStorageArea('session', 'local')) {
    return Promise.resolve(false);
  }
  if (cacheWriteInFlight) {
    queuedCacheWrite = value;
    return cacheWriteInFlight;
  }
  cacheWriteInFlight = drainCacheWrite(value);
  return cacheWriteInFlight;
};

const waitForPendingCacheWrite = () => cacheWriteInFlight ?? Promise.resolve(true);

const isCachedPreviewUsable = (cached, beatmapId) => {
  if (
    !cached
    || cached.version !== 1
    || cached.beatmapId !== beatmapId
    || !Number.isFinite(cached.savedAt)
    || typeof cached.osuContent !== 'string'
  ) {
    return false;
  }
  const ageMs = Date.now() - cached.savedAt;
  return (
    ageMs >= -CACHE_FUTURE_SKEW_MS
    && ageMs <= CACHE_MAX_AGE_MS
    && HIT_OBJECTS_SECTION_RE.test(cached.osuContent)
  );
};

// The .osu file for a beatmap page, from the session cache when it holds this
// map and from osu.ppy.sh otherwise.
const loadBeatmapContent = async (info, cachedRequest, isStaleLoad) => {
  const cached = await cachedRequest;
  if (isCachedPreviewUsable(cached, info.beatmapId)) {
    return { osuContent: cached.osuContent, fromCache: true };
  }

  const osuContent = await fetchBeatmapFile(info.beatmapId);
  // A superseded load must not put its map back over the newer one's. Not
  // waited for: nothing in this load reads it back.
  if (!isStaleLoad()) {
    void writeCachedPreview({
      version: 1,
      beatmapId: info.beatmapId,
      sourceUrl: info.sourceUrl,
      savedAt: Date.now(),
      osuContent,
    });
  }
  return { osuContent, fromCache: false };
};

/**
 * Works out which map a load is for and starts fetching it. That needs nothing
 * but the tab's URL, so a load asks for it at its very start, alongside the
 * settings reads, rather than after them.
 *
 * `isStaleLoad` says whether a newer load has since replaced this one.
 *
 * Resolves to the URL's beatmap info and, for a beatmap page, a promise of its
 * .osu file. A failure of either is handled where the load awaits it.
 */
const requestBeatmapForLoad = ({ sourceUrlOverride = '', isStaleLoad = () => false } = {}) => {
  // Read alongside the tab query rather than after it: which map the cache
  // holds does not depend on which one the tab is showing. readCachedPreview
  // never rejects.
  const cachedRequest = readCachedPreview();
  const request = (async () => {
    let sourceUrl = '';
    let activeTab = null;
    if (sourceUrlOverride) {
      // A followed tab already resolved to a beatmap URL.
      sourceUrl = sourceUrlOverride;
    } else if (detachedParams.isDetached) {
      // The ids arrived in the page URL; rebuilding a canonical beatmap URL from
      // them keeps both entry points on the same validation path.
      sourceUrl = buildBeatmapSourceUrl(detachedParams);
    } else if (embeddedParams.isEmbedded) {
      sourceUrl = embeddedParams.beatmapId
        ? buildBeatmapSourceUrl(embeddedParams)
        : embeddedParams.sourceUrl;
    } else {
      activeTab = await queryActiveTab().catch(() => null);
      // Chrome withholds the URL of tabs it will not let an extension read --
      // the new tab page, chrome:// pages, other extensions' pages. That is
      // not a failed load, it is simply a page with no map: the unsupported
      // view, not the error one.
      sourceUrl = activeTab?.url || '';
    }

    const info = extractBeatmapInfoFromUrl(sourceUrl);
    const content = info.valid ? loadBeatmapContent(info, cachedRequest, isStaleLoad) : null;
    content?.catch(() => {});
    return { info, content, activeTab };
  })();
  request.catch(() => {});
  return request;
};

// The request for the map the page opened on, started as this module loads.
// Whether it has been superseded is only known to the load that takes it.
let isInitialLoadStale = () => false;
let initialRequest = requestBeatmapForLoad({ isStaleLoad: () => isInitialLoadStale() });

/**
 * Hands over the request that was started as the page loaded, once: to the
 * popup's first load. Null after that, and every later load makes its own.
 */
const takeInitialMapRequest = (isStaleLoad) => {
  const request = initialRequest;
  initialRequest = null;
  if (request && typeof isStaleLoad === 'function') {
    isInitialLoadStale = isStaleLoad;
  }
  return request;
};

export {
  BEATMAP_FETCH_TIMEOUT_MS,
  detachedParams,
  embeddedParams,
  fetchBeatmapFile,
  isCachedPreviewUsable,
  queryActiveTab,
  requestBeatmapForLoad,
  takeInitialMapRequest,
  waitForPendingCacheWrite,
};
