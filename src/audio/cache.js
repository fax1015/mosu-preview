import { storageGet, storageSet, hasStorageArea } from '../webextension.js';

const FULL_AUDIO_CACHE_NAME = 'mosuPreviewFullAudioV1';
// Must stay >= MAX_ZIP_AUDIO_ENTRY_BYTES in zip.js, otherwise audio that
// extracts fine cannot be stored and the caller treats the whole run as failed.
const FULL_AUDIO_CACHE_MAX_BYTES = 150 * 1024 * 1024;
const FULL_AUDIO_CACHE_TOTAL_MAX_BYTES = 256 * 1024 * 1024;
const FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const FULL_AUDIO_CACHE_PRUNE_INTERVAL_MS = 1000 * 60 * 30;
const FULL_AUDIO_CACHE_LAST_PRUNE_KEY = 'fullAudioCacheLastPruneMs';
const FULL_AUDIO_CACHE_ALIASES_KEY = 'fullAudioCacheAliasesV1';
let fullAudioCacheDebugLogger = null;

const setFullAudioCacheDebugLogger = (logger) => {
  fullAudioCacheDebugLogger = typeof logger === 'function' ? logger : null;
};

const debugFullAudioCache = (message) => {
  try {
    fullAudioCacheDebugLogger?.(message);
  } catch {
    // Debug logging should never affect cache behavior.
  }
};

// Mapset names live on the cache entry itself rather than being looked up in the
// view history. History is a 20-item recency list while this cache holds several
// times that, so anything past the 20 most recent previews kept its audio but
// lost its name. Storing both together means they are written and evicted as one.
const MAPSET_INFO_HEADERS = Object.freeze({
  title: 'x-mosu-title',
  artist: 'x-mosu-artist',
  creator: 'x-mosu-creator',
});
// Header values are ByteString. Assigning a Japanese title directly throws and
// would fail the whole cache write, so values are percent-encoded to stay ASCII.
const MAPSET_INFO_MAX_FIELD_LENGTH = 200;
const CACHE_KEY_SET_ID_PATTERN = /beatmapsets\/(\d+)\/audio\//;

const encodeMapsetInfoValue = (value) => {
  const text = String(value ?? '').trim().slice(0, MAPSET_INFO_MAX_FIELD_LENGTH);
  return text ? encodeURIComponent(text) : '';
};

const decodeMapsetInfoValue = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape must not cost us the entry it is attached to.
    return '';
  }
};

const buildMapsetInfoHeaders = (mapsetInfo = {}) => {
  const headers = {};
  for (const [field, headerName] of Object.entries(MAPSET_INFO_HEADERS)) {
    const encoded = encodeMapsetInfoValue(mapsetInfo?.[field]);
    if (encoded) {
      headers[headerName] = encoded;
    }
  }
  return headers;
};

const parseCachedMapsetInfo = (response) => {
  const info = { title: '', artist: '', creator: '' };
  for (const [field, headerName] of Object.entries(MAPSET_INFO_HEADERS)) {
    info[field] = decodeMapsetInfoValue(response?.headers?.get?.(headerName));
  }
  return info;
};

const hasMapsetInfo = (info) => Boolean(info?.title || info?.artist || info?.creator);

const getAudioMimeType = (filename) => {
  if (!filename || typeof filename !== 'string') {
    return 'audio/mpeg';
  }
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.opus')) return 'audio/ogg';
  return 'audio/mpeg';
};

const normalizePath = (path) => String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');

const getPathBaseName = (path) => {
  const normalized = normalizePath(path);
  const pieces = normalized.split('/');
  return (pieces[pieces.length - 1] || '').toLowerCase();
};

const makeFullAudioCacheKey = (setId, audioFilename) => {
  const safeSetId = encodeURIComponent(String(setId || '').trim());
  const safeFile = encodeURIComponent(normalizePath(audioFilename).toLowerCase());
  return `https://osu.ppy.sh/beatmapsets/${safeSetId}/audio/${safeFile}`;
};

