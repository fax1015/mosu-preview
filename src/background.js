import { extractFullBeatmapAudioToCache } from './audio/fullAudioExtractionCore.js';
import { normalizePath } from './audio/cache.js';
import { normalizeNumericId } from './core/beatmapUrl.js';
import {
  normalizeDisabledProviders,
  normalizeProviderOverride,
  normalizeProviderPriority,
} from './settings.js';

const runtimeApi = globalThis.browser?.runtime ?? globalThis.chrome?.runtime ?? null;

/** Active extraction jobs keyed by request key and by requesting context. */
const activeJobsByKey = new Map();
const activeJobByContext = new Map();

const releaseJobFromMaps = (job) => {
  if (activeJobsByKey.get(job.requestKey) === job) {
    activeJobsByKey.delete(job.requestKey);
  }
  for (const ctx of job.contexts) {
    if (activeJobByContext.get(ctx) === job) {
      activeJobByContext.delete(ctx);
    }
  }
};

const detachContextFromJob = (contextKey, keepJob = null) => {
  const previous = activeJobByContext.get(contextKey);
  if (!previous || previous === keepJob) {
    return;
  }
  activeJobByContext.delete(contextKey);
  previous.contexts.delete(contextKey);
  if (previous.contexts.size === 0) {
    releaseJobFromMaps(previous);
    previous.controller.abort();
  }
};

const abortActiveExtraction = () => {
  for (const job of activeJobsByKey.values()) {
    job.controller.abort();
  }
  activeJobsByKey.clear();
  activeJobByContext.clear();
};

const sendTryingSourceToExtension = (jobId, providerLabel) => {
  if (jobId == null || !providerLabel) {
    return;
  }
  try {
    const result = runtimeApi?.sendMessage?.({
      type: 'fullAudioTryingSource',
      jobId,
      providerLabel,
    });
    if (result?.catch) {
      result.catch(() => {});
    }
  } catch {
    // Popup may be closed; ignore.
  }
};

const sendDownloadProgressToExtension = (jobId, payload) => {
  if (jobId == null || !payload) {
    return;
  }
  try {
    const result = runtimeApi?.sendMessage?.({
      type: 'fullAudioDownloadProgress',
      jobId,
      loaded: payload.loaded,
      total: payload.total ?? null,
      providerLabel: payload.providerLabel,
    });
    if (result?.catch) {
      result.catch(() => {});
    }
  } catch {
    // Popup may be closed; ignore.
  }
};

const getExtractionRequestKey = (message) => {
  const rawSetId = String(message?.setId ?? '').trim();
  const normalizedSetId = normalizeNumericId(rawSetId) || rawSetId;
  const normalizedAudio = normalizePath(String(message?.audioFilename ?? '').trim()).toLowerCase();
  const override = normalizeProviderOverride(message?.providerOverride);
  const priority = Array.isArray(message?.providerPriority)
    ? normalizeProviderPriority(message.providerPriority).join(',')
    : '';
  const disabled = Array.isArray(message?.disabledProviders)
    ? normalizeDisabledProviders(message.disabledProviders).sort().join(',')
    : '';
  const autoFallback = message?.autoFallback === false ? '0' : '1';
  return `${normalizedSetId}:${normalizedAudio}|${override}|${priority}|${disabled}|${autoFallback}`;
};

const getSenderContextKey = (sender) => {
  if (sender?.documentId) {
    return `doc:${sender.documentId}`;
  }
  if (sender?.tab?.id != null) {
    return `tab:${sender.tab.id}:${sender.frameId ?? 0}`;
  }
  return 'default';
};

const isAuthorizedSender = (sender) => {
  if (!runtimeApi?.id) {
    return true;
  }
  if (sender?.id && sender.id !== runtimeApi.id) {
    return false;
  }
  if (sender?.url && typeof runtimeApi.getURL === 'function') {
    const extensionBase = runtimeApi.getURL('');
    if (extensionBase && !sender.url.startsWith(extensionBase)) {
      return false;
    }
  }
  return true;
};

const safeSendResponse = (sendResponse, payload) => {
  try {
    sendResponse(payload);
  } catch {
    // Message channel already closed; ignore.
  }
};

