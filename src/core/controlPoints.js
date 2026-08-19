// Timing/SV lookup over a beatmap's control points. This existed three times
// over — in the parser, the converters and the renderer — and the copies had
// drifted: only two of them reset slider velocity at an uninherited point, and
// all three fell back to a hardcoded 120 BPM before the first timing point.

const DEFAULT_BEAT_LENGTH = 500;

const fallbackBeatLengthCache = new WeakMap();

/**
 * osu!lazer's ControlPointInfo.TimingPointAt falls back to the *first* timing
 * point for times before it, rather than to a fixed default. Objects ahead of
 * the first uninherited point were being timed at 120 BPM whatever the map's
 * real tempo was, which threw off their slider durations and tick spacing.
 */
const getFallbackBeatLength = (controlPoints) => {
  if (!Array.isArray(controlPoints) || controlPoints.length === 0) {
    return DEFAULT_BEAT_LENGTH;
  }

  const cached = fallbackBeatLengthCache.get(controlPoints);
  if (cached !== undefined) {
    return cached;
  }

  const first = controlPoints.find((point) => point?.uninherited && point.beatLength > 0);
  const beatLength = first ? first.beatLength : DEFAULT_BEAT_LENGTH;
  fallbackBeatLengthCache.set(controlPoints, beatLength);
  return beatLength;
};

/**
 * Resolves the active timing state at a beatmap timestamp. An uninherited point
 * resets slider velocity to 1: in the legacy format it emits a fresh difficulty
 * control point, so an earlier SV multiplier must not carry across a BPM change.
 */
const getTimingStateAt = (controlPoints, time) => {
  const points = Array.isArray(controlPoints) ? controlPoints : [];
  let beatLength = getFallbackBeatLength(points);
  let svMultiplier = 1;
  let kiai = false;

  for (const point of points) {
    if (!point || point.time > time) {
      break;
    }

    kiai = Boolean(point.kiai);
    if (point.uninherited && point.beatLength > 0) {
      beatLength = point.beatLength;
      svMultiplier = 1;
    } else if (!point.uninherited && point.svMultiplier > 0) {
      svMultiplier = point.svMultiplier;
    }
  }

  return {
    beatLength,
    svMultiplier,
    kiai,
    bpm: 60000 / Math.max(1, beatLength),
  };
};

export {
  DEFAULT_BEAT_LENGTH,
  getFallbackBeatLength,
  getTimingStateAt,
};