const getFullAudioCacheKeyCandidates = (setId, audioFilename) => {
  const normalizedSetId = String(setId || '').trim();
  const normalizedPath = normalizePath(audioFilename).toLowerCase();
  if (!normalizedSetId || !normalizedPath) {
    return [];
  }

  const names = [normalizedPath];
  const baseName = getPathBaseName(normalizedPath);
  if (baseName && baseName !== normalizedPath) {
    names.push(baseName);
  }

  return [...new Set(names)].map((name) => makeFullAudioCacheKey(normalizedSetId, name));
};

const getPrimaryFullAudioCacheKey = (setId, audioFilename) => {
  const normalizedSetId = String(setId || '').trim();
  const normalizedPath = normalizePath(audioFilename).toLowerCase();
  if (!normalizedSetId || !normalizedPath) {
    return '';
  }
  return makeFullAudioCacheKey(normalizedSetId, normalizedPath);
};

const getFullAudioCacheAliasEntries = (setId, audioFilename) => {
  const primaryKey = getPrimaryFullAudioCacheKey(setId, audioFilename);
  if (!primaryKey) {
    return [];
  }
  return getFullAudioCacheKeyCandidates(setId, audioFilename)
    .filter((candidateKey) => candidateKey !== primaryKey)
    .map((aliasKey) => [aliasKey, primaryKey]);
};

const readFullAudioCacheAliases = async () => {
  if (!hasStorageArea('local')) {
    return {};
  }
  try {
    const items = await storageGet('local', [FULL_AUDIO_CACHE_ALIASES_KEY]);
    const aliases = items?.[FULL_AUDIO_CACHE_ALIASES_KEY];
    return aliases && typeof aliases === 'object' ? aliases : {};
  } catch (error) {
    debugFullAudioCache(`cache: failed to read aliases (${error?.message || error})`);
    return {};
  }
};

const writeFullAudioCacheAliases = async (aliases) => {
  if (!hasStorageArea('local')) {
    return false;
  }
  try {
    await storageSet('local', { [FULL_AUDIO_CACHE_ALIASES_KEY]: aliases && typeof aliases === 'object' ? aliases : {} });
    return true;
  } catch (error) {
    debugFullAudioCache(`cache: failed to write aliases (${error?.message || error})`);
    return false;
  }
};

// JSON.stringify comparison is key-order sensitive, which caused redundant
// storage writes whenever the map was rebuilt in a different order.
const areAliasMapsEqual = (a, b) => {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
};

const removeFullAudioAliasesForCacheKeys = (aliases, cacheKeys) => {
  const deletedKeys = new Set([...cacheKeys || []].map((key) => String(key || '')));
  if (!aliases || typeof aliases !== 'object' || deletedKeys.size === 0) {
    return aliases && typeof aliases === 'object' ? { ...aliases } : {};
  }

  return Object.fromEntries(
    Object.entries(aliases)
      .filter(([aliasKey, primaryKey]) => !deletedKeys.has(aliasKey) && !deletedKeys.has(primaryKey)),
  );
};

const compactFullAudioAliasesForCacheKeys = (aliases, cacheKeys) => {
  const liveKeys = new Set([...cacheKeys || []].map((key) => String(key || '')));
  if (!aliases || typeof aliases !== 'object' || liveKeys.size === 0) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(aliases)
      .filter(([aliasKey, primaryKey]) => liveKeys.has(aliasKey) || liveKeys.has(primaryKey)),
  );
};

const pruneFullAudioCacheAliasesForDeletedKeys = async (deletedKeys) => {
  if (!hasStorageArea('local') || !deletedKeys || deletedKeys.size === 0) {
    return false;
  }

  const aliases = await readFullAudioCacheAliases();
  const nextAliases = removeFullAudioAliasesForCacheKeys(aliases, deletedKeys);
  if (Object.keys(nextAliases).length === Object.keys(aliases).length) {
    return false;
  }
  return writeFullAudioCacheAliases(nextAliases);
};

