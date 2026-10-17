// Timing/SV lookup over a beatmap's control points, shared by the parser, the
// converters and every ruleset the renderer draws. It used to exist five times
// over, and the copies had drifted: only some reset slider velocity at an
// uninherited point, several fell back to a hardcoded 120 BPM before the first
// timing point, and the renderer's walked the whole list on every call -- once
// per note per frame, which cost mania previews of SV-heavy maps most of their
// frame budget.
//
// Control point arrays are treated as immutable once built. Each one gets an
// index the first time it is asked about, and every lookup after that is a
// binary search.

const DEFAULT_BEAT_LENGTH = 500;
const DEFAULT_METER = 4;

const timingIndexCache = new WeakMap();

const isTimingPoint = (point) => Boolean(point?.uninherited) && point.beatLength > 0;

/**
 * The state in force from each control point onwards, plus how many beats have
 * elapsed by then -- with and without slider velocity -- so a scroll distance
 * between two timestamps is a subtraction rather than a walk.
 *
 * osu!lazer's ControlPointInfo.TimingPointAt falls back to the *first* timing
 * point for times before it, rather than to a fixed default. Objects ahead of
 * the first uninherited point used to be timed at 120 BPM whatever the map's
 * real tempo was, which threw off their slider durations and tick spacing.
 */
const buildTimingIndex = (controlPoints) => {
  const points = Array.isArray(controlPoints)
    ? controlPoints.filter((point) => point && Number.isFinite(point.time))
    : [];
  const count = points.length;
  const firstTimingPoint = points.find(isTimingPoint) || null;
  const fallback = {
    beatLength: firstTimingPoint ? firstTimingPoint.beatLength : DEFAULT_BEAT_LENGTH,
    svMultiplier: 1,
    kiai: false,
    meter: firstTimingPoint?.meter > 0 ? firstTimingPoint.meter : DEFAULT_METER,
    sectionStart: firstTimingPoint ? firstTimingPoint.time : 0,
    omitFirstBarLine: false,
  };

  const index = {
    count,
    fallback,
    timingPoints: points.filter(isTimingPoint),
    times: new Float64Array(count),
    beatLengths: new Float64Array(count),
    svMultipliers: new Float64Array(count),
    meters: new Float64Array(count),
    sectionStarts: new Float64Array(count),
    kiai: new Uint8Array(count),
    omitFirstBarLine: new Uint8Array(count),
    beats: new Float64Array(count),
    svBeats: new Float64Array(count),
  };

  let { beatLength, svMultiplier, kiai, meter, sectionStart, omitFirstBarLine } = fallback;
  let beats = 0;
  let svBeats = 0;

  for (let i = 0; i < count; i += 1) {
    const point = points[i];
    if (i > 0) {
      // The stretch since the previous point ran at the state that point set.
      const elapsedBeats = (point.time - points[i - 1].time) / Math.max(1, beatLength);
      beats += elapsedBeats;
      svBeats += elapsedBeats * svMultiplier;
    }

    kiai = Boolean(point.kiai);
    // An uninherited point resets slider velocity to 1: in the legacy format it
    // emits a fresh difficulty control point, so an earlier SV multiplier must
    // not carry across a BPM change.
    if (isTimingPoint(point)) {
      beatLength = point.beatLength;
      svMultiplier = 1;
      meter = point.meter > 0 ? point.meter : DEFAULT_METER;
      sectionStart = point.time;
      omitFirstBarLine = Boolean(point.omitFirstBarLine);
    } else if (!point.uninherited && point.svMultiplier > 0) {
      svMultiplier = point.svMultiplier;
    }

    index.times[i] = point.time;
    index.beatLengths[i] = beatLength;
    index.svMultipliers[i] = svMultiplier;
    index.meters[i] = meter;
    index.sectionStarts[i] = sectionStart;
    index.kiai[i] = kiai ? 1 : 0;
    index.omitFirstBarLine[i] = omitFirstBarLine ? 1 : 0;
    index.beats[i] = beats;
    index.svBeats[i] = svBeats;
  }

  return index;
};

const EMPTY_TIMING_INDEX = buildTimingIndex([]);

const getTimingIndex = (controlPoints) => {
  if (!Array.isArray(controlPoints) || controlPoints.length === 0) {
    return EMPTY_TIMING_INDEX;
  }
  let index = timingIndexCache.get(controlPoints);
  if (!index) {
    index = buildTimingIndex(controlPoints);
    timingIndexCache.set(controlPoints, index);
  }
  return index;
};

// The last point at or before `time`, or -1 when `time` precedes them all.
const findPointIndexAt = (index, time) => {
  let low = 0;
  let high = index.count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (index.times[mid] <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low - 1;
};

const getFallbackBeatLength = (controlPoints) => getTimingIndex(controlPoints).fallback.beatLength;

/** The timing state in force at a beatmap timestamp. */
const getTimingStateAt = (controlPoints, time) => {
  const index = getTimingIndex(controlPoints);
  const i = findPointIndexAt(index, time);
  const state = i < 0
    ? index.fallback
    : {
      beatLength: index.beatLengths[i],
      svMultiplier: index.svMultipliers[i],
      kiai: index.kiai[i] === 1,
      meter: index.meters[i],
      sectionStart: index.sectionStarts[i],
      omitFirstBarLine: index.omitFirstBarLine[i] === 1,
    };

  return {
    beatLength: state.beatLength,
    svMultiplier: state.svMultiplier,
    kiai: state.kiai,
    meter: state.meter,
    sectionStart: state.sectionStart,
    omitFirstBarLine: state.omitFirstBarLine,
    bpm: 60000 / Math.max(1, state.beatLength),
  };
};

/**
 * Beats elapsed at `time`, measured from the first control point. With
 * `withSv`, each beat is weighted by the slider velocity in force, which is
 * what a scrolling ruleset's distance is proportional to.
 */
const getElapsedBeatsAt = (controlPoints, time, { withSv = true } = {}) => {
  const index = getTimingIndex(controlPoints);
  if (index.count === 0) {
    return time / Math.max(1, index.fallback.beatLength);
  }

  const i = findPointIndexAt(index, time);
  if (i < 0) {
    // Before the first point the fallback state runs, at unit velocity.
    return (time - index.times[0]) / Math.max(1, index.fallback.beatLength);
  }

  const elapsedBeats = (time - index.times[i]) / Math.max(1, index.beatLengths[i]);
  return withSv
    ? index.svBeats[i] + (elapsedBeats * index.svMultipliers[i])
    : index.beats[i] + elapsedBeats;
};

/** The uninherited points alone, in order: where bar lines and BPM sections start. */
const getTimingSections = (controlPoints) => getTimingIndex(controlPoints).timingPoints;

export {
  DEFAULT_BEAT_LENGTH,
  getElapsedBeatsAt,
  getFallbackBeatLength,
  getTimingSections,
  getTimingStateAt,
};