// `extract` is injectable so the coalescing behaviour can be tested without
// reaching the network; production callers always take the default.
const handleExtractFullAudio = async (
  message,
  extract = extractFullBeatmapAudioToCache,
  { contextKey = 'default' } = {},
) => {
  const requestKey = getExtractionRequestKey(message);

  // A repeat request for the same track + provider config joins the extraction
  // already running rather than restarting it. Two contexts can ask at once now
  // that a preview can be detached into its own window.
  const existing = activeJobsByKey.get(requestKey);
  if (existing?.promise) {
    detachContextFromJob(contextKey, existing);
    existing.contexts.add(contextKey);
    activeJobByContext.set(contextKey, existing);
    // Progress is addressed by job id, so the joining caller has to be added as
    // a recipient and immediately caught up on the active provider/progress.
    existing.jobIds.add(message?.jobId);
    if (existing.lastProviderLabel) {
      sendTryingSourceToExtension(message?.jobId, existing.lastProviderLabel);
    }
    if (existing.lastProgress) {
      sendDownloadProgressToExtension(message?.jobId, existing.lastProgress);
    }
    return existing.promise;
  }

  // Only supersede the previous download started by THIS context, so a popup
  // and a detached window loading different maps do not cancel each other.
  detachContextFromJob(contextKey);

  const controller = new AbortController();
  const job = {
    controller,
    requestKey,
    setId: message?.setId,
    jobIds: new Set([message?.jobId]),
    contexts: new Set([contextKey]),
    lastProviderLabel: '',
    lastProgress: null,
    promise: null,
  };
  activeJobsByKey.set(requestKey, job);
  activeJobByContext.set(contextKey, job);

  job.promise = (async () => {
    try {
      return await extract({
        setId: message?.setId,
        audioFilename: message?.audioFilename,
        mapsetInfo: message?.mapsetInfo,
        providerOverride: message?.providerOverride,
        userPriority: message?.providerPriority,
        disabledProviders: message?.disabledProviders,
        autoFallback: message?.autoFallback,
        signal: controller.signal,
        onTryingSource: (label) => {
          job.lastProviderLabel = label;
          job.jobIds.forEach((id) => sendTryingSourceToExtension(id, label));
        },
        onDownloadProgress: (evt) => {
          job.lastProgress = evt;
          job.jobIds.forEach((id) => sendDownloadProgressToExtension(id, evt));
        },
      });
    } finally {
      releaseJobFromMaps(job);
    }
  })();

  return job.promise;
};

/**
 * The worker's runtime.onMessage listener. `handle` is injectable so the reply
 * path can be tested without reaching the network.
 *
 * Answered through sendResponse with the channel held open, in every browser.
 * Returning the promise instead is only honoured where the browser supports
 * it, and which browsers do can no longer be told from the namespace: Chrome
 * 148 defines `browser` but is still rolling promise-returning listeners out,
 * and where they are off the reply was dropped -- the popup then downloaded the
 * archive the worker was already downloading. `return true` works in Chrome
 * and Firefox alike.
 */
const createMessageListener = (handle = handleExtractFullAudio) => (message, sender, sendResponse) => {
  if (message?.type !== 'extractFullAudio') {
    return false;
  }
  if (!isAuthorizedSender(sender)) {
    return false;
  }
  const invoke = () => (
    handle === handleExtractFullAudio
      ? handle(message, extractFullBeatmapAudioToCache, { contextKey: getSenderContextKey(sender) })
      : handle(message)
  );
  if (typeof sendResponse !== 'function') {
    return invoke();
  }
  Promise.resolve()
    .then(invoke)
    .then(
      (result) => safeSendResponse(sendResponse, result),
      (err) => safeSendResponse(sendResponse, { ok: false, error: err?.message || String(err) }),
    );
  return true;
};

if (runtimeApi?.onMessage?.addListener) {
  runtimeApi.onMessage.addListener(createMessageListener());
}

// Exported for tests: the dedupe hinges entirely on two requests for the same
// track producing the same key.
export { getExtractionRequestKey, handleExtractFullAudio, abortActiveExtraction, createMessageListener };
