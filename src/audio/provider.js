import { normalizeNumericId } from '../core/beatmapUrl.js';
import {
  ARCHIVE_DOWNLOAD_SOURCES,
  normalizeProviderOverride,
  computeProviderScore,
} from '../settings.js';
import {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  readResponseArrayBufferLimited,
  responseLooksLikeBeatmapArchiveDownload,
} from './zip.js';
import { hasStorageArea, storageGet, storageSet } from '../webextension.js';

const FETCH_TIMEOUT_MS = 18000;
/** Service-worker fetches plus slow mirrors often exceed 8s; match single-provider ceiling (see de6c36f "better download"). */
const FETCH_TIMEOUT_FAILOVER_MS = 20000;
// A marathon .osz runs 60-100MB; 60s of body budget could not finish one on a
// typical connection, which showed up as a plain "timeout" on long maps.
const FETCH_TIMEOUT_ARCHIVE_BODY_MS = 1000 * 180;
const PROVIDER_FAILURE_COOLDOWN_MS = 1000 * 60 * 3;
const PROVIDER_STATS_STORAGE_KEY = 'providerStatsV1';
// Version 2 times a success to the response headers. Version 1 timed the whole
// body, so its averages were download durations that grew with archive size, and
// one marathon map was enough to sink the provider that delivered it below every
// provider never tried. Those timings mean something else now and are dropped;
// the success and failure counts are still valid and are kept.
const PROVIDER_STATS_VERSION = 2;

const mergeArchiveFetchOptions = (options = {}) => {
  const mergedHeaders = {
    Accept: '*/*',
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
  };
  return {
    cache: 'no-store',
    redirect: 'follow',
    // No `referrer` here: fetch only takes one on the page's own origin and
    // quietly swaps anything else for the default, so the osu.ppy.sh this used
    // to name was never sent.
    referrerPolicy: 'strict-origin-when-cross-origin',
    ...options,
    headers: mergedHeaders,
  };
};

const providerStats = {};
const providerCooldowns = {};
let providerRuntimeStateLoaded = false;
let providerRuntimeStateLoadPromise = null;
let providerRuntimeStateSaveTimer = null;
// Snapshot of the counters as they were when this realm last synced with
// storage. The popup and the service worker each hold their own copy of this
// module, so persisting requires writing back only our own delta rather than
// overwriting whatever the other realm recorded meanwhile.
let providerStatsBaseline = {};
const locallyTouchedProviderIds = new Set();
const providerTouchGeneration = new Map();
let providerPersistQueue = Promise.resolve();

const bumpProviderTouchGeneration = (providerId) => {
  locallyTouchedProviderIds.add(providerId);
  providerTouchGeneration.set(providerId, (providerTouchGeneration.get(providerId) || 0) + 1);
};

const getProviderById = (providerId) => ARCHIVE_DOWNLOAD_SOURCES.find((source) => source.id === providerId) || null;

const getProviderDisplayName = (providerId) => {
  if (providerId === 'auto') {
    return 'auto';
  }
  return getProviderById(providerId)?.label || providerId;
};

const ensureProviderStats = (providerId) => {
  if (!providerStats[providerId]) {
    providerStats[providerId] = {
      successes: 0,
      failures: 0,
      timedSuccesses: 0,
      totalSuccessMs: 0,
    };
  } else {
    const stats = providerStats[providerId];
    stats.successes = Number(stats.successes) || 0;
    stats.failures = Number(stats.failures) || 0;
    stats.timedSuccesses = Number(stats.timedSuccesses) || 0;
    stats.totalSuccessMs = Number(stats.totalSuccessMs) || 0;
  }
  return providerStats[providerId];
};

const sanitizeProviderStatsRecord = (record = {}) => ({
  successes: Math.max(0, Number(record.successes) || 0),
  failures: Math.max(0, Number(record.failures) || 0),
  timedSuccesses: Math.max(0, Number(record.timedSuccesses) || 0),
  totalSuccessMs: Math.max(0, Number(record.totalSuccessMs) || 0),
});