const getFullAudioCacheUsage = async () => {
  if (!('caches' in globalThis)) {
    return { bytes: 0, entries: 0 };
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const requests = await cache.keys();
    let bytes = 0;
    let entries = 0;

    for (const request of requests) {
      try {
        const response = await cache.match(request);
        if (!response) {
          continue;
        }
        const cachedSize = parseCachedSizeBytes(response);
        const blob = cachedSize === null ? await response.blob() : null;
        bytes += cachedSize === null
          ? (Number.isFinite(blob?.size) ? blob.size : 0)
          : cachedSize;
        entries += 1;
      } catch (error) {
        debugFullAudioCache(`cache: failed to measure entry (${error?.message || error})`);
      }
    }

    return { bytes, entries };
  } catch (error) {
    debugFullAudioCache(`cache: usage read failed (${error?.message || error})`);
    return { bytes: 0, entries: 0 };
  }
};

const clearFullAudioCache = async () => {
  let clearedCache = false;
  if ('caches' in globalThis) {
    try {
      clearedCache = await caches.delete(FULL_AUDIO_CACHE_NAME);
    } catch (error) {
      debugFullAudioCache(`cache: clear failed (${error?.message || error})`);
    }
  }

  await writeFullAudioCacheAliases({});
  return clearedCache;
};

const updateFullAudioCacheAliases = async (setId, audioFilename) => {
  const aliasEntries = getFullAudioCacheAliasEntries(setId, audioFilename);
  if (aliasEntries.length === 0 || !hasStorageArea('local')) {
    return false;
  }

  const aliases = await readFullAudioCacheAliases();
  for (const [aliasKey, primaryKey] of aliasEntries) {
    aliases[aliasKey] = primaryKey;
  }
  return writeFullAudioCacheAliases(aliases);
};

