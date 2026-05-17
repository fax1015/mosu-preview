import { getAudioMimeType, normalizePath, writeCachedFullAudioBlob } from './cache.js';
import { downloadBeatmapArchive } from './provider.js';
import { extractZipEntry, parseZipEntries, pickAudioEntryFromZip } from './zip.js';

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
      return { ok: false, error: 'Could not find an audio track in beatmap archive.' };
    }

    const audioBytes = await extractZipEntry(archiveBytes, pickedEntry);
    const standalone = new Uint8Array(audioBytes.byteLength);
    standalone.set(audioBytes);
    return {
      ok: true,
      sourceLabel,
      pickedAudioFilename: pickedEntry.name,
      requestedAudioFilename: normalizedAudio,
      normalizedPickedAudioFilename: normalizePath(pickedEntry.name).toLowerCase(),
      normalizedRequestedAudioFilename: normalizePath(normalizedAudio).toLowerCase(),
      mime: getAudioMimeType(pickedEntry.name),
      audioBytes: standalone,
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
  const wroteRequested = await writeCachedFullAudioBlob(options.setId, result.requestedAudioFilename, audioBlob);
  if (!wroteRequested) {
    return { ok: false, error: 'Could not write extracted audio to cache.' };
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

export { extractFullBeatmapAudio, extractFullBeatmapAudioToCache };
