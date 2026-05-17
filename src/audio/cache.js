import { storageGet, storageSet, hasStorageArea } from '../webextension.js';

const FULL_AUDIO_CACHE_NAME = 'mosuPreviewFullAudioV1';
const FULL_AUDIO_CACHE_MAX_BYTES = 35 * 1024 * 1024;
const FULL_AUDIO_CACHE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
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
        }
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
      const response = await cache.match(key) || (aliases[key] ? await cache.match(aliases[key]) : null);
      if (response?.ok) {
        const cachedAtMs = parseCachedAtMs(response);
        if (cachedAtMs > 0 && (now - cachedAtMs) > FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS) {
          await cache.delete(key);
          continue;
        }
        return await response.blob();
      }
    }
    return null;
  } catch (error) {
    debugFullAudioCache(`cache: read failed (${error?.message || error})`);
    return null;
  }
};

const writeCachedFullAudioBlob = async (setId, audioFilename, blob) => {
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
        },
      }),
    );
    void updateFullAudioCacheAliases(setId, audioFilename);
    void pruneFullAudioCache();
    return true;
  } catch (error) {
    debugFullAudioCache(`cache: write failed (${error?.message || error})`);
    return false;
  }
};

export {
  FULL_AUDIO_CACHE_NAME,
  getAudioMimeType,
  normalizePath,
  getPathBaseName,
  makeFullAudioCacheKey,
  getFullAudioCacheKeyCandidates,
  getFullAudioCacheAliasEntries,
  getPrimaryFullAudioCacheKey,
  getFullAudioCacheUsage,
  clearFullAudioCache,
  pruneFullAudioCache,
  readCachedFullAudioBlob,
  setFullAudioCacheDebugLogger,
  writeCachedFullAudioBlob,
};
