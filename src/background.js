import { extractFullBeatmapAudioToCache } from './audio/fullAudioExtractionCore.js';

const runtimeApi = globalThis.browser?.runtime ?? globalThis.chrome?.runtime ?? null;
const usesChromeCallbackMessaging = Boolean(globalThis.chrome?.runtime && !globalThis.browser?.runtime);

/** Tracks the single active extraction job so we can abort it when a new request arrives. */
let activeExtractionJob = null;

const abortActiveExtraction = () => {
  if (activeExtractionJob) {
    activeExtractionJob.controller.abort();
    activeExtractionJob = null;
  }
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

const getExtractionRequestKey = (message) => (
  `${String(message?.setId ?? '')}:${String(message?.audioFilename ?? '').trim().toLowerCase()}`
);

// `extract` is injectable so the coalescing behaviour can be tested without
// reaching the network; production callers always take the default.
const handleExtractFullAudio = async (message, extract = extractFullBeatmapAudioToCache) => {
  const requestKey = getExtractionRequestKey(message);

  // A repeat request for the same track joins the extraction already running
  // rather than restarting it. Two contexts can ask at once now that a preview
  // can be detached into its own window, and the old abort-then-restart turned
  // that into a cancelled transfer plus a duplicate download: the aborted caller
  // saw a failure and retried the same archive itself.
  if (activeExtractionJob?.requestKey === requestKey && activeExtractionJob.promise) {
    // Progress is addressed by job id, so the joining caller has to be added as
    // a recipient or its window would sit on a badge that never advances.
    activeExtractionJob.jobIds.add(message?.jobId);
    return activeExtractionJob.promise;
  }

  // Anything else really is superseded, so stop paying for its download.
  abortActiveExtraction();

  const controller = new AbortController();
  const job = {
    controller,
    requestKey,
    setId: message?.setId,
    jobIds: new Set([message?.jobId]),
    promise: null,
  };
  activeExtractionJob = job;

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
        onTryingSource: (label) => job.jobIds.forEach((id) => sendTryingSourceToExtension(id, label)),
        onDownloadProgress: (evt) => job.jobIds.forEach((id) => sendDownloadProgressToExtension(id, evt)),
      });
    } finally {
      // Clear the active job reference if this is still the active one.
      if (activeExtractionJob === job) {
        activeExtractionJob = null;
      }
    }
  })();

  return job.promise;
};

if (runtimeApi?.onMessage?.addListener) {
  runtimeApi.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'extractFullAudio') {
      return false;
    }
    if (usesChromeCallbackMessaging && typeof sendResponse === 'function') {
      handleExtractFullAudio(message).then(sendResponse).catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
      return true;
    }
    return handleExtractFullAudio(message);
  });
}

// Exported for tests: the dedupe hinges entirely on two requests for the same
// track producing the same key.
export { getExtractionRequestKey, handleExtractFullAudio, abortActiveExtraction };