const readLastFullAudioPruneTime = async () => {
  if (!hasStorageArea('local')) {
    return 0;
  }

  try {
    const items = await storageGet('local', [FULL_AUDIO_CACHE_LAST_PRUNE_KEY]);
    const value = Number(items?.[FULL_AUDIO_CACHE_LAST_PRUNE_KEY]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    debugFullAudioCache(`cache: failed to read prune timestamp (${error?.message || error})`);
    return 0;
  }
};

const writeLastFullAudioPruneTime = async (unixMs) => {
  if (!hasStorageArea('local')) {
    return false;
  }

  try {
    await storageSet('local', { [FULL_AUDIO_CACHE_LAST_PRUNE_KEY]: Math.max(0, Math.floor(unixMs)) });
    return true;
  } catch (error) {
    debugFullAudioCache(`cache: failed to write prune timestamp (${error?.message || error})`);
    return false;
  }
};

const parseCachedAtMs = (response) => {
  const headerValue = response?.headers?.get('x-mosu-cached-at') || '';
  const numeric = Number.parseInt(headerValue, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return 0;
};

const parseCachedSizeBytes = (response) => {
  const headerValue = response?.headers?.get('x-mosu-size') || '';
  const numeric = Number.parseInt(headerValue, 10);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  return null;
};

const pruneFullAudioCache = async ({ force = false } = {}) => {
  if (!('caches' in globalThis)) {
    return;
  }

  const now = Date.now();
  if (!force) {
    const lastPruneAt = await readLastFullAudioPruneTime();
    if (lastPruneAt > 0 && (now - lastPruneAt) < FULL_AUDIO_CACHE_PRUNE_INTERVAL_MS) {
      return;
    }
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const requests = await cache.keys();
    if (!Array.isArray(requests) || requests.length === 0) {
      await writeFullAudioCacheAliases({});
      await writeLastFullAudioPruneTime(now);
      return;
    }

    const entries = [];
    for (const request of requests) {
      try {
        const response = await cache.match(request);
        if (!response) {
          continue;
        }

        const cachedSize = parseCachedSizeBytes(response);
        const blob = cachedSize === null ? await response.blob() : null;
        const size = cachedSize === null
          ? (Number.isFinite(blob?.size) ? blob.size : 0)
          : cachedSize;
        const cachedAtMs = parseCachedAtMs(response);
        entries.push({ request, size: Math.max(0, size), cachedAtMs });
      } catch (error) {
        debugFullAudioCache(`cache: skipped unreadable entry (${error?.message || error})`);
      }
    }

    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);

    const deletedRequests = new Set();
    for (const entry of entries) {
      const isExpired = entry.cachedAtMs > 0 && (now - entry.cachedAtMs) > FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS;
      if (!isExpired) {
        continue;
      }

      if (await cache.delete(entry.request)) {
        totalBytes -= entry.size;
        deletedRequests.add(entry.request.url);
      }
    }

    if (totalBytes > FULL_AUDIO_CACHE_TOTAL_MAX_BYTES) {
      const candidates = entries
        .filter((entry) => !deletedRequests.has(entry.request.url))
        .sort((a, b) => (a.cachedAtMs || 0) - (b.cachedAtMs || 0));

      for (const entry of candidates) {
        if (totalBytes <= FULL_AUDIO_CACHE_TOTAL_MAX_BYTES) {
          break;
        }
        if (await cache.delete(entry.request)) {
          totalBytes -= entry.size;
          deletedRequests.add(entry.request.url);
        }
      }
    }

    if (hasStorageArea('local')) {
      const liveUrls = new Set(
        entries
          .map((entry) => entry.request.url)
          .filter((url) => !deletedRequests.has(url)),
      );
      const aliases = await readFullAudioCacheAliases();
      const aliasesWithoutDeletedKeys = removeFullAudioAliasesForCacheKeys(aliases, deletedRequests);
      const compactAliases = compactFullAudioAliasesForCacheKeys(aliasesWithoutDeletedKeys, liveUrls);
      if (!areAliasMapsEqual(compactAliases, aliases)) {
        await writeFullAudioCacheAliases(compactAliases);
      }
    }
  } catch (error) {
    debugFullAudioCache(`cache: prune failed (${error?.message || error})`);
  } finally {
    await writeLastFullAudioPruneTime(now);
  }
};

const readCachedFullAudioBlob = async (setId, audioFilename) => {
  if (!setId || !audioFilename || !('caches' in globalThis)) {
    return null;
  }
  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const now = Date.now();
    const aliases = await readFullAudioCacheAliases();
    for (const key of getFullAudioCacheKeyCandidates(setId, audioFilename)) {
      let matchedKey = key;
      let response = await cache.match(key);
      if (!response && aliases[key]) {
        matchedKey = aliases[key];
        response = await cache.match(matchedKey);
      }
      if (response?.ok) {
        const cachedAtMs = parseCachedAtMs(response);
        if (cachedAtMs > 0 && (now - cachedAtMs) > FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS) {
          const deletedKeys = new Set([key, matchedKey]);
          await cache.delete(matchedKey);
          await pruneFullAudioCacheAliasesForDeletedKeys(deletedKeys);
          continue;
        }
        return await response.blob();
      } else if (aliases[key]) {
        await pruneFullAudioCacheAliasesForDeletedKeys(new Set([key]));
      }
    }
    return null;
  } catch (error) {
    debugFullAudioCache(`cache: read failed (${error?.message || error})`);
    return null;
  }
};

/**
 * Lists one record per cached mapset, carrying whatever name was stored with it.
 * Entries written before names were cached come back with empty fields, which
 * the caller fills from history where it still has them.
 */
const getCachedMapsetSummaries = async () => {
  if (!('caches' in globalThis)) {
    return [];
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const requests = await cache.keys();
    const summaries = new Map();

    for (const request of requests) {
      const match = request.url.match(CACHE_KEY_SET_ID_PATTERN);
      if (!match) {
        continue;
      }

      const setId = match[1];
      // A set can hold several audio entries; the first one carrying a name wins.
      if (hasMapsetInfo(summaries.get(setId))) {
        continue;
      }

      let info = { title: '', artist: '', creator: '' };
      try {
        const response = await cache.match(request);
        if (response) {
          info = parseCachedMapsetInfo(response);
        }
      } catch (error) {
        // Keep the set listed even when its entry cannot be read: the id alone
        // still renders a usable row.
        debugFullAudioCache(`cache: unreadable summary entry (${error?.message || error})`);
      }

      summaries.set(setId, { setId, ...info });
    }

    return [...summaries.values()];
  } catch (error) {
    debugFullAudioCache(`cache: summary read failed (${error?.message || error})`);
    return [];
  }
};

