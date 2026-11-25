// b.ppy.sh preview clips contain a 100ms lead-in before the configured osu!
// PreviewTime. Audio is anchored to the beatmap timeline rather than starting at
// map time 0:
// `anchorMapMs` is the beatmap timestamp that corresponds to position 0 in the
// audio element. For full beatmap audio that anchor is 0, but for the fallback
// b.ppy.sh preview clip it is 100ms before the beatmap's PreviewTime, and the
// clip only runs for ~10 seconds. Most of a map therefore has no audio behind it
// at all, which is something callers have to be able to detect.
const PREVIEW_AUDIO_SOURCE_PREFIX = 'https://b.ppy.sh/preview/';
const PREVIEW_CLIP_LEAD_IN_MS = 100;
// osu!'s b.ppy.sh preview clips run ~10 seconds starting at PreviewTime
// (minus the lead-in). Used to reject obviously out-of-range seeks before
// metadata loads so resuming mid-map never blocks on or clamps to the clip.
const PREVIEW_CLIP_ESTIMATED_DURATION_MS = 10_000;
const AUDIO_SEEK_TOLERANCE_SEC = 0.25;

const isPreviewAudioSourceUrl = (src) => (
  typeof src === 'string' && src.startsWith(PREVIEW_AUDIO_SOURCE_PREFIX)
);

/**
 * Maps a beatmap timestamp onto a position in the audio element.
 *
 * `covered` is false when the timestamp falls outside the audio. Reporting that
 * honestly matters: clamping an out-of-range seek and calling it a success made
 * the 'seeked' and 'timeupdate' listeners resync the visual clock back to the
 * preview clip, so dragging the scrubber anywhere past PreviewTime + 10s
 * immediately snapped back.
 */
const resolveAudioSeekTarget = (mapTimeMs, anchorMapMs, durationSec) => {
  const rawSec = (Number(mapTimeMs) - (Number(anchorMapMs) || 0)) / 1000;
  if (!Number.isFinite(rawSec)) {
    return { sec: 0, covered: false };
  }

  // Duration is NaN until metadata loads. Treat the target as reachable and let
  // the element clamp itself once it knows how long it is.
  const hasDuration = Number.isFinite(durationSec) && durationSec > 0;
  const maxSec = hasDuration ? durationSec : Math.max(0, rawSec);
  const sec = Math.min(Math.max(0, rawSec), maxSec);
  const covered = rawSec >= -AUDIO_SEEK_TOLERANCE_SEC
    && (!hasDuration || rawSec <= durationSec + AUDIO_SEEK_TOLERANCE_SEC);

  return { sec, covered };
};

/**
 * @param {object} options
 * @param {boolean} [options.requireCoverage] When true (the default) a seek to a
 *   map time the audio does not contain fails instead of clamping. Pass false
 *   for preflight seeks that only need the element to accept *some* position.
 * @returns {boolean} whether the element was seeked.
 */
const seekAudioElementToMapTime = (audioElement, mapTimeMs, anchorMapMs, { requireCoverage = true } = {}) => {
  if (!audioElement) {
    return false;
  }

  const hasKnownDuration = Number.isFinite(audioElement.duration) && audioElement.duration > 0;
  if (requireCoverage && !hasKnownDuration && isPreviewAudioSourceUrl(audioElement.src)) {
    const rawSec = (Number(mapTimeMs) - (Number(anchorMapMs) || 0)) / 1000;
    if (!Number.isFinite(rawSec) || rawSec > PREVIEW_CLIP_ESTIMATED_DURATION_MS / 1000) {
      return false;
    }
  }

  const { sec, covered } = resolveAudioSeekTarget(mapTimeMs, anchorMapMs, audioElement.duration);
  if (requireCoverage && !covered) {
    return false;
  }

  audioElement.currentTime = sec;
  return true;
};

/**
 * Converts a beatmap PreviewTime into the map timestamp represented by position
 * zero in the b.ppy.sh preview clip. b.ppy.sh includes a 100ms lead-in before
 * PreviewTime. When PreviewTime is -1 osu! generates the clip from ~40% into the
 * track instead, and that offset cannot be derived from the .osu file.
 */
const isPreviewClipAnchorable = (previewTimeMs) => (
  Number.isFinite(previewTimeMs) && previewTimeMs > 0
);

const getPreviewClipAnchorMapMs = (previewTimeMs) => (
  isPreviewClipAnchorable(previewTimeMs)
    ? Math.max(0, Number(previewTimeMs) - PREVIEW_CLIP_LEAD_IN_MS)
    : 0
);

export {
  AUDIO_SEEK_TOLERANCE_SEC,
  PREVIEW_AUDIO_SOURCE_PREFIX,
  PREVIEW_CLIP_ESTIMATED_DURATION_MS,
  PREVIEW_CLIP_LEAD_IN_MS,
  getPreviewClipAnchorMapMs,
  isPreviewAudioSourceUrl,
  isPreviewClipAnchorable,
  resolveAudioSeekTarget,
  seekAudioElementToMapTime,
};