const readStoredProviderStats = (snapshot) => {
  const stats = snapshot?.stats && typeof snapshot.stats === 'object' ? snapshot.stats : {};
  if (snapshot?.version === PROVIDER_STATS_VERSION) {
    return stats;
  }
  return Object.fromEntries(Object.entries(stats).map(([id, record]) => [id, {
    successes: record?.successes,
    failures: record?.failures,
    timedSuccesses: 0,
    totalSuccessMs: 0,
  }]));
};

const hydrateProviderRuntimeState = (snapshot = {}) => {
  const knownIds = new Set(ARCHIVE_DOWNLOAD_SOURCES.map((source) => source.id));
  Object.keys(providerStats).forEach((id) => {
    delete providerStats[id];
  });
  Object.keys(providerCooldowns).forEach((id) => {
    delete providerCooldowns[id];
  });

  const statsSnapshot = readStoredProviderStats(snapshot);
  Object.entries(statsSnapshot).forEach(([id, record]) => {
    if (knownIds.has(id)) {
      providerStats[id] = sanitizeProviderStatsRecord(record);
    }
  });

  const cooldownSnapshot = snapshot.cooldowns && typeof snapshot.cooldowns === 'object' ? snapshot.cooldowns : {};
  Object.entries(cooldownSnapshot).forEach(([id, cooldownUntil]) => {
    const numeric = Number(cooldownUntil);
    if (knownIds.has(id) && Number.isFinite(numeric) && numeric > Date.now()) {
      providerCooldowns[id] = numeric;
    }
  });

  providerStatsBaseline = cloneProviderStatsMap(providerStats);
  locallyTouchedProviderIds.clear();
  providerTouchGeneration.clear();
};

const cloneProviderStatsMap = (source) => Object.fromEntries(
  Object.entries(source || {}).map(([id, record]) => [id, sanitizeProviderStatsRecord(record)]),
);

const mergeProviderRuntimeState = (storedSnapshot, nowMs = Date.now(), localView = null) => {
  const stored = storedSnapshot && typeof storedSnapshot === 'object' ? storedSnapshot : {};
  // The other realm may still have a version-1 snapshot on disk; its timings
  // must not be merged back in after hydrate dropped them.
  const storedStats = readStoredProviderStats(stored);
  const storedCooldowns = stored.cooldowns && typeof stored.cooldowns === 'object' ? stored.cooldowns : {};
  const localStats = localView?.stats ?? providerStats;
  const baselineStats = localView?.baseline ?? providerStatsBaseline;
  const localCooldowns = localView?.cooldowns ?? providerCooldowns;
  const touchedIds = localView?.touchedIds ?? locallyTouchedProviderIds;

  const stats = {};
  const cooldowns = {};

  for (const source of ARCHIVE_DOWNLOAD_SOURCES) {
    const id = source.id;
    const base = sanitizeProviderStatsRecord(storedStats[id]);
    const local = sanitizeProviderStatsRecord(localStats[id]);
    const baseline = sanitizeProviderStatsRecord(baselineStats[id]);

    const merged = {
      successes: Math.max(0, base.successes + (local.successes - baseline.successes)),
      failures: Math.max(0, base.failures + (local.failures - baseline.failures)),
      timedSuccesses: Math.max(0, base.timedSuccesses + (local.timedSuccesses - baseline.timedSuccesses)),
      totalSuccessMs: Math.max(0, base.totalSuccessMs + (local.totalSuccessMs - baseline.totalSuccessMs)),
    };

    if (merged.successes > 0 || merged.failures > 0 || merged.timedSuccesses > 0 || merged.totalSuccessMs > 0) {
      stats[id] = merged;
    }

    // For providers this realm actually attempted, our view is authoritative —
    // a success clears the cooldown and must not be resurrected from storage.
    const cooldownUntil = Number(
      touchedIds.has(id)
        ? localCooldowns[id]
        : (localCooldowns[id] ?? storedCooldowns[id]),
    );
    if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) {
      cooldowns[id] = cooldownUntil;
    }
  }

  return { version: PROVIDER_STATS_VERSION, savedAt: nowMs, stats, cooldowns };
};

