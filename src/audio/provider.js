import {
  ARCHIVE_DOWNLOAD_SOURCES,
  normalizeProviderOverride,
  computeProviderScore,
} from '../settings.js';
import {
  readResponseArrayBufferLimited,
  readResponseArrayBufferLimitedWithInitialZipProbe,
  responseLooksLikeBeatmapArchiveDownload,
} from './zip.js';

const MAX_ARCHIVE_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 18000;
/** Service-worker fetches plus slow mirrors often exceed 8s; match single-provider ceiling (see de6c36f "better download"). */
const FETCH_TIMEOUT_FAILOVER_MS = 20000;
const FETCH_TIMEOUT_ARCHIVE_BODY_MS = 1000 * 60;
const PROVIDER_FAILURE_COOLDOWN_MS = 1000 * 60 * 3;

const mergeArchiveFetchOptions = (options = {}) => {
  const mergedHeaders = {
    Accept: '*/*',
    Referer: 'https://osu.ppy.sh/',
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
  };
  return {
    cache: 'no-store',
    redirect: 'follow',
    ...options,
    headers: mergedHeaders,
  };
};

const providerStats = {};
const providerCooldowns = {};

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
};

const markProviderFailure = (providerId) => {
  const stats = ensureProviderStats(providerId);
  stats.failures += 1;
  providerCooldowns[providerId] = Date.now() + PROVIDER_FAILURE_COOLDOWN_MS;
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
  if (stats.timedSuccesses <= 0 || stats.totalSuccessMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return stats.totalSuccessMs / stats.timedSuccesses;
};

const getAutoOrderedProviders = (userPriority = []) => {
  const baseOrder = userPriority.length > 0
    ? userPriority.map((id) => getProviderById(id)).filter(Boolean)
    : ARCHIVE_DOWNLOAD_SOURCES;

  const available = baseOrder.filter((source) => !isProviderInCooldown(source.id));
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

  const enabled = enabledPriority
    .map((id) => getProviderById(id))
    .filter((source) => source && !isProviderInCooldown(source.id));

  if (!autoFallback) {
    return enabled.length > 0 ? [enabled[0]] : [];
  }

  if (enabled.length > 0) {
    return enabled;
  }

  // Fallback: all in cooldown, try them anyway
  return enabledPriority.map((id) => getProviderById(id)).filter(Boolean);
};

const combineSignals = (signal, controller) => {
  if (!signal) {
    return controller.signal;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, controller.signal]);
  }
  // Polyfill: forward external abort into our controller.
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

const fetchArrayBufferWithTimeout = async (
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_ARCHIVE_DOWNLOAD_BYTES,
  onBodyProgress,
  externalSignal,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const mergedSignal = combineSignals(externalSignal, controller);

  try {
    const response = await fetch(url, mergeArchiveFetchOptions({
      ...options,
      signal: mergedSignal,
    }));
    const buffer = await readResponseArrayBufferLimited(response, maxBytes, undefined, onBodyProgress);
    return { response, buffer };
  } finally {
    clearTimeout(timer);
  }
};

const fetchBeatmapArchiveAdaptive = async (
  url,
  options,
  headerTimeoutMs,
  bodyProbeDeadlineMs,
  maxBytes,
  onBodyProgress,
  externalSignal,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), headerTimeoutMs);
  const mergedSignal = combineSignals(externalSignal, controller);
  let response;
  try {
    response = await fetch(url, mergeArchiveFetchOptions({
      ...options,
      signal: mergedSignal,
    }));
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore cancel errors from hosts that omit a body stream
    }
    return { response, buffer: new ArrayBuffer(0) };
  }

  if (responseLooksLikeBeatmapArchiveDownload(response)) {
    const buffer = await readResponseArrayBufferLimited(
      response,
      maxBytes,
      FETCH_TIMEOUT_ARCHIVE_BODY_MS,
      onBodyProgress,
    );
    return { response, buffer };
  }

  const buffer = await readResponseArrayBufferLimitedWithInitialZipProbe(
    response,
    maxBytes,
    bodyProbeDeadlineMs,
    FETCH_TIMEOUT_ARCHIVE_BODY_MS,
    onBodyProgress,
  );
  return { response, buffer };
};

