import { getAudioMimeType, normalizePath } from './cache.js';
import { downloadBeatmapArchive } from './provider.js';
import { extractZipEntry, parseZipEntries, pickAudioEntryFromZip } from './zip.js';
import { uint8ToBase64 } from '../core/base64Payload.js';

/**
 * Downloads the beatmap archive, extracts the audio entry, returns a base64-safe payload for messaging.
 * Shared by the service worker and (on failure there) the popup fallback, which mirrors pre-SW behavior.
 */
const extractFullBeatmapAudioToPayload = async ({
  setId,
  audioFilename,
  providerOverride = 'auto',
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
    const audioBase64 = uint8ToBase64(standalone);
    return {
      ok: true,
      sourceLabel,
      pickedAudioFilename: pickedEntry.name,
      requestedAudioFilename: normalizedAudio,
      normalizedPickedAudioFilename: normalizePath(pickedEntry.name).toLowerCase(),
      normalizedRequestedAudioFilename: normalizePath(normalizedAudio).toLowerCase(),
      mime: getAudioMimeType(pickedEntry.name),
      audioBase64,
    };
  } catch (error) {
    return { ok: false, error: error?.message || 'archive download failed' };
  }
};

export { extractFullBeatmapAudioToPayload };