const serializeProviderRuntimeState = () => ({
  version: PROVIDER_STATS_VERSION,
  savedAt: Date.now(),
  stats: Object.fromEntries(
    Object.entries(providerStats).map(([id, record]) => [id, sanitizeProviderStatsRecord(record)]),
  ),
  cooldowns: Object.fromEntries(
    Object.entries(providerCooldowns)
      .filter(([, cooldownUntil]) => Number(cooldownUntil) > Date.now()),
  ),
});

const loadProviderRuntimeState = async () => {
  if (providerRuntimeStateLoaded) {
    return true;
  }
  if (providerRuntimeStateLoadPromise) {
    return providerRuntimeStateLoadPromise;
  }
  providerRuntimeStateLoadPromise = (async () => {
    if (!hasStorageArea('local')) {
      providerRuntimeStateLoaded = true;
      return false;
    }
    try {
      const items = await storageGet('local', [PROVIDER_STATS_STORAGE_KEY]);
      hydrateProviderRuntimeState(items?.[PROVIDER_STATS_STORAGE_KEY]);
      providerRuntimeStateLoaded = true;
      return true;
    } catch {
      providerRuntimeStateLoaded = true;
      return false;
    }
  })();
  return providerRuntimeStateLoadPromise;
};

const persistProviderRuntimeStateOnce = async () => {
  if (!hasStorageArea('local')) {
    return false;
  }
  try {
    // Snapshot local state synchronously before awaiting storage I/O so any
    // mutations that arrive mid-persist remain as an unpersisted delta for the
    // next write instead of being dropped or double-counted.
    const snapshotStats = cloneProviderStatsMap(providerStats);
    const snapshotBaseline = cloneProviderStatsMap(providerStatsBaseline);
    const snapshotCooldowns = { ...providerCooldowns };
    const snapshotTouched = new Set(locallyTouchedProviderIds);
    const snapshotTouchGen = new Map(providerTouchGeneration);

    let stored = null;
    try {
      const items = await storageGet('local', [PROVIDER_STATS_STORAGE_KEY]);
      stored = items?.[PROVIDER_STATS_STORAGE_KEY] ?? null;
    } catch {
      stored = null;
    }

    await storageSet('local', {
      [PROVIDER_STATS_STORAGE_KEY]: mergeProviderRuntimeState(stored, Date.now(), {
        stats: snapshotStats,
        baseline: snapshotBaseline,
        cooldowns: snapshotCooldowns,
        touchedIds: snapshotTouched,
      }),
    });

    // Advance the baseline only to what was actually written, preserving any
    // newer increments that occurred while storage I/O was in flight.
    providerStatsBaseline = snapshotStats;
    for (const id of snapshotTouched) {
      if (providerTouchGeneration.get(id) === snapshotTouchGen.get(id)) {
        locallyTouchedProviderIds.delete(id);
      }
    }
    return true;
  } catch {
    return false;
  }
};

const persistProviderRuntimeState = () => {
  const next = providerPersistQueue.then(persistProviderRuntimeStateOnce, persistProviderRuntimeStateOnce);
  providerPersistQueue = next.catch(() => false);
  return next;
};

const scheduleProviderRuntimeStatePersist = () => {
  if (!hasStorageArea('local')) {
    return;
  }
  if (providerRuntimeStateSaveTimer !== null) {
    clearTimeout(providerRuntimeStateSaveTimer);
  }
  providerRuntimeStateSaveTimer = setTimeout(() => {
    providerRuntimeStateSaveTimer = null;
    void persistProviderRuntimeState();
  }, 500);
};

/**
 * Cancels the pending debounce and writes immediately. The MV3 service worker
 * can be torn down as soon as a download settles, which would otherwise drop
 * the queued 500ms write along with the run's stats.
 */
const flushProviderRuntimeState = async () => {
  if (providerRuntimeStateSaveTimer !== null) {
    clearTimeout(providerRuntimeStateSaveTimer);
    providerRuntimeStateSaveTimer = null;
  }
  return persistProviderRuntimeState();
};

const getProviderCooldownRemainingMs = (providerId) => {
  const cooldownUntil = Number(providerCooldowns[providerId] || 0);
  return Math.max(0, cooldownUntil - Date.now());
};

const isProviderInCooldown = (providerId) => getProviderCooldownRemainingMs(providerId) > 0;