const probeArchiveSource = async (source, setId, timeoutMs = Math.min(FETCH_TIMEOUT_MS, 12000)) => {
  const url = source.buildArchiveUrl({ setId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, mergeArchiveFetchOptions({
      method: 'GET',
      credentials: source.credentials || 'omit',
      signal: controller.signal,
    }));

    let firstBytes = '';
    if (response.body) {
      const reader = response.body.getReader();
      const chunk = await reader.read();
      if (!chunk.done && chunk.value instanceof Uint8Array) {
        firstBytes = Array.from(chunk.value.slice(0, 4))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(' ');
      }
      await reader.cancel();
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

const downloadBeatmapArchive = async (
  setId,
  providerOverride = 'auto',
  hooks = {},
  userPriority = [],
  disabledProviders = [],
  autoFallback = true,
) => {
  const { onTryingSource, onDownloadProgress, signal } = hooks;
  const failures = [];
  const sources = getProviderSequenceForDownload(
    providerOverride,
    userPriority,
    disabledProviders,
    autoFallback,
  );
  const fetchTimeoutMs = sources.length > 1 ? FETCH_TIMEOUT_FAILOVER_MS : FETCH_TIMEOUT_MS;

  if (!sources.length) {
    throw new Error('no providers available');
  }

  for (const source of sources) {
    if (signal?.aborted) {
      throw new Error('download cancelled');
    }

    if (providerOverride === 'auto' && isProviderInCooldown(source.id)) {
      continue;
    }

    onTryingSource?.(source.label);

    const reportProgress = createThrottledArchiveProgressReporter(
      onDownloadProgress,
      source.label,
    );

    const requestUrl = source.buildArchiveUrl({ setId });
    const attemptTimeouts = sources.length > 1
      ? [fetchTimeoutMs, Math.min(45000, FETCH_TIMEOUT_ARCHIVE_BODY_MS)]
      : [fetchTimeoutMs, Math.min(fetchTimeoutMs * 2, 90000)];

    let sourceSucceeded = false;

    for (let attemptIndex = 0; attemptIndex < attemptTimeouts.length && !sourceSucceeded; attemptIndex += 1) {
      if (signal?.aborted) {
        throw new Error('download cancelled');
      }

      const attemptTimeoutMs = attemptTimeouts[attemptIndex];

      try {
        const requestStartMs = performance.now();
        const fetchOpts = mergeArchiveFetchOptions({
          method: 'GET',
          credentials: source.credentials || 'omit',
        });
        const { response, buffer } = sources.length > 1
          ? await fetchBeatmapArchiveAdaptive(
            requestUrl,
            fetchOpts,
            attemptTimeoutMs,
            attemptTimeoutMs,
            MAX_ARCHIVE_DOWNLOAD_BYTES,
            reportProgress ?? undefined,
            signal,
          )
          : await fetchArrayBufferWithTimeout(
            requestUrl,
            fetchOpts,
            attemptTimeoutMs,
            MAX_ARCHIVE_DOWNLOAD_BYTES,
            reportProgress ?? undefined,
            signal,
          );

        if (!response.ok) {
          failures.push(`${source.label}:${response.status}${attemptIndex > 0 ? '(retry)' : ''}`);
          if (attemptIndex === attemptTimeouts.length - 1) {
            markProviderFailure(source.id);
          }
          continue;
        }

        const archiveBuffer = buffer;
        const header = new Uint8Array(archiveBuffer.slice(0, 4));
        const isZip = header.length === 4 && header[0] === 0x50 && header[1] === 0x4b;
        if (!isZip) {
          failures.push(`${source.label}:non-zip${attemptIndex > 0 ? '(retry)' : ''}`);
          if (attemptIndex === attemptTimeouts.length - 1) {
            markProviderFailure(source.id);
          }
          continue;
        }

        markProviderSuccess(source.id, performance.now() - requestStartMs);
        return { archiveBuffer, sourceLabel: source.label };
      } catch (error) {
        if (signal?.aborted) {
          throw new Error('download cancelled');
        }
        const isTimeout = error?.name === 'AbortError';
        failures.push(`${source.label}:${isTimeout ? 'timeout' : (error?.message || 'network error')}${attemptIndex > 0 ? '(retry)' : ''}`);
        if (attemptIndex === attemptTimeouts.length - 1) {
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
  downloadBeatmapArchive,
  fetchArrayBufferWithTimeout,
  fetchBeatmapArchiveAdaptive,
  probeArchiveSource,
  providerStats,
  providerCooldowns,
};
