// When the follow line between two objects shows, and how much of it, kept
// apart from the drawing so it is a plain function of the playback time.
//
// A line appears a little after the object it leads to starts fading in,
// shooting out from the object before it, and fades in gradually so it is
// fully in just before that object is hit. Then it fades out briefly.

import { clamp } from './math.js';

// osu!lazer's follow point spacing, which decides how close is too close.
const FOLLOW_POINT_SPACING = 32;
// The line starts fading in when this much of the object's approach is left,
// and fades in over this much of it: at AR 9, 480ms before the hit, over
// 420ms, so it is fully in 60ms before.
const FOLLOW_LINE_APPEAR_PREEMPT_SHARE = 0.8;
const FOLLOW_LINE_FADE_IN_PREEMPT_SHARE = 0.7;
// The line shoots out over this long at most, easing out hard.
const FOLLOW_LINE_SHOOT_MS = 250;
// How long it takes to go once the object it leads to is hit.
const FOLLOW_LINE_FADE_OUT_MS = 120;

// Eased at both ends, so neither fade starts or stops visibly.
const smoothstep = (t) => t * t * (3 - (2 * t));

// Lazer's first point sits 1.5 spacings from the start object and its last
// stops more than a spacing short of the end one, both measured on the
// distance cut to whole pixels. Objects 80px apart or closer get none.
const hasFollowPoints = (distanceOsu) => (
  Math.trunc(distanceOsu) - FOLLOW_POINT_SPACING > Math.trunc(FOLLOW_POINT_SPACING * 1.5)
);

/**
 * The follow line leading to an object hit at `endTimeMs`, which approaches
 * over `preemptMs` before that.
 *
 * Returns null while it is not showing. Otherwise `alpha` is its opacity, 0 to
 * 1, and `extent` how far it has shot out towards that object, 0 to 1 of the
 * way from the object before it.
 */
const getFollowLineAt = (timeMs, { endTimeMs, preemptMs }) => {
  const appearTimeMs = endTimeMs - (preemptMs * FOLLOW_LINE_APPEAR_PREEMPT_SHARE);
  if (!(timeMs > appearTimeMs) || !(timeMs < endTimeMs + FOLLOW_LINE_FADE_OUT_MS)) {
    return null;
  }

  const elapsedMs = timeMs - appearTimeMs;
  const fadeInMs = preemptMs * FOLLOW_LINE_FADE_IN_PREEMPT_SHARE;
  const fadeIn = fadeInMs > 0 ? clamp(elapsedMs / fadeInMs, 0, 1) : 1;
  const fadeOut = clamp((timeMs - endTimeMs) / FOLLOW_LINE_FADE_OUT_MS, 0, 1);
  const shootMs = Math.min(FOLLOW_LINE_SHOOT_MS, fadeInMs);
  const shot = shootMs > 0 ? clamp(elapsedMs / shootMs, 0, 1) : 1;
  return {
    alpha: smoothstep(fadeIn) * (1 - smoothstep(fadeOut)),
    extent: 1 - ((1 - shot) ** 4),
  };
};

export {
  FOLLOW_LINE_FADE_OUT_MS,
  FOLLOW_LINE_SHOOT_MS,
  FOLLOW_POINT_SPACING,
  getFollowLineAt,
  hasFollowPoints,
};
