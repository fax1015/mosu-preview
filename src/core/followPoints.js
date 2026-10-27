// Where the follow line between two objects is at a given moment, kept apart
// from the drawing so it is a plain function of the playback time.
//
// osu! lays a row of separate points along the line, each one fading in 800ms
// before the cursor would reach it and out again as the cursor passes, so the
// row travels from the object behind to the object ahead across the whole gap
// between them. mosu! draws one continuous line rather than dots, but takes
// the same timing: this works out where the band's two ends have got to, as
// fractions of the way from the first object's centre to the second's.

import { clamp } from './math.js';

// osu!lazer's FollowPointConnection.SPACING and PREEMPT, the fade length it
// takes from stable's hit-object fade-in, and OsuHitObject.PREEMPT_MIN, below
// which that preempt is cut back in proportion.
const FOLLOW_POINT_SPACING = 32;
const FOLLOW_LINE_PREEMPT_MS = 800;
const FOLLOW_LINE_FADE_MS = 400;
const FOLLOW_LINE_PREEMPT_FLOOR_MS = 450;

// Eased at both ends, so neither end of the band starts or stops visibly.
const smoothstep = (t) => t * t * (3 - (2 * t));

// Lazer's first point sits 1.5 spacings from the start object and its last
// stops more than a spacing short of the end one, both measured on the
// distance cut to whole pixels. Objects 80px apart or closer get none.
const hasFollowPoints = (distanceOsu) => (
  Math.trunc(distanceOsu) - FOLLOW_POINT_SPACING > Math.trunc(FOLLOW_POINT_SPACING * 1.5)
);

/**
 * How long before its own moment a point starts to appear: 800ms, cut back
 * once the approach itself is shorter than 450ms. Note this barely depends on
 * the approach rate, where the objects' own fades depend on little else.
 */
const getFollowLinePreemptMs = (objectPreemptMs) => (
  FOLLOW_LINE_PREEMPT_MS * Math.min(1, Math.max(0, objectPreemptMs) / FOLLOW_LINE_PREEMPT_FLOOR_MS)
);

/**
 * Opacity at `fraction` of the way between the two object centres, 0 to 1.
 * The band is solid between `fadeStart` and `solidLead`, and ramps away to
 * nothing at `trail` behind it and `lead` ahead of it.
 */
const followLineAlphaAt = (fraction, line) => {
  if (!line) {
    return 0;
  }

  const {
    trail, fadeStart, solidLead, lead, alpha,
  } = line;
  if (fraction <= trail || fraction >= lead) {
    return 0;
  }
  if (fraction < fadeStart) {
    return alpha * smoothstep(clamp((fraction - trail) / (fadeStart - trail), 0, 1));
  }
  if (fraction > solidLead) {
    return alpha * smoothstep(clamp((lead - fraction) / (lead - solidLead), 0, 1));
  }
  return alpha;
};

/**
 * The follow line from an object that ends at `startTimeMs` to the next one,
 * hit at `endTimeMs`, their centres `distanceOsu` apart, on a map whose
 * objects approach over `objectPreemptMs`.
 *
 * Returns null while none of it is showing. Otherwise `from` and `to` are the
 * ends of the visible band as fractions of the way between the two centres,
 * and followLineAlphaAt() gives the opacity anywhere along it.
 */
const getFollowLineAt = (timeMs, {
  startTimeMs, endTimeMs, objectPreemptMs, distanceOsu,
}) => {
  if (!hasFollowPoints(distanceOsu)) {
    return null;
  }

  // The band covers the same ground as lazer's row of points: a point and a
  // half out of the object behind, stopping a point short of the one ahead.
  const near = (FOLLOW_POINT_SPACING * 1.5) / distanceOsu;
  const far = (distanceOsu - FOLLOW_POINT_SPACING) / distanceOsu;
  const preemptMs = getFollowLinePreemptMs(objectPreemptMs);
  const durationMs = endTimeMs - startTimeMs;

  let line;
  if (durationMs > 0) {
    // The fraction whose own moment falls `offsetMs` from now. A point starts
    // to appear a preempt before that moment and is gone a fade after it.
    const fractionAt = (offsetMs) => (timeMs - startTimeMs + offsetMs) / durationMs;
    line = {
      trail: fractionAt(-FOLLOW_LINE_FADE_MS),
      fadeStart: fractionAt(0),
      solidLead: fractionAt(preemptMs - FOLLOW_LINE_FADE_MS),
      lead: fractionAt(preemptMs),
      alpha: 1,
    };
  } else {
    // Objects that overlap leave no gap to travel across, so every point shares
    // one moment and the whole line comes in and goes again together.
    const elapsedMs = timeMs - startTimeMs;
    line = {
      trail: -Infinity,
      fadeStart: -Infinity,
      solidLead: Infinity,
      lead: Infinity,
      alpha: clamp((elapsedMs + preemptMs) / FOLLOW_LINE_FADE_MS, 0, 1)
        * (1 - clamp(elapsedMs / FOLLOW_LINE_FADE_MS, 0, 1)),
    };
  }

  // Everything strictly inside (trail, lead) has some opacity, so a band with
  // any width at all is a band with something to draw.
  const from = Math.max(near, line.trail);
  const to = Math.min(far, line.lead);
  if (!(to > from) || !(line.alpha > 0)) {
    return null;
  }

  return { ...line, from, to };
};

export {
  FOLLOW_LINE_FADE_MS,
  FOLLOW_LINE_PREEMPT_MS,
  FOLLOW_POINT_SPACING,
  followLineAlphaAt,
  getFollowLineAt,
  getFollowLinePreemptMs,
  hasFollowPoints,
};
