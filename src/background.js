import { extractFullBeatmapAudioToPayload } from './audio/fullAudioExtractionCore.js';

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

const handleExtractFullAudio = async (message) => {
  // Abort any in-flight extraction before starting a new one.
  abortActiveExtraction();

  const controller = new AbortController();
  activeExtractionJob = { controller, setId: message?.setId, jobId: message?.jobId };

  try {
    const result = await extractFullBeatmapAudioToPayload({
      setId: message?.setId,
      audioFilename: message?.audioFilename,
      providerOverride: message?.providerOverride,
      signal: controller.signal,
      onTryingSource: (label) => sendTryingSourceToExtension(message?.jobId, label),
      onDownloadProgress: (evt) => sendDownloadProgressToExtension(message?.jobId, evt),
    });
    return result;
  } finally {
    // Clear the active job reference if this is still the active one.
    if (activeExtractionJob?.controller === controller) {
      activeExtractionJob = null;
    }
  }
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