const markProviderSuccess = (providerId, durationMs = NaN) => {
  const stats = ensureProviderStats(providerId);
  stats.successes += 1;
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    stats.timedSuccesses += 1;
    stats.totalSuccessMs += durationMs;
  }
  delete providerCooldowns[providerId];
  bumpProviderTouchGeneration(providerId);
  scheduleProviderRuntimeStatePersist();
};

const markProviderFailure = (providerId) => {
  const stats = ensureProviderStats(providerId);
  stats.failures += 1;
  providerCooldowns[providerId] = Date.now() + PROVIDER_FAILURE_COOLDOWN_MS;
  bumpProviderTouchGeneration(providerId);
  scheduleProviderRuntimeStatePersist();
};

const getProviderReliabilityScore = (providerId) => {
  const stats = ensureProviderStats(providerId);
  const attempts = stats.successes + stats.failures;
  if (attempts <= 0) {
    return 0.5;
  }
  return stats.successes / attempts;
};

const getProviderAverageSuccessMs = (providerId) => {
  const stats = ensureProviderStats(providerId);
  if (stats.timedSuccesses <= 0 || stats.totalSuccessMs < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return stats.totalSuccessMs / stats.timedSuccesses;
};

const getAutoOrderedProviders = (userPriority = [], { ignoreCooldown = false } = {}) => {
  const baseOrder = userPriority.length > 0
    ? userPriority.map((id) => getProviderById(id)).filter(Boolean)
    : ARCHIVE_DOWNLOAD_SOURCES;

  const available = ignoreCooldown
    ? [...baseOrder]
    : baseOrder.filter((source) => !isProviderInCooldown(source.id));
  return available.sort((a, b) => {
    const statsA = ensureProviderStats(a.id);
    const statsB = ensureProviderStats(b.id);
    const idxA = userPriority.indexOf(a.id);
    const idxB = userPriority.indexOf(b.id);

    const scoreA = computeProviderScore(a, statsA, idxA);
    const scoreB = computeProviderScore(b, statsB, idxB);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    const aReliability = getProviderReliabilityScore(a.id);
    const bReliability = getProviderReliabilityScore(b.id);
    if (aReliability !== bReliability) {
      return bReliability - aReliability;
    }

    const aAvgSuccessMs = getProviderAverageSuccessMs(a.id);
    const bAvgSuccessMs = getProviderAverageSuccessMs(b.id);
    if (aAvgSuccessMs !== bAvgSuccessMs) {
      return aAvgSuccessMs - bAvgSuccessMs;
    }

    const aAttempts = statsA.successes + statsA.failures;
    const bAttempts = statsB.successes + statsB.failures;
    if (aAttempts !== bAttempts) {
      return bAttempts - aAttempts;
    }

    if (idxA !== -1 && idxB !== -1) {
      return idxA - idxB;
    }

    return a.rank - b.rank;
  });
};

const createThrottledArchiveProgressReporter = (downstream, providerLabel, {
  throttleMs = 220,
  minByteDelta = 128 * 1024,
} = {}) => {
  if (typeof downstream !== 'function') {
    return null;
  }
  let lastEmit = 0;
  let lastLoaded = -1;

  const flush = ({ loaded, total }) => {
    lastEmit = Date.now();
    lastLoaded = loaded;
    downstream({
      loaded,
      total: typeof total === 'number' ? total : null,
      providerLabel,
    });
  };

  return ({ loaded, total }) => {
    if (!(typeof loaded === 'number' && loaded >= 0)) {
      return;
    }
    const totalNum = typeof total === 'number' && total > 0 ? total : null;
    const done = totalNum !== null && loaded >= totalNum;
    const now = Date.now();
    const firstPulse = lastLoaded < 0;
    const timed = now - lastEmit >= throttleMs;
    const bigStep = loaded - Math.max(lastLoaded, 0) >= minByteDelta;
    if (done || firstPulse || timed || bigStep) {
      flush({
        loaded,
        total: totalNum ?? null,
      });
    }
  };
};

const getProviderSequenceForDownload = (
  providerOverride = 'auto',
  userPriority = [],
  disabledProviders = [],
  autoFallback = true,
) => {
  const normalizedOverride = normalizeProviderOverride(providerOverride);
  if (normalizedOverride !== 'auto') {
    const forced = getProviderById(normalizedOverride);
    return forced ? [forced] : [];
  }

  const allIds = ARCHIVE_DOWNLOAD_SOURCES.map((s) => s.id);
  const normalizedPriority = [...userPriority];
  allIds.forEach((id) => {
    if (!normalizedPriority.includes(id)) {
      normalizedPriority.push(id);
    }
  });

  const enabledPriority = normalizedPriority.filter((id) => !disabledProviders.includes(id));
  if (enabledPriority.length === 0) {
    return [];
  }

  if (!autoFallback) {
    // When auto-fallback is disabled, always stick to the top-ranked enabled
    // provider even while it is in cooldown, rather than failing over to a
    // second provider or returning an empty list.
    const ranked = getAutoOrderedProviders(enabledPriority, { ignoreCooldown: true })
      .filter((source) => source && !disabledProviders.includes(source.id));
    return ranked.length > 0 ? [ranked[0]] : [];
  }

  const enabled = getAutoOrderedProviders(enabledPriority)
    .filter((source) => source && !disabledProviders.includes(source.id));

  if (enabled.length > 0) {
    return enabled;
  }

  // Fallback: all in cooldown, try them anyway
  return enabledPriority.map((id) => getProviderById(id)).filter(Boolean);
};

const ALLOWED_REDIRECT_HOST_SUFFIXES = [
  'catboy.best',
  'osu.direct',
  'nerinyan.moe',
  'sayobot.cn',
  'ppy.sh',
  'cloudflarestorage.com',
  'r2.dev',
  'backblazeb2.com',
  'amazonaws.com',
  'googleusercontent.com',
  'bunnycdn.com',
  'b-cdn.net',
  'cloudfront.net',
  'fastly.net',
];

const isSafeArchiveRedirectUrl = (responseUrl, requestUrl) => {
  if (!responseUrl) {
    return true;
  }
  try {
    const finalUrl = new URL(responseUrl);
    if (finalUrl.protocol !== 'https:') {
      return false;
    }
    const host = finalUrl.hostname.toLowerCase();
    if (
      host === 'localhost'
      || host.endsWith('.localhost')
      || host === '0.0.0.0'
      || host === '::1'
      || host === '[::1]'
      || /^127\./.test(host)
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^169\.254\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    const requestHost = new URL(requestUrl).hostname.toLowerCase();
    if (host === requestHost || host.endsWith(`.${requestHost}`)) {
      return true;
    }
    return ALLOWED_REDIRECT_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
};

const combineSignals = (signal, controller) => {
  if (!signal) {
    return { signal: controller.signal, cleanup: () => {} };
  }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([signal, controller.signal]), cleanup: () => {} };
  }
  // Polyfill: forward external abort into our controller and remove listener on finish.
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => signal.removeEventListener('abort', onAbort),
  };
};