/**
 * Attaches a name to an entry that predates name caching, reusing the blob that
 * was just read so nothing is re-downloaded. Cache hits are the only chance to
 * upgrade an old entry, since the write path never runs for them.
 */
const ensureCachedMapsetInfo = async (setId, audioFilename, mapsetInfo, blob) => {
  if (!setId || !audioFilename || !blob || !('caches' in globalThis) || !hasMapsetInfo(mapsetInfo)) {
    return false;
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const aliases = await readFullAudioCacheAliases();

    for (const key of getFullAudioCacheKeyCandidates(setId, audioFilename)) {
      const matchedKey = (await cache.match(key)) ? key : (aliases[key] || '');
      if (!matchedKey) {
        continue;
      }

      const response = await cache.match(matchedKey);
      if (!response || hasMapsetInfo(parseCachedMapsetInfo(response))) {
        return false;
      }

      // Preserve the original timestamp: rewriting it would restart the entry's
      // 7-day life and let a revisited map outlive the eviction policy.
      await cache.put(matchedKey, new Response(blob, {
        headers: {
          'content-type': response.headers.get('content-type') || getAudioMimeType(audioFilename),
          'x-mosu-cached-at': response.headers.get('x-mosu-cached-at') || String(Date.now()),
          'x-mosu-size': response.headers.get('x-mosu-size') || String(blob.size),
          ...buildMapsetInfoHeaders(mapsetInfo),
        },
      }));
      debugFullAudioCache(`cache: backfilled mapset name for set ${setId}`);
      return true;
    }
    return false;
  } catch (error) {
    debugFullAudioCache(`cache: name backfill failed (${error?.message || error})`);
    return false;
  }
};

const writeCachedFullAudioBlob = async (setId, audioFilename, blob, mapsetInfo = null) => {
  if (
    !setId
    || !audioFilename
    || !blob
    || !('caches' in globalThis)
    || !Number.isFinite(blob.size)
    || blob.size <= 0
    || blob.size > FULL_AUDIO_CACHE_MAX_BYTES
  ) {
    return false;
  }

  try {
    const cache = await caches.open(FULL_AUDIO_CACHE_NAME);
    const key = getPrimaryFullAudioCacheKey(setId, audioFilename);
    if (!key) {
      return false;
    }
    await cache.put(
      key,
      new Response(blob, {
        headers: {
          'content-type': blob.type || getAudioMimeType(audioFilename),
          'x-mosu-cached-at': String(Date.now()),
          'x-mosu-size': String(blob.size),
          ...buildMapsetInfoHeaders(mapsetInfo),
        },
      }),
    );
    void updateFullAudioCacheAliases(setId, audioFilename);

    // A throttled prune can be up to 30 minutes away, during which the cache
    // would keep growing past its ceiling. Force one as soon as we know we are
    // actually over budget.
    const { bytes } = await getFullAudioCacheUsage();
    void pruneFullAudioCache({ force: bytes > FULL_AUDIO_CACHE_TOTAL_MAX_BYTES });
    return true;
  } catch (error) {
    debugFullAudioCache(`cache: write failed (${error?.message || error})`);
    return false;
  }
};

export {
  FULL_AUDIO_CACHE_NAME,
  MAPSET_INFO_HEADERS,
  buildMapsetInfoHeaders,
  parseCachedMapsetInfo,
  getCachedMapsetSummaries,
  ensureCachedMapsetInfo,
  getAudioMimeType,
  normalizePath,
  getPathBaseName,
  makeFullAudioCacheKey,
  getFullAudioCacheKeyCandidates,
  getFullAudioCacheAliasEntries,
  getPrimaryFullAudioCacheKey,
  removeFullAudioAliasesForCacheKeys,
  compactFullAudioAliasesForCacheKeys,
  getFullAudioCacheUsage,
  clearFullAudioCache,
  pruneFullAudioCache,
  readCachedFullAudioBlob,
  setFullAudioCacheDebugLogger,
  writeCachedFullAudioBlob,
};
