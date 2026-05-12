import { storageGet, storageSet, hasStorageArea } from '../webextension.js';

const FULL_AUDIO_CACHE_NAME = 'mosuPreviewFullAudioV1';
const FULL_AUDIO_CACHE_MAX_BYTES = 35 * 1024 * 1024;
const FULL_AUDIO_CACHE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
const FULL_AUDIO_CACHE_ENTRY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const FULL_AUDIO_CACHE_PRUNE_INTERVAL_MS = 1000 * 60 * 30;
const FULL_AUDIO_CACHE_LAST_PRUNE_KEY = 'fullAudioCacheLastPruneMs';

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

const readLastFullAudioPruneTime = async () => {
  if (!hasStorageArea('local')) {
    return 0;
  }

  try {
    const items = await storageGet('local', [FULL_AUDIO_CACHE_LAST_PRUNE_KEY]);
    const value = Number(items?.[FULL_AUDIO_CACHE_LAST_PRUNE_KEY]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
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
  } catch {
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

        const blob = await response.blob();
        const size = Number.isFinite(blob.size) ? blob.size : 0;
        const cachedAtMs = parseCachedAtMs(response);
        entries.push({ request, size: Math.max(0, size), cachedAtMs });
      } catch {
        // Ignore unreadable entries and keep pruning others.
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
  } catch {
    // Cache cleanup should never block preview loading.
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
    for (const key of getFullAudioCacheKeyCandidates(setId, audioFilename)) {
      const response = await cache.match(key);
      if (response?.ok) {
        return await response.blob();
      }
    }
    return null;
  } catch {
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
    const keys = getFullAudioCacheKeyCandidates(setId, audioFilename);
    for (const key of keys) {
      await cache.put(
        key,
        new Response(blob, {
          headers: {
            'content-type': blob.type || getAudioMimeType(audioFilename),
            'x-mosu-cached-at': String(Date.now()),
          },
        }),
      );
    }
    void pruneFullAudioCache();
    return true;
  } catch {
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
  pruneFullAudioCache,
  readCachedFullAudioBlob,
  writeCachedFullAudioBlob,
};
