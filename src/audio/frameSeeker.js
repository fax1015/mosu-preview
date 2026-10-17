// Seeking without asking the element to seek.
//
// Browsers seek compressed audio approximately and then report the time they
// were asked for rather than the time they reached: an MP3 can be off by its
// encoder delay or, if VBR, by up to 0.7s; an Ogg Vorbis track by the packet
// its decoder primes on. Everything here follows currentTime, so the map was
// drawn that far from the music. Playing on from a known point is exact, so
// each seek loads the track from the point just before the target and anchors
// the map to that point's time.
//
// A format's index (audio/mp3Index.js, audio/oggIndex.js) supplies the points:
// `count`, `startMs[i]` -- the track time playback from point i starts at --
// `durationMs`, `prerollPoints` to start that many points early, and
// `sliceFrom(blob, i)`, the Blob that plays from point i.

import { buildMp3FrameIndex, isMp3 } from './mp3Index.js';
import { buildOggVorbisIndex, isOgg } from './oggIndex.js';
import { AUDIO_SEEK_TOLERANCE_SEC } from './seek.js';

/** The last point starting at or before `timeMs` (0 when it precedes them all). */
const findFrameAtOrBefore = (index, timeMs) => {
  let low = 0;
  let high = index.count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (index.startMs[mid] <= timeMs) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
};

const createFrameSeeker = ({ state, blob, index, onSourceChange }) => {
  let sliceUrl = null;
  const toleranceMs = AUDIO_SEEK_TOLERANCE_SEC * 1000;

  return {
    index,
    durationMs: index.durationMs,
    seek(targetMs, { requireCoverage = true } = {}) {
      if (!Number.isFinite(targetMs)) {
        return false;
      }
      if (requireCoverage && (targetMs < -toleranceMs || targetMs > index.durationMs + toleranceMs)) {
        return false;
      }
      const frame = Math.max(
        0,
        findFrameAtOrBefore(index, Math.min(Math.max(0, targetMs), index.durationMs)) - index.prerollPoints,
      );
      const previousUrl = sliceUrl;
      sliceUrl = URL.createObjectURL(index.sliceFrom(blob, frame));
      state.fullAudioSliceUrl = sliceUrl;
      state.audioAnchorMapMs = index.startMs[frame];
      state.audioAnchorSrc = sliceUrl;
      state.audio.src = sliceUrl;
      state.audio.load();
      // load() puts the rate back to the default.
      state.audio.playbackRate = state.playbackSpeed;
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      onSourceChange?.();
      return true;
    },
    dispose() {
      if (sliceUrl) {
        URL.revokeObjectURL(sliceUrl);
      }
      sliceUrl = null;
    },
  };
};

/**
 * The seeker for a full track, or null when the browser should seek it itself.
 * Every MP3 gets one, whatever its bitrate -- constant bitrate only spares the
 * browser's estimate, not the encoder delay it can lose on the way -- and so
 * does every Ogg Vorbis track.
 */
const createTrackFrameSeeker = async ({ state, blob, filename, onSourceChange }) => {
  let index = null;
  if (isMp3(filename, blob)) {
    index = await buildMp3FrameIndex(blob);
  } else if (isOgg(filename, blob)) {
    index = await buildOggVorbisIndex(blob);
  }
  return index ? createFrameSeeker({ state, blob, index, onSourceChange }) : null;
};

export { createFrameSeeker, createTrackFrameSeeker, findFrameAtOrBefore };