const cancelResponseBody = async (response) => {
  try {
    await response.body?.cancel();
  } catch {
    // Some hosts send no body stream to cancel.
  }
};

/**
 * Fetches one archive. The timeout covers the response headers only: applying
 * it to the body too meant a large archive on a slow connection could never
 * finish -- at 18s a 40MB .osz needs roughly twice that just to transfer -- so
 * the body gets its own, much longer budget.
 *
 * Every body is checked for the ZIP signature on its first bytes, so an HTML
 * error page served with a 200 is dropped there instead of downloaded in full.
 * `zipProbeMs` also limits how long those bytes may take, for a caller with
 * another provider to move on to; a response that announces itself as an
 * archive has earned the full budget either way.
 *
 * @returns {Promise<{ response: Response, buffer: ArrayBuffer, headerLatencyMs: number }>}
 */
const fetchBeatmapArchive = async (url, {
  fetchOptions = {},
  headerTimeoutMs = FETCH_TIMEOUT_MS,
  zipProbeMs = null,
  maxBytes = MAX_ARCHIVE_DOWNLOAD_BYTES,
  onBodyProgress,
  signal,
} = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), headerTimeoutMs);
  const { signal: mergedSignal, cleanup: cleanupSignals } = combineSignals(signal, controller);
  const startedAtMs = performance.now();
  let response;
  try {
    response = await fetch(url, mergeArchiveFetchOptions({
      ...fetchOptions,
      signal: mergedSignal,
    }));
  } finally {
    clearTimeout(timer);
    cleanupSignals();
  }
  const headerLatencyMs = performance.now() - startedAtMs;

  if (!isSafeArchiveRedirectUrl(response?.url, url)) {
    await cancelResponseBody(response);
    throw new Error('Archive redirect target is not allowed.');
  }

  if (!response.ok) {
    await cancelResponseBody(response);
    return { response, buffer: new ArrayBuffer(0), headerLatencyMs };
  }

  const buffer = await readResponseArrayBufferLimited(response, {
    maxBytes,
    bodyBudgetMs: FETCH_TIMEOUT_ARCHIVE_BODY_MS,
    requireZipSignature: true,
    zipProbeMs: responseLooksLikeBeatmapArchiveDownload(response) ? null : zipProbeMs,
    onProgress: onBodyProgress,
  });
  return { response, buffer, headerLatencyMs };
};

