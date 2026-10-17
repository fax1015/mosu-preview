import { clamp } from './math.js';

// Below half speed the preview is too slow to be useful, and browsers stop
// playing the audio at all somewhere under it, so the range ends here. The
// slider in popup.html carries the same bounds.
const MIN_PLAYBACK_SPEED = 0.5;
const MAX_PLAYBACK_SPEED = 2;
const PLAYBACK_SPEED_STEP = 0.05;

/** Any requested speed, snapped to the slider's step and kept in range. */
const normalizePlaybackSpeed = (speed) => {
  const value = Number(speed);
  if (!Number.isFinite(value)) {
    return 1;
  }
  const stepped = Math.round(value / PLAYBACK_SPEED_STEP) * PLAYBACK_SPEED_STEP;
  return Number(clamp(stepped, MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED).toFixed(2));
};

export { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED, PLAYBACK_SPEED_STEP, normalizePlaybackSpeed };
