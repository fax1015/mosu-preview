// A media element's position, read once per frame, without the staircase.
//
// Firefox moves currentTime in ~40ms steps -- 25 readings a second, measured
// against a 165Hz frame loop -- so a preview read straight off it animated at
// 25fps whatever the display could do, and hitsounds were timed off a value up
// to a step stale. Between steps the position is carried forward on the
// performance clock, centred on the reading: across the frames a reading is
// shown for, the estimate runs from just behind it to just ahead of it, and the
// next reading carries on from there. Centring keeps the per-frame average
// exactly where the raw readings had it, so sync does not move; only the steps
// go. Each reading re-anchors the estimate, so nothing accumulates.
//
// A clock that changes on every read passes straight through. Chromium's
// nearly does: at 165Hz it repeats on ~10% of frames, which this smooths the
// same way, moving its average by about half a millisecond.

// A forward move bigger than this is a seek or a new source, not playback.
const MAX_PLAYBACK_STEP_MS = 250;
// A reading repeated within this long is the same task reading twice, not a
// clock that has stopped moving between frames.
const SAME_TASK_MS = 4;
// Gaps between reads longer than this are a stall, not the frame interval.
const MAX_FRAME_MS = 100;

const createMediaClockSmoother = ({ now = () => performance.now() } = {}) => {
  let identity = null;
  let lastRawMs = null;
  let seenAtMs = 0;
  let stepMs = 0;
  let stepped = false;
  let lastOutputMs = null;
  let lastReadAtMs = null;
  let frameMs = 0;

  const restart = (rawMs, atMs, nextIdentity) => {
    identity = nextIdentity;
    lastRawMs = rawMs;
    seenAtMs = atMs;
    stepMs = 0;
    stepped = false;
    lastOutputMs = rawMs;
    return rawMs;
  };

  /** The element's position in ms, smoothed when its clock moves in steps. */
  const read = (audio, rate = 1) => {
    const rawMs = (Number(audio?.currentTime) || 0) * 1000;
    const atMs = now();
    if (lastReadAtMs !== null) {
      const gapMs = atMs - lastReadAtMs;
      if (gapMs >= SAME_TASK_MS && gapMs <= MAX_FRAME_MS) {
        frameMs = frameMs > 0 ? (frameMs * 0.8) + (gapMs * 0.2) : gapMs;
      }
    }
    lastReadAtMs = atMs;
    const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const nextIdentity = `${audio?.src ?? ''}|${speed}`;
    if (!audio || audio.paused || nextIdentity !== identity || lastRawMs === null) {
      return restart(rawMs, atMs, nextIdentity);
    }

    if (rawMs !== lastRawMs) {
      const deltaMs = rawMs - lastRawMs;
      if (deltaMs < 0 || deltaMs > MAX_PLAYBACK_STEP_MS * speed) {
        return restart(rawMs, atMs, nextIdentity);
      }
      stepMs = deltaMs;
      lastRawMs = rawMs;
      seenAtMs = atMs;
    } else if (atMs - seenAtMs >= SAME_TASK_MS) {
      stepped = true;
    }

    if (!stepped || stepMs <= 0) {
      lastOutputMs = rawMs;
      return rawMs;
    }

    // A reading is only seen at the next frame, so over the frames it is shown
    // for the estimate climbs one frame less than a step; centring that climb on
    // the reading is what keeps the average where the raw readings had it.
    const leadMs = Math.max(0, stepMs - (frameMs * speed)) / 2;
    const carriedMs = rawMs - leadMs + Math.min((atMs - seenAtMs) * speed, leadMs + (stepMs / 2));
    // A reading that lands a little early holds the clock for a moment rather
    // than pulling it back: the scheduler would take a backward step for a seek.
    lastOutputMs = Math.max(carriedMs, lastOutputMs);
    return lastOutputMs;
  };

  return { read };
};

export { MAX_PLAYBACK_STEP_MS, createMediaClockSmoother };