const probeArchiveSource = async (source, setId, timeoutMs = Math.min(FETCH_TIMEOUT_MS, 12000)) => {
  const normalizedSetId = normalizeNumericId(setId);
  if (!normalizedSetId) {
    return {
      ok: false,
      status: 0,
      redirected: false,
      finalUrl: '',
      firstBytes: '',
      error: 'invalid beatmapset id',
    };
  }
  const url = source.buildArchiveUrl({ setId: normalizedSetId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, mergeArchiveFetchOptions({
      method: 'GET',
      credentials: source.credentials || 'omit',
      signal: controller.signal,
    }));

    if (!isSafeArchiveRedirectUrl(response?.url, url)) {
      await cancelResponseBody(response);
      return {
        ok: false,
        status: response.status,
        redirected: response.redirected,
        finalUrl: response.url,
        firstBytes: '',
        error: 'disallowed redirect target',
      };
    }

    let firstBytes = '';
    if (response.body) {
      const reader = response.body.getReader();
      try {
        const chunk = await reader.read();
        if (!chunk.done && chunk.value instanceof Uint8Array) {
          firstBytes = Array.from(chunk.value.slice(0, 4))
            .map((value) => value.toString(16).padStart(2, '0'))
            .join(' ');
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock?.();
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      redirected: response.redirected,
      finalUrl: response.url,
      firstBytes,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      redirected: false,
      finalUrl: url,
      firstBytes: '',
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'network error'),
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Downloads a beatmapset archive from the first provider that delivers one.
 *
 * @param {string} setId
 * @param {object} [options]
 * @param {string} [options.providerOverride] A provider id, or 'auto'.
 * @param {string[]} [options.userPriority] Provider ids in the user's order.
 * @param {string[]} [options.disabledProviders]
 * @param {boolean} [options.autoFallback] Whether to move on past the first provider.
 * @param {(label: string) => void} [options.onTryingSource]
 * @param {(progress: object) => void} [options.onDownloadProgress]
 * @param {AbortSignal} [options.signal]
 */
const downloadBeatmapArchive = async (setId, {
  providerOverride = 'auto',
  userPriority = [],
  disabledProviders = [],
  autoFallback = true,
  onTryingSource,
  onDownloadProgress,
  signal,
} = {}) => {
  const normalizedSetId = normalizeNumericId(setId);
  if (!normalizedSetId) {
    throw new Error('Invalid beatmapset ID.');
  }

  await loadProviderRuntimeState();
  const sources = getProviderSequenceForDownload(
    providerOverride,
    userPriority,
    disabledProviders,
    autoFallback,
  );

  if (!sources.length) {
    throw new Error('no providers available');
  }

  try {
    return await attemptProviderSequence(sources, normalizedSetId, { onTryingSource, onDownloadProgress, signal });
  } finally {
    // Persist before the caller (or a service-worker teardown) can drop the
    // debounced write.
    await flushProviderRuntimeState();
  }
};

// A 4xx is the provider's answer -- it does not have this set, or will not
// serve it -- and asking again a moment later gets the same one. Timeouts,
// network errors and 5xx are worth the second, longer attempt.
const isRetryableStatus = (status) => !(status >= 400 && status < 500);

const attemptProviderSequence = async (sources, setId, { onTryingSource, onDownloadProgress, signal }) => {
  const hasFallback = sources.length > 1;
  const fetchTimeoutMs = hasFallback ? FETCH_TIMEOUT_FAILOVER_MS : FETCH_TIMEOUT_MS;
  const attemptTimeouts = hasFallback
    ? [fetchTimeoutMs, Math.min(45000, FETCH_TIMEOUT_ARCHIVE_BODY_MS)]
    : [fetchTimeoutMs, Math.min(fetchTimeoutMs * 2, 90000)];
  const failures = [];

  for (const source of sources) {
    if (signal?.aborted) {
      throw new Error('download cancelled');
    }

    onTryingSource?.(source.label);

    const requestUrl = source.buildArchiveUrl({ setId });
    const fetchOptions = mergeArchiveFetchOptions({
      method: 'GET',
      credentials: source.credentials || 'omit',
    });

    for (let attemptIndex = 0; attemptIndex < attemptTimeouts.length; attemptIndex += 1) {
      if (signal?.aborted) {
        throw new Error('download cancelled');
      }

      const reportProgress = createThrottledArchiveProgressReporter(
        onDownloadProgress,
        source.label,
      );
      const attemptTimeoutMs = attemptTimeouts[attemptIndex];
      const retrySuffix = attemptIndex > 0 ? '(retry)' : '';
      const isLastAttempt = attemptIndex === attemptTimeouts.length - 1;

      try {
        const { response, buffer, headerLatencyMs } = await fetchBeatmapArchive(requestUrl, {
          fetchOptions,
          headerTimeoutMs: attemptTimeoutMs,
          // With another provider to fall back on, one slow to show it is
          // serving an archive is given up on early.
          zipProbeMs: hasFallback ? attemptTimeoutMs : null,
          maxBytes: MAX_ARCHIVE_DOWNLOAD_BYTES,
          onBodyProgress: reportProgress ?? undefined,
          signal,
        });

        if (!response.ok) {
          failures.push(`${source.label}:${response.status}${retrySuffix}`);
          if (isLastAttempt || !isRetryableStatus(response.status)) {
            markProviderFailure(source.id);
            break;
          }
          continue;
        }

        const header = new Uint8Array(buffer.slice(0, 4));
        const isZip = header.length === 4 && header[0] === 0x50 && header[1] === 0x4b;
        if (!isZip) {
          failures.push(`${source.label}:non-zip${retrySuffix}`);
          if (isLastAttempt) {
            markProviderFailure(source.id);
          }
          continue;
        }

        // Time to headers, not to the last byte: the body's length is the
        // archive's size, not the provider's speed, and scoring it against
        // `averageStartupLatency` punished whichever provider served a big map.
        markProviderSuccess(source.id, headerLatencyMs);
        return { archiveBuffer: buffer, sourceLabel: source.label };
      } catch (error) {
        if (signal?.aborted) {
          throw new Error('download cancelled');
        }
        const isTimeout = error?.name === 'AbortError';
        failures.push(`${source.label}:${isTimeout ? 'timeout' : (error?.message || 'network error')}${retrySuffix}`);
        if (isLastAttempt) {
          markProviderFailure(source.id);
        }
      }
    }
  }

  throw new Error(`archive download failed (${failures.join(', ')})`);
};

export {
  FETCH_TIMEOUT_MS,
  FETCH_TIMEOUT_FAILOVER_MS,
  getProviderById,
  getProviderDisplayName,
  ensureProviderStats,
  getProviderCooldownRemainingMs,
  isProviderInCooldown,
  markProviderSuccess,
  markProviderFailure,
  getProviderReliabilityScore,
  getProviderAverageSuccessMs,
  getAutoOrderedProviders,
  getProviderSequenceForDownload,
  loadProviderRuntimeState,
  persistProviderRuntimeState,
  flushProviderRuntimeState,
  mergeProviderRuntimeState,
  downloadBeatmapArchive,
  fetchBeatmapArchive,
  probeArchiveSource,
  providerStats,
  providerCooldowns,
  hydrateProviderRuntimeState,
  serializeProviderRuntimeState,
};
