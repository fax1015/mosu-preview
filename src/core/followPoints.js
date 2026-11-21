// Where the follow line between two objects is at a given moment, kept apart
// from the drawing so it is a plain function of the playback time.
//
// osu! lays a row of separate points along the line, each one fading in 800ms
// before the cursor would reach it and out again as the cursor passes, so the
// row travels from the object behind to the object ahead across the whole gap
// between them, the tail here cut shorter than lazer's so the line leaves an
// object promptly once it has been hit. mosu! draws one continuous line
// rather than dots, but takes the same timing: this works out where the
// band's two ends have got to, as fractions of the way from the first
// object's centre to the second's.
//
// The band runs centre to centre, where lazer's row of points stops short of
// both. A row of dots reads as spaced out; a line stopping short of a circle
// reads as clipped, the more so the closer the two objects are. The drawing
// cuts the objects back out of the line, so what is left of it ends at their
// edges either way.

import { clamp } from './math.js';

// osu!lazer's FollowPointConnection.SPACING and PREEMPT, the fade length it
// takes from stable's hit-object fade-in, and OsuHitObject.PREEMPT_MIN, below
// which that preempt is cut back in proportion.
const FOLLOW_POINT_SPACING = 32;
const FOLLOW_LINE_PREEMPT_MS = 800;
const FOLLOW_LINE_FADE_IN_MS = 400;
const FOLLOW_LINE_PREEMPT_FLOOR_MS = 450;
// Lazer fades a point out over the same 400ms it faded in. Here the tail is
// cut shorter, so the line clears away from an object once it has been hit
// rather than hanging about behind the cursor.
const FOLLOW_LINE_FADE_OUT_MS = 150;

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
 * nothing at `trail` behind it and `lead` ahead of it -- the trailing ramp
 * the shorter of the two, being the fade out.
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
  const fadeOut = fraction < fadeStart && fadeStart > trail
    ? smoothstep(clamp((fraction - trail) / (fadeStart - trail), 0, 1))
    : 1;
  const fadeIn = fraction > solidLead && lead > solidLead
    ? smoothstep(clamp((lead - fraction) / (lead - solidLead), 0, 1))
    : 1;
  return alpha * fadeOut * fadeIn;
};

/**
 * The follow line from an object that ends at `startTimeMs` to the next one,
 * hit at `endTimeMs`, their centres `distanceOsu` apart, on a map whose
 * objects approach over `objectPreemptMs`.
 *
 * Returns null while none of it is showing. Otherwise `from` and `to` are the
 * ends of the visible band as fractions of the way between the two centres,
 * and followLineAlphaAt() gives the opacity anywhere along it. `fromCut` and
 * `toCut` say which of those ends is an object's own centre, rather than
 * where the fade has swept to and the opacity is already nothing.
 */
const getFollowLineAt = (timeMs, {
  startTimeMs, endTimeMs, objectPreemptMs, distanceOsu,
}) => {
  if (!hasFollowPoints(distanceOsu)) {
    return null;
  }

  const preemptMs = getFollowLinePreemptMs(objectPreemptMs);
  const durationMs = endTimeMs - startTimeMs;

  let line;
  if (durationMs > 0) {
    // The fraction whose own moment falls `offsetMs` from now. A point starts
    // to appear a preempt before that moment and is gone a fade after it.
    const fractionAt = (offsetMs) => (timeMs - startTimeMs + offsetMs) / durationMs;
    line = {
      trail: fractionAt(-FOLLOW_LINE_FADE_OUT_MS),
      fadeStart: fractionAt(0),
      solidLead: fractionAt(preemptMs - FOLLOW_LINE_FADE_IN_MS),
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
      alpha: clamp((elapsedMs + preemptMs) / FOLLOW_LINE_FADE_IN_MS, 0, 1)
        * (1 - clamp(elapsedMs / FOLLOW_LINE_FADE_OUT_MS, 0, 1)),
    };
  }

  // Everything strictly inside (trail, lead) has some opacity, so a band with
  // any width at all is a band with something to draw.
  const from = Math.max(0, line.trail);
  const to = Math.min(1, line.lead);
  if (!(to > from) || !(line.alpha > 0)) {
    return null;
  }

  return {
    ...line,
    from,
    to,
    fromCut: !(line.trail > 0),
    toCut: !(line.lead < 1),
  };
};

export {
  FOLLOW_LINE_FADE_IN_MS,
  FOLLOW_LINE_FADE_OUT_MS,
  FOLLOW_LINE_PREEMPT_MS,
  FOLLOW_POINT_SPACING,
  followLineAlphaAt,
  getFollowLineAt,
  getFollowLinePreemptMs,
  hasFollowPoints,
};
