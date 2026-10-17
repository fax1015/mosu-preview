import { getAudioMimeType, normalizePath, writeCachedFullAudioBlob } from './cache.js';
import { downloadBeatmapArchive } from './provider.js';
import {
  MAX_ZIP_AUDIO_ENTRY_BYTES,
  extractZipEntry,
  findOversizedAudioEntries,
  parseZipEntries,
  pickAudioEntryFromZip,
} from './zip.js';

/**
 * Downloads the beatmap archive and extracts the selected audio entry.
 * Shared by the service worker and popup fallback.
 */
const extractFullBeatmapAudio = async ({
  setId,
  audioFilename,
  providerOverride = 'auto',
  userPriority = [],
  disabledProviders = [],
  autoFallback = true,
  onTryingSource,
  onDownloadProgress,
  signal,
} = {}) => {
  const normalizedSetId = String(setId || '').trim();
  const normalizedAudio = String(audioFilename || '').trim();
  const normalizedOverride = String(providerOverride || 'auto');

  if (!normalizedSetId || !normalizedAudio) {
    return { ok: false, error: 'Invalid full-audio request.' };
  }

  try {
    const { archiveBuffer, sourceLabel } = await downloadBeatmapArchive(
      normalizedSetId,
      normalizedOverride,
      { onTryingSource, onDownloadProgress, signal },
      userPriority,
      disabledProviders,
      autoFallback,
    );
    const archiveBytes = new Uint8Array(archiveBuffer);
    const entries = parseZipEntries(archiveBytes);
    const pickedEntry = pickAudioEntryFromZip(entries, normalizedAudio);
    if (!pickedEntry) {
      // Distinguish "no audio in the archive" from "audio rejected for size",
      // which is what actually happens on marathon maps.
      const oversized = findOversizedAudioEntries(entries);
      if (oversized.length > 0) {
        const largestBytes = Math.max(...oversized.map((entry) => entry.uncompressedSize));
        return {
          ok: false,
          error: `Audio track is too large to preview (${Math.round(largestBytes / (1024 * 1024))} MB, `
            + `limit ${Math.round(MAX_ZIP_AUDIO_ENTRY_BYTES / (1024 * 1024))} MB).`,
        };
      }
      return { ok: false, error: 'Could not find an audio track in beatmap archive.' };
    }

    // extractZipEntry already returns a buffer of its own (a copy for stored
    // entries, the inflate output otherwise), so it is safe to hand straight
    // on. Copying it again here just doubled peak memory on a path that can
    // already be holding a 120MB archive in the service worker.
    const audioBytes = await extractZipEntry(archiveBytes, pickedEntry);
    return {
      ok: true,
      sourceLabel,
      pickedAudioFilename: pickedEntry.name,
      requestedAudioFilename: normalizedAudio,
      normalizedPickedAudioFilename: normalizePath(pickedEntry.name).toLowerCase(),
      normalizedRequestedAudioFilename: normalizePath(normalizedAudio).toLowerCase(),
      mime: getAudioMimeType(pickedEntry.name),
      audioBytes,
    };
  } catch (error) {
    return { ok: false, error: error?.message || 'archive download failed' };
  }
};

const extractFullBeatmapAudioToCache = async (options = {}) => {
  const result = await extractFullBeatmapAudio(options);
  if (!result?.ok) {
    return result;
  }

  const audioBlob = new Blob([result.audioBytes], { type: result.mime || getAudioMimeType(result.pickedAudioFilename) });
  const wroteRequested = await writeCachedFullAudioBlob(
    options.setId,
    result.requestedAudioFilename,
    audioBlob,
    options.mapsetInfo,
  );
  if (!wroteRequested) {
    // The download worked, so this is no verdict on the mirrors: the audio just
    // could not be handed over. A caller with its own copy of the pipeline can
    // still get it by downloading where it can keep the bytes in memory.
    return { ok: false, error: 'Could not write extracted audio to cache.', cacheWriteFailed: true };
  }

  return {
    ok: true,
    sourceLabel: result.sourceLabel,
    pickedAudioFilename: result.pickedAudioFilename,
    requestedAudioFilename: result.requestedAudioFilename,
    normalizedPickedAudioFilename: result.normalizedPickedAudioFilename,
    normalizedRequestedAudioFilename: result.normalizedRequestedAudioFilename,
    mime: result.mime,
    byteLength: result.audioBytes.byteLength,
  };
};

/**
 * Whether the popup should download the archive itself after asking the worker.
 *
 * Only when the worker never answered, or answered that it had the audio but
 * could not cache it. A worker reporting a failed download has already been
 * through every mirror; repeating that sweep from the popup fetched nothing new
 * and roughly doubled the time before the failure was shown.
 */
const shouldRetryExtractionInPopup = (workerResult) => (
  !workerResult
  || typeof workerResult !== 'object'
  || (!workerResult.ok && workerResult.cacheWriteFailed === true)
);

export { extractFullBeatmapAudio, extractFullBeatmapAudioToCache, shouldRetryExtractionInPopup };
