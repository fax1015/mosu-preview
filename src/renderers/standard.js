// osu!standard: circles, sliders and spinners at fixed places on the 512x384
// field, with approach circles, follow lines and the stacking pass. Drawn in
// the legacy 640x480 view (see getStandardPlayfieldLayout).

import {
  buildSliderCurvePoints,
  measurePath,
  positionOnMeasuredPath,
  simplifyPathForRendering,
  trimPathFromStart,
  trimPathToLength,
} from '../core/sliderPath.js';
import { getTimingStateAt } from '../core/controlPoints.js';
import { clamp, findFirstIndexAtOrAfter } from '../core/math.js';
import {
  FOLLOW_LINE_FADE_OUT_MS,
  followLineAlphaAt,
  getFollowLineAt,
  getFollowLinePreemptMs,
} from '../core/followPoints.js';
import {
  LONG_OBJECT_POST_HIT_FADE_MS,
  OSU_HEIGHT,
  OSU_VIEW_HEIGHT,
  OSU_VIEW_WIDTH,
  OSU_WIDTH,
  PIECE_MAX_ALPHA,
  PIECE_SHADOW_SCALE,
  PLAYFIELD_BACKGROUND,
  buildPrefixMaxEndTimes,
  drawPieceCircle,
  drawSelectionRings,
  findFirstIndexWithEndAtOrAfter,
  getApproachPreemptMs,
  getComboColour,
  pickHitTarget,
  withAlpha,
} from './shared.js';

const OSU_FIELD_OFFSET_X = (OSU_VIEW_WIDTH - OSU_WIDTH) / 2;
const OSU_FIELD_OFFSET_Y = (OSU_VIEW_HEIGHT - OSU_HEIGHT) / 2;
// Match the slight downward field placement observed in osu!'s legacy layout.
const OSU_FIELD_VERTICAL_SHIFT = 8;
// osu!lazer: StackOffset = StackHeight * Scale * -6.4, with Scale = radius/64,
// so one stack level is worth radius/10 osu! pixels — 4.5px at CS 2 down to
// 2.3px at CS 7. This constant is only the CS 5 value, used as a fallback when
// an object has not been through the stacking pass.
const STACK_OFFSET_OSU_AT_CS5 = 3.2;
const getStackOffsetUnit = (circleSize) => getCircleRadius(circleSize) / 10;
const DRAWN_CIRCLE_RADIUS_SCALE = 0.92;
const DRAWN_CIRCLE_INSET_PX = 0.75;
const CIRCLE_POST_HIT_FADE_MS = 120;
const SLIDER_HEAD_HIT_FADE_MS = 120;
const SLIDER_HEAD_HIT_SCALE_BOOST = 0.2;
// osu!lazer's DrawableSliderTick animation length, and the fixed lead-in
// SliderTick.ApplyDefaultsToSelf gives a tick on any span after the first.
const SLIDER_TICK_FADE_IN_MS = 150;
const SLIDER_TICK_REPEAT_OFFSET_MS = 200;
const COMBO_NUMBER_FONT_SCALE = 0.84;
// The shared look (renderers/shared.js) is this ruleset's own circle.
const OBJECT_VISUAL_MAX_ALPHA = PIECE_MAX_ALPHA;
const STANDARD_OBJECT_SHADOW_SCALE = PIECE_SHADOW_SCALE;
// Maximum deviation, in rendered pixels, allowed when a very long slider path is
// thinned for drawing. Matches the 0.25 tolerance osu!lazer's path approximator
// uses in osu!units, so a thinned path stays as faithful as lazer's sampled one.
const STANDARD_SLIDER_RENDER_TOLERANCE_PX = 0.25;
// Normal sliders draw their full sampled curve. Thinning them was what made
// ordinary curved sliders look faceted: even when every dropped vertex sits
// within a fraction of a pixel of its chord, drawing an arc as a handful of
// long straight segments leaves visible corners in the stroked outline. Only
// paths longer than this are thinned, which in practice means the decorative
// anchor-dense sliders that the thinning exists for.
const STANDARD_SLIDER_RENDER_SIMPLIFY_MIN_POINTS = 512;
const STANDARD_FADE_IN_BASE_MS = 400;
const STANDARD_FADE_IN_PREEMPT_THRESHOLD_MS = 450;
const APPROACH_CIRCLE_START_SCALE = 4;
const sliderPathCache = new WeakMap();
const sliderRenderPathCache = new WeakMap();
const sliderPathCumulativeCache = new WeakMap();
// Unstacked slider endpoints, keyed by object. Separate from sliderPathCache
// because that one is keyed on the stack offset, which is exactly what the
// stacking algorithm has not decided yet when it asks for these.
const rawSliderEndCache = new WeakMap();
const standardSliderTickCache = new WeakMap();
// osu!lazer's SliderEventGenerator stops laying ticks 100,000 osu!pixels along
// a slider, and this stops at a count as well: ticks are spaced by the map's own
// numbers, and a slider with a thousand repeats could otherwise still ask for
// hundreds of millions of them -- every one an object, built on the first frame
// the slider is on screen.
const MAX_SLIDER_TICK_PATH_LENGTH = 100000;
const MAX_SLIDER_TICKS = 20000;

const getCircleRadius = (cs) => 54.4 - (4.48 * clamp(Number.isFinite(cs) ? cs : 5, 0, 10));

const getStandardPlayfieldLayout = (canvasWidth, canvasHeight, circleSize, padding = 0) => {
  const width = Math.max(1, Number(canvasWidth) || 1);
  const height = Math.max(1, Number(canvasHeight) || 1);
  const safePadding = Math.max(0, Number(padding) || 0);
  const availableWidth = Math.max(10, width - (safePadding * 2));
  const availableHeight = Math.max(10, height - (safePadding * 2));
  const cs = clamp(Number.isFinite(circleSize) ? circleSize : 5, 0, 10);
  // Border expansion follows osu!'s full CS-scaled radius. The circles themselves
  // are drawn slightly smaller, but that visual inset should not shrink the field.
  const edgeRadiusOsu = Math.max(0, getCircleRadius(cs));
  const scale = Math.min(
    availableWidth / OSU_VIEW_WIDTH,
    availableHeight / OSU_VIEW_HEIGHT,
  );
  // The field is drawn in its own proportions, whatever shape the canvas is,
  // and sits centred in it. It used to be stretched or squashed vertically so a
  // reference slider met both edges: a few percent in the preview's own shape,
  // and nearly double in a tall cell. Kept as a field of its own for callers.
  // That slider now sets the preview's height instead: see popup.css.
  const scaleY = scale;
  const playfieldWidth = OSU_WIDTH * scale;
  const playfieldHeight = OSU_HEIGHT * scaleY;
  const viewportWidth = OSU_VIEW_WIDTH * scale;
  const viewportHeight = OSU_VIEW_HEIGHT * scaleY;
  const viewportX = (width - viewportWidth) / 2;
  const viewportY = (height - viewportHeight) / 2;
  const playfieldX = viewportX + (OSU_FIELD_OFFSET_X * scale);
  const playfieldY = viewportY + ((OSU_FIELD_OFFSET_Y + OSU_FIELD_VERTICAL_SHIFT) * scaleY);
  // Keep the visible border tied to the CS-scaled circle radius.
  const edgePadding = edgeRadiusOsu * scale;
  const visualX = playfieldX - edgePadding;
  const visualY = playfieldY - edgePadding;
  const visualWidth = playfieldWidth + (edgePadding * 2);
  const visualHeight = playfieldHeight + (edgePadding * 2);

  return {
    scale,
    scaleY,
    playfieldX,
    playfieldY,
    playfieldWidth,
    playfieldHeight,
    visualX,
    visualY,
    visualWidth,
    visualHeight,
    edgePadding,
  };
};

const getStandardFadeInMs = (preemptMs) => (
  STANDARD_FADE_IN_BASE_MS * Math.min(1, Math.max(0, preemptMs) / STANDARD_FADE_IN_PREEMPT_THRESHOLD_MS)
);

const buildSliderPathPointsOsu = (object, useStackOffset = true) => {
  if (!object || object.kind !== 'slider') {
    return [];
  }

  const stackIndex = useStackOffset ? (object.stackIndex || 0) : 0;
  const cachedPath = useStackOffset ? sliderPathCache.get(object) : null;
  if (
    cachedPath
    && Array.isArray(cachedPath.points)
    && cachedPath.points.length >= 1
    && cachedPath.stackIndex === stackIndex
  ) {
    return cachedPath.points;
  }

  const stackOffset = useStackOffset ? getObjectStackOffset(object) : { x: 0, y: 0 };
  const points = buildSliderCurvePoints(object, stackOffset);
  if (useStackOffset) sliderPathCache.set(object, { stackIndex, points });
  return points;
};

const getSliderRenderPathPointsOsu = (object, scaleX, scaleY) => {
  const fullPath = buildSliderPathPointsOsu(object);

  const stackIndex = object.stackIndex || 0;
  const cached = sliderRenderPathCache.get(object);
  if (
    cached
    && cached.fullPath === fullPath
    && cached.stackIndex === stackIndex
    && cached.scaleX === scaleX
    && cached.scaleY === scaleY
  ) {
    return cached.points;
  }

  const points = simplifyPathForRendering(
    fullPath,
    STANDARD_SLIDER_RENDER_TOLERANCE_PX,
    scaleX,
    scaleY,
    STANDARD_SLIDER_RENDER_SIMPLIFY_MIN_POINTS,
  );
  sliderRenderPathCache.set(object, {
    fullPath, stackIndex, scaleX, scaleY, points,
  });
  return points;
};

const getSliderPathCumulativeLengths = (path) => {
  const cached = sliderPathCumulativeCache.get(path);
  if (cached) return cached;

  const lengths = measurePath(path);
  sliderPathCumulativeCache.set(path, lengths);
  return lengths;
};

const positionOnSliderPathAtProgress = (path, progress) => (
  positionOnMeasuredPath(path, getSliderPathCumulativeLengths(path), progress)
);

const getSliderRenderPathLength = (path) => {
  const lengths = getSliderPathCumulativeLengths(path);
  return lengths.length > 0 ? lengths[lengths.length - 1] : 0;
};

// A slider's `slides` counts spans, not repeats: one span is head-to-tail, and
// each extra one is a reverse. Nearly everything that draws or times a slider
// needs the same three numbers off the back of that.
const getSliderSpanTiming = (object) => {
  const endTime = Number.isFinite(object.endTime) ? object.endTime : object.time;
  const totalDuration = Math.max(1, endTime - object.time);
  const slides = Math.max(1, object.slides || 1);
  return { totalDuration, slides, spanDuration: totalDuration / slides };
};

const getSliderBallPositionOsu = (object, currentTime) => {
  const path = buildSliderPathPointsOsu(object);

  if (path.length <= 1) {
    const offset = getObjectStackOffset(object);
    return { x: object.x + offset.x, y: object.y + offset.y };
  }

  const { totalDuration, slides, spanDuration } = getSliderSpanTiming(object);
  const elapsed = clamp(currentTime - object.time, 0, totalDuration);

  let spanIndex = Math.min(slides - 1, Math.floor(elapsed / spanDuration));
  if (!Number.isFinite(spanIndex) || spanIndex < 0) {
    spanIndex = 0;
  }

  let spanProgress = spanDuration > 0
    ? (elapsed - (spanIndex * spanDuration)) / spanDuration
    : 0;
  spanProgress = clamp(spanProgress, 0, 1);

  const isForward = (spanIndex % 2) === 0;
  // A zero-length path stays on its (stacked) head, rather than snapping to the
  // unstacked position the way this used to.
  return positionOnSliderPathAtProgress(path, isForward ? spanProgress : (1 - spanProgress));
};

const getObjectStackOffset = (object) => {
  if (!object || object.kind === 'spinner') {
    return { x: 0, y: 0 };
  }

  const stackIndex = Number.isFinite(Number(object.stackIndex)) ? Number(object.stackIndex) : 0;
  if (stackIndex === 0) {
    return { x: 0, y: 0 };
  }

  // applyPreviewStacking() stamps the per-level offset on each object, since the
  // position helpers have no route to the beatmap's circle size.
  const unit = Number.isFinite(Number(object.stackOffsetUnit))
    ? Number(object.stackOffsetUnit)
    : STACK_OFFSET_OSU_AT_CS5;
  // The sign is negative: positive stack heights move earlier objects up and
  // left, while the slider-tail correction pushes later circles the other way
  // with a negative stack height.
  const offset = -stackIndex * unit;
  return { x: offset, y: offset };
};

const getRawObjectStartPositionOsu = (object) => ({
  x: Number(object?.x) || 0,
  y: Number(object?.y) || 0,
});

const getRawObjectEndPositionOsu = (object) => {
  if (!object || object.kind !== 'slider') {
    return getRawObjectStartPositionOsu(object);
  }

  // Rebuilding the curve here is what made stacking the slowest part of loading
  // a map: buildSliderPathPointsOsu skips its own cache when asked for unstacked
  // points, and the stacking passes call this from nested loops. The raw path
  // depends only on the control points, which never change after parsing, so the
  // endpoint can simply be remembered.
  const cachedEnd = rawSliderEndCache.get(object);
  if (cachedEnd) {
    return cachedEnd;
  }

  // An even-span repeat slider returns to its start point on the final span,
  // matching osu!lazer's Slider.EndPosition for stacking.
  const slides = Math.max(1, object.slides || 1);
  let endPosition;
  if ((slides % 2) === 0) {
    endPosition = getRawObjectStartPositionOsu(object);
  } else {
    const path = buildSliderPathPointsOsu(object, false);
    endPosition = path.at(-1) || getRawObjectStartPositionOsu(object);
  }
  rawSliderEndCache.set(object, endPosition);
  return endPosition;
};

const getObjectStartPositionOsu = (object) => {
  if (!object) {
    return { x: 0, y: 0 };
  }
  const stackOffset = getObjectStackOffset(object);
  return {
    x: object.x + stackOffset.x,
    y: object.y + stackOffset.y,
  };
};

const getObjectEndPositionOsu = (object) => {
  if (!object) {
    return { x: 0, y: 0 };
  }
  if (object.kind === 'slider') {
    return getSliderBallPositionOsu(object, object.endTime);
  }
  return getObjectStartPositionOsu(object);
};

const getSliderTailPositionOsu = (object) => {
  if (!object || object.kind !== 'slider') {
    return getObjectEndPositionOsu(object);
  }

  const path = buildSliderPathPointsOsu(object);
  if (path.length > 0) {
    return path[path.length - 1];
  }

  return getObjectStartPositionOsu(object);
};

const drawReverseIndicator = (ctx, position, direction, size, alpha = 1) => {
  const length = Math.hypot(direction.x, direction.y);
  if (!Number.isFinite(length) || length <= 0.001) {
    return;
  }

  const nx = direction.x / length;
  const ny = direction.y / length;
  const px = -ny;
  const py = nx;

  const tipX = position.x + (nx * size * 0.7);
  const tipY = position.y + (ny * size * 0.7);
  const backX = position.x - (nx * size * 0.55);
  const backY = position.y - (ny * size * 0.55);
  const wing = size * 0.48;

  ctx.strokeStyle = `rgba(255, 255, 255, ${clamp(alpha, 0, 1)})`;
  ctx.lineWidth = Math.max(2.5, size * 0.28);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(backX + (px * wing), backY + (py * wing));
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(backX - (px * wing), backY - (py * wing));
  ctx.stroke();
};

// Where a slider's path stops at one end, and which way it runs back from there.
const getPathEnd = (points, atEnd) => {
  const last = points.length - 1;
  const position = atEnd ? points[last] : points[0];
  const next = atEnd ? points[Math.max(0, last - 1)] : points[Math.min(1, last)];
  return { position, direction: { x: next.x - position.x, y: next.y - position.y } };
};

const drawSliderEndCircle = (ctx, position, radius, combo, alpha) => {
  drawPieceCircle(ctx, position.x, position.y, radius, combo, alpha);
};

const drawComboNumber =(ctx, text, x, y, radius, alpha = 1) => {
  if (!text) {
    return;
  }

  const digits = String(text).length;
  const fontScale = (digits >= 3 ? 0.72 : (digits === 2 ? 0.86 : 1.05)) * COMBO_NUMBER_FONT_SCALE;
  const fontSize = Math.max(8, radius * fontScale);
  const textAlpha = clamp(alpha, 0, 1);
  const strokeAlpha = clamp(alpha * 0.34, 0, 1);

  ctx.font = `700 ${fontSize}px Torus, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(0, 0, 0, ${strokeAlpha})`;
  ctx.lineWidth = Math.max(0.75, radius * 0.095);
  ctx.strokeText(String(text), x, y + 0.5);
  ctx.fillStyle = `rgba(255, 255, 255, ${textAlpha})`;
  ctx.fillText(String(text), x, y + 0.5);
};

const calculatePreviewStackThreshold = (approachRate, stackLeniency) => (
  Math.trunc(getApproachPreemptMs(approachRate)) * (
    Number.isFinite(Number(stackLeniency)) ? Number(stackLeniency) : 0.7
  )
);

const distanceBetweenOsuPositions = (first, second) => Math.hypot(
  (first?.x || 0) - (second?.x || 0),
  (first?.y || 0) - (second?.y || 0),
);

const applyPreviewStackingOld = (objects, approachRate, stackLeniency) => {
  const stackThreshold = calculatePreviewStackThreshold(approachRate, stackLeniency);

  for (let i = 0; i < objects.length; i += 1) {
    const current = objects[i];
    if (current.kind === 'spinner') {
      continue;
    }
    if ((current.stackIndex || 0) !== 0 && current.kind !== 'slider') {
      continue;
    }

    let startTime = Number.isFinite(current.endTime) ? current.endTime : current.time;
    let sliderStack = 0;
    for (let j = i + 1; j < objects.length; j += 1) {
      const next = objects[j];
      if ((next.time - stackThreshold) > startTime) {
        break;
      }
      if (next.kind === 'spinner') {
        continue;
      }

      const currentStart = getRawObjectStartPositionOsu(current);
      const currentEnd = current.kind === 'slider'
        ? getRawObjectEndPositionOsu(current)
        : currentStart;
      const nextStart = getRawObjectStartPositionOsu(next);
      const nextEndTime = Number.isFinite(next.endTime) ? next.endTime : next.time;

      if (distanceBetweenOsuPositions(nextStart, currentStart) < 3) {
        current.stackIndex = (current.stackIndex || 0) + 1;
        startTime = nextEndTime;
      } else if (distanceBetweenOsuPositions(nextStart, currentEnd) < 3) {
        sliderStack += 1;
        next.stackIndex -= sliderStack;
        startTime = nextEndTime;
      }
    }
  }
};

// osu!lazer's BeatmapProcessor.applyStacking over the whole map. Lazer's version
// first widens a caller-supplied index range to whole stacks; the preview always
// passes the full map, so that range can never grow and the widening passes are
// left out rather than run for nothing.
const applyPreviewStackingModern = (objects, approachRate, stackLeniency) => {
  const stackThreshold = calculatePreviewStackThreshold(approachRate, stackLeniency);
  const stackDistance = 3;

  for (let i = objects.length - 1; i > 0; i -= 1) {
    let n = i;
    let objectI = objects[i];
    if ((objectI.stackIndex || 0) !== 0 || objectI.kind === 'spinner') {
      continue;
    }

    if (objectI.kind !== 'slider') {
      while (--n >= 0) {
        const objectN = objects[n];
        if (objectN.kind === 'spinner') {
          continue;
        }

        const objectIEndTime = Number.isFinite(objectN.endTime) ? objectN.endTime : objectN.time;
        if ((Math.trunc(objectI.time) - Math.trunc(objectIEndTime)) > stackThreshold) {
          break;
        }

        if (
          objectN.kind === 'slider'
          && distanceBetweenOsuPositions(
            getRawObjectEndPositionOsu(objectN),
            getRawObjectStartPositionOsu(objectI),
          ) < stackDistance
        ) {
          const offset = (objectI.stackIndex || 0) - (objectN.stackIndex || 0) + 1;
          for (let j = n + 1; j <= i; j += 1) {
            const objectJ = objects[j];
            if (
              distanceBetweenOsuPositions(
                getRawObjectEndPositionOsu(objectN),
                getRawObjectStartPositionOsu(objectJ),
              ) < stackDistance
            ) {
              objectJ.stackIndex -= offset;
            }
          }
          break;
        }

        if (
          distanceBetweenOsuPositions(
            getRawObjectStartPositionOsu(objectN),
            getRawObjectStartPositionOsu(objectI),
          ) < stackDistance
        ) {
          objectN.stackIndex = (objectI.stackIndex || 0) + 1;
          objectI = objectN;
        }
      }
    } else {
      while (--n >= 0) {
        const objectN = objects[n];
        if (objectN.kind === 'spinner') {
          continue;
        }
        if (objectI.time - objectN.time > stackThreshold) {
          break;
        }

        if (
          distanceBetweenOsuPositions(
            getRawObjectEndPositionOsu(objectN),
            getRawObjectStartPositionOsu(objectI),
          ) < stackDistance
        ) {
          objectN.stackIndex = (objectI.stackIndex || 0) + 1;
          objectI = objectN;
        }
      }
    }
  }
};

const applyPreviewStacking = (objects, approachRate, stackLeniency, beatmapVersion = 14, circleSize = 5) => {
  if (!Array.isArray(objects) || objects.length === 0) {
    return;
  }

  const stackOffsetUnit = getStackOffsetUnit(circleSize);
  for (const object of objects) {
    object.stackIndex = 0;
    object.stackOffsetUnit = stackOffsetUnit;
    sliderPathCache.delete(object);
    standardSliderTickCache.delete(object);
  }

  if (Number(beatmapVersion) < 6) {
    applyPreviewStackingOld(objects, approachRate, stackLeniency);
  } else {
    applyPreviewStackingModern(objects, approachRate, stackLeniency);
  }
};

// Follow points are drawn as one continuous line per pair of objects (timing
// in core/followPoints.js), at this opacity where the band is solid.
const FOLLOW_LINE_MAX_ALPHA = 0.15;
// How many stops the band's opacity is drawn in. Its profile has four corners
// of its own plus an edge fade at each end, so enough to round those off
// without parsing a colour per pixel.
const FOLLOW_LINE_GRADIENT_STEPS = 24;
// An end of the band that is an object's own centre trails off over this many
// circle radii (at most half its length), so that it is never a hard edge in
// the moments before that object is drawn and cut back out of the line. One
// radius, so the band is already at full strength where the object's edge
// will be. An end the fade itself has swept to is at nothing anyway and is
// left alone: that is what lets the band sweep in and out.
const FOLLOW_LINE_EDGE_RADII = 1;

const getObjectEndTimeMs = (object) => (
  Number.isFinite(object?.endTime) ? object.endTime : (Number(object?.time) || 0)
);

const smoothstep = (t) => t * t * (3 - (2 * t));

const FOLLOW_LINE_ALPHAS_SCRATCH = new Float32Array(FOLLOW_LINE_GRADIENT_STEPS + 1);

const drawFollowPoints = ({
  ctx,
  toCanvas,
  objects,
  currentTime,
  preemptMs,
  circleRadius,
  scale,
}) => {
  if (!Array.isArray(objects) || objects.length < 2) {
    return 0;
  }

  let drawnCount = 0;
  const followPreemptMs = getFollowLinePreemptMs(preemptMs);
  // The band is gone a fade out after the object it leads to is hit, so no
  // pair before that can still be showing. `next` is the object being searched
  // for, so start one pair earlier.
  const startIndex = Math.max(
    0,
    findFirstIndexAtOrAfter(objects, currentTime - FOLLOW_LINE_FADE_OUT_MS) - 1,
  );

  for (let i = startIndex; i < objects.length - 1; i += 1) {
    const current = objects[i];
    const next = objects[i + 1];
    if (!current || !next) continue;
    // Nothing shows until a preempt before the object behind the line ends,
    // which is at or after it starts: past that, no later pair can show yet.
    if (current.time > currentTime + followPreemptMs) break;
    // Lazer: no follow points into a new combo, or to or from a spinner.
    if ((current.comboIndex ?? 0) !== (next.comboIndex ?? 0)) continue;
    if (current.kind === 'spinner' || next.kind === 'spinner') continue;

    // From where the start object ends (a slider's end), centre to centre: the
    // objects drawn over it hide the ends while they are there.
    const start = getObjectEndPositionOsu(current);
    const end = getObjectStartPositionOsu(next);
    const line = getFollowLineAt(currentTime, {
      startTimeMs: getObjectEndTimeMs(current),
      endTimeMs: next.time,
      objectPreemptMs: preemptMs,
      distanceOsu: Math.hypot(end.x - start.x, end.y - start.y),
    });
    if (!line) continue;

    const from = toCanvas(start.x, start.y);
    const to = toCanvas(end.x, end.y);
    const deltaX = to.x - from.x;
    const deltaY = to.y - from.y;
    if (!(Math.hypot(deltaX, deltaY) > 0)) continue;

    const headX = from.x + (deltaX * line.from);
    const headY = from.y + (deltaY * line.from);
    const tailX = from.x + (deltaX * line.to);
    const tailY = from.y + (deltaY * line.to);

    const bandLength = Math.hypot(tailX - headX, tailY - headY);
    const edge = bandLength > 0
      ? Math.min((circleRadius * FOLLOW_LINE_EDGE_RADII) / bandLength, 0.5)
      : 0.5;

    let peak = 0;
    for (let k = 0; k <= FOLLOW_LINE_GRADIENT_STEPS; k += 1) {
      const offset = k / FOLLOW_LINE_GRADIENT_STEPS;
      const fromFade = line.fromCut ? smoothstep(clamp(offset / edge, 0, 1)) : 1;
      const toFade = line.toCut ? smoothstep(clamp((1 - offset) / edge, 0, 1)) : 1;
      const edgeFade = fromFade * toFade;
      const alpha = clamp(FOLLOW_LINE_MAX_ALPHA * edgeFade * followLineAlphaAt(
        line.from + ((line.to - line.from) * offset),
        line,
      ), 0, 1);
      FOLLOW_LINE_ALPHAS_SCRATCH[k] = alpha;
      if (alpha > peak) peak = alpha;
    }
    if (peak <= 0.001) continue;

    const fade = ctx.createLinearGradient(headX, headY, tailX, tailY);
    for (let k = 0; k <= FOLLOW_LINE_GRADIENT_STEPS; k += 1) {
      // Rounded well below a step of 8-bit alpha, so the colours parse from cache.
      fade.addColorStop(k / FOLLOW_LINE_GRADIENT_STEPS, `rgba(255, 255, 255, ${FOLLOW_LINE_ALPHAS_SCRATCH[k].toFixed(3)})`);
    }

    ctx.strokeStyle = fade;
    // Thinner continuous line, decoupled from circle radius
    ctx.lineWidth = Math.max(1.0, 2.5 * scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(headX, headY);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
    drawnCount += 1;
  }
  return drawnCount;
};

const createLayer = () => {
  if (typeof OffscreenCanvas !== 'function') {
    return null;
  }
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
};

// Empties a layer and sizes it to `target`'s canvas, drawing in the same
// units, so that whatever is drawn on it lands where it would on `target`.
const clearLayer = (layer, target) => {
  const { canvas, ctx } = layer;
  if (canvas.width !== target.canvas.width || canvas.height !== target.canvas.height) {
    canvas.width = target.canvas.width;
    canvas.height = target.canvas.height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(target.getTransform());
};

// Puts the follow lines down under the objects. The lines are first cut away
// wherever an object is drawn, by as much as it covers: all but gone under a
// circle that is fully in, only dimmed under one still fading in.
const composeFollowLineLayers = (target, { lines, objects }) => {
  lines.ctx.setTransform(1, 0, 0, 1, 0, 0);
  lines.ctx.globalCompositeOperation = 'destination-out';
  lines.ctx.drawImage(objects.canvas, 0, 0);
  lines.ctx.globalCompositeOperation = 'source-over';

  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.drawImage(lines.canvas, 0, 0);
  target.drawImage(objects.canvas, 0, 0);
  target.restore();
};

export class StandardRenderer {
  // `host` is the PreviewRenderer: it owns the map, the clock, the combo
  // colours and the timeline selection, which every ruleset reads from it.
  constructor(host) {
    this.host = host;
    this.visibleObjectsScratch = [];
    this.visibleIndicesScratch = [];
    this.hitTargets = [];
    this.prefixMaxEnd = null;
    this.prefixMaxEndObjects = null;
    this.sliderPathXScratch = new Float64Array(64);
    this.sliderPathYScratch = new Float64Array(64);
    // Created on first use; null where they cannot be.
    this.followLineLayers = undefined;
    this.snakingSliders = false;
    this.sliderSnakeOut = false;
    this.sliderEndCircles = true;
  }

  get mapData() { return this.host.mapData; }

  get currentTimeMs() { return this.host.currentTimeMs; }

  get comboColours() { return this.host.comboColours; }

  get maxObjectDurationMs() { return this.host.maxObjectDurationMs; }

  getControlPoints() {
    return Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
  }

  setSettings(settings = {}) {
    if (Object.hasOwn(settings, 'standardSnakingSliders')) {
      this.snakingSliders = Boolean(settings.standardSnakingSliders);
    }
    if (Object.hasOwn(settings, 'standardSliderSnakeOut')) {
      this.sliderSnakeOut = Boolean(settings.standardSliderSnakeOut);
    }
    if (Object.hasOwn(settings, 'standardSliderEndCircles')) {
      this.sliderEndCircles = Boolean(settings.standardSliderEndCircles);
    }
  }

  setBeatmap(mapData) {
    this.hitTargets = [];
    this.visibleObjectsScratch.length = 0;
    this.visibleIndicesScratch.length = 0;
    if ((mapData?.mode ?? 0) === 0 && Array.isArray(mapData?.objects)) {
      applyPreviewStacking(
        mapData.objects,
        mapData.approachRate,
        mapData.stackLeniency,
        mapData.beatmapVersion,
        mapData.circleSize,
      );
      this.prefixMaxEndObjects = mapData.objects;
      this.prefixMaxEnd = buildPrefixMaxEndTimes(mapData.objects);
    } else {
      this.prefixMaxEndObjects = null;
      this.prefixMaxEnd = null;
    }
  }

  dispose() {
    if (this.followLineLayers) {
      if (this.followLineLayers.lines?.canvas) {
        this.followLineLayers.lines.canvas.width = 0;
        this.followLineLayers.lines.canvas.height = 0;
      }
      if (this.followLineLayers.objects?.canvas) {
        this.followLineLayers.objects.canvas.width = 0;
        this.followLineLayers.objects.canvas.height = 0;
      }
    }
    this.followLineLayers = undefined;
    this.hitTargets = [];
    this.visibleObjectsScratch.length = 0;
    this.visibleIndicesScratch.length = 0;
    this.prefixMaxEnd = null;
    this.prefixMaxEndObjects = null;
  }

  render(ctx, width, height) {
    ctx.fillStyle = PLAYFIELD_BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    this.renderField(ctx, width, height);
  }

  getTimingState(time) {
    return getTimingStateAt(this.getControlPoints(), time);
  }

  ensureSliderCoordScratch(length) {
    if (length > this.sliderPathXScratch.length) {
      const nextSize = Math.max(length, this.sliderPathXScratch.length * 2);
      this.sliderPathXScratch = new Float64Array(nextSize);
      this.sliderPathYScratch = new Float64Array(nextSize);
    }
  }

  buildSliderTicks(object) {
    if (!object || object.kind !== 'slider') {
      return [];
    }

    const sliderTickRate = Number.isFinite(this.mapData?.sliderTickRate) && this.mapData.sliderTickRate > 0
      ? this.mapData.sliderTickRate
      : 1;
    const beatmapVersion = Number.isFinite(Number(this.mapData?.beatmapVersion))
      ? Number(this.mapData.beatmapVersion)
      : 14;
    const stackIndex = object.stackIndex || 0;
    const objectPreemptMs = getApproachPreemptMs(this.mapData?.approachRate);
    const cachedTicks = standardSliderTickCache.get(object);
    if (
      cachedTicks
      && Array.isArray(cachedTicks.ticks)
      && cachedTicks.sliderTickRate === sliderTickRate
      && cachedTicks.beatmapVersion === beatmapVersion
      && cachedTicks.stackIndex === stackIndex
      && cachedTicks.objectPreemptMs === objectPreemptMs
    ) {
      return cachedTicks.ticks;
    }

    const { slides, spanDuration } = getSliderSpanTiming(object);
    const pathLength = Number.isFinite(object.length) && object.length > 0
      ? Math.min(object.length, MAX_SLIDER_TICK_PATH_LENGTH)
      : 0;
    const ticks = [];
    const cacheTicks = () => {
      standardSliderTickCache.set(object, {
        sliderTickRate, beatmapVersion, stackIndex, objectPreemptMs, ticks,
      });
      return ticks;
    };

    if (pathLength <= 0) {
      return cacheTicks();
    }

    const velocity = pathLength / Math.max(1, spanDuration);
    const timingState = this.getTimingState(object.time);
    const beatLength = timingState.beatLength;
    const svMultiplier = Number.isFinite(timingState.svMultiplier) && timingState.svMultiplier > 0
      ? timingState.svMultiplier
      : 1;
    const tickDistanceMultiplier = beatmapVersion < 8 ? (1 / svMultiplier) : 1;
    const scoringDistance = velocity * beatLength;
    const tickDistance = sliderTickRate > 0
      ? ((scoringDistance / sliderTickRate) * tickDistanceMultiplier)
      : pathLength;

    if (!(Number.isFinite(tickDistance) && tickDistance > 0)) {
      return cacheTicks();
    }

    const minDistanceFromEnd = velocity * 10;

    const path = buildSliderPathPointsOsu(object);
    if (path.length < 2 || getSliderRenderPathLength(path) <= 0) {
      return cacheTicks();
    }

    // Counted rather than accumulated: adding a tick distance far smaller than
    // the running total stops changing it, and a loop on that sum never ends.
    const ticksPerSpan = Math.floor(pathLength / tickDistance);

    for (let spanIndex = 0; spanIndex < slides && ticks.length < MAX_SLIDER_TICKS; spanIndex += 1) {
      const spanStart = object.time + (spanIndex * spanDuration);
      const reversed = (spanIndex % 2) === 1;

      for (let tickIndex = 1; tickIndex <= ticksPerSpan; tickIndex += 1) {
        const d = tickIndex * tickDistance;
        if (d >= pathLength - minDistanceFromEnd || ticks.length >= MAX_SLIDER_TICKS) {
          break;
        }

        const pathProgress = d / pathLength;
        const timeProgress = reversed ? (1 - pathProgress) : pathProgress;
        const tickTime = spanStart + (timeProgress * spanDuration);

        ticks.push({
          time: tickTime,
          // osu!lazer's SliderTick.ApplyDefaultsToSelf: a tick comes in half of
          // its own way into the span ahead of its time, plus a lead-in of two
          // thirds of the approach on the first span and a flat 200ms after
          // that. Drawing them all with the slider lit the whole dotted track
          // up during the approach instead of along the ball.
          preempt: ((timeProgress * spanDuration) / 2)
            + (spanIndex > 0 ? SLIDER_TICK_REPEAT_OFFSET_MS : objectPreemptMs * 0.66),
          position: positionOnSliderPathAtProgress(path, pathProgress),
        });
      }
    }

    // Reverse spans generate ticks from high to low time; sorting once in
    // chronological order keeps ticks monotonic and enables O(log T) per-frame
    // active-window culling.
    ticks.sort((a, b) => a.time - b.time);

    return cacheTicks();
  }

  /**
   * The object under a point on the playfield, as an index into the map's
   * objects, or -1. Tested against the targets the last frame actually drew,
   * matching the scrolling rulesets so hit testing and selection rings agree
   * on geometry, CS 0, spinners, and fade-out timing.
   */
  objectIndexAtPoint(canvasX, canvasY) {
    return pickHitTarget(this.hitTargets, canvasX, canvasY);
  }

  // osu!standard uses 640×480 game coordinates with a 512×384 field centered
  // inside them. The preview is 4:3 to match, sized so a reference slider just
  // fits (see .map-preview-canvas-wrap in popup.css); the view is not cropped.
  renderField(playfieldCtx, width, height) {
    const standardLayout = getStandardPlayfieldLayout(width, height, this.mapData.circleSize, 0);
    const {
      scale,
      playfieldX,
      playfieldY,
      playfieldWidth,
      playfieldHeight,
    } = standardLayout;

    playfieldCtx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    playfieldCtx.lineWidth = 1;
    playfieldCtx.strokeRect(
      playfieldX + 0.5,
      playfieldY + 0.5,
      playfieldWidth - 1,
      playfieldHeight - 1,
    );

    const scaleX = playfieldWidth / OSU_WIDTH;
    const scaleY = playfieldHeight / OSU_HEIGHT;
    const toCanvas = (x, y) => ({
      x: playfieldX + (x * scaleX),
      y: playfieldY + (y * scaleY),
    });

    const preemptMs = getApproachPreemptMs(this.mapData.approachRate);
    const timeFadeInMs = getStandardFadeInMs(preemptMs);
    const circleRadius = getCircleRadius(this.mapData.circleSize) * scale;
    const drawnCircleRadius = Math.max(
      0.5,
      (circleRadius * DRAWN_CIRCLE_RADIUS_SCALE) - DRAWN_CIRCLE_INSET_PX,
    );
    const minVisibleTime = this.currentTimeMs - Math.max(LONG_OBJECT_POST_HIT_FADE_MS, SLIDER_HEAD_HIT_FADE_MS);
    const maxVisibleTime = this.currentTimeMs + preemptMs;

    // Objects are slightly see-through, so a follow line drawn straight under
    // them shows through and reads as lying on top. Where layers are to hand,
    // the lines go on one of their own and the objects on another, and the
    // lines are cut away under the objects before both are put down.
    const layers = this.prepareFollowLineLayers(playfieldCtx);
    const followLineCount = drawFollowPoints({
      ctx: layers ? layers.lines.ctx : playfieldCtx,
      toCanvas,
      objects: this.mapData.objects,
      currentTime: this.currentTimeMs,
      preemptMs,
      circleRadius: drawnCircleRadius,
      scale,
    });
    const layered = Boolean(layers) && followLineCount > 0;
    if (layered) {
      clearLayer(layers.objects, playfieldCtx);
    }
    const ctx = layered ? layers.objects.ctx : playfieldCtx;

    const objects = this.mapData.objects;
    if (this.prefixMaxEndObjects !== objects) {
      this.prefixMaxEndObjects = objects;
      this.prefixMaxEnd = buildPrefixMaxEndTimes(objects);
    }

    // Reused across frames: avoids throwaway arrays at 60fps and keeps object
    // indices on hand so hit targets never need O(N) objects.indexOf scans.
    const visibleObjects = this.visibleObjectsScratch;
    const visibleIndices = this.visibleIndicesScratch;
    visibleObjects.length = 0;
    visibleIndices.length = 0;
    const startIndex = findFirstIndexWithEndAtOrAfter(this.prefixMaxEnd, minVisibleTime);
    for (let i = startIndex; i < objects.length; i += 1) {
      const object = objects[i];
      if (object.time > maxVisibleTime) break;
      const endTime = Number.isFinite(object.endTime) ? object.endTime : object.time;
      if (endTime < minVisibleTime) continue;
      visibleObjects.push(object);
      visibleIndices.push(i);
    }

    this.hitTargets = [];

    // Draw latest first so earliest objects sit on top of stacks. Since
    // `objects` is time-sorted, iterating backwards is already descending order
    // without allocating or sorting every frame.
    for (let v = visibleObjects.length - 1; v >= 0; v -= 1) {
      const object = visibleObjects[v];
      const objectIndex = visibleIndices[v];
      const combo = getComboColour(this.comboColours, object);
      const sliderReverseIndicators = [];
      let sliderHeadCanvasPoint = null;
      let sliderTailCanvasPoint = null;
      let sliderHeadElapsedMs = -1;
      let sliderHeadHitProgress = 0;
      let sliderHeadHitAlpha = 0;
      let sliderHeadHitRadius = drawnCircleRadius;
      if (object.kind === 'slider') {
        const sliderHead = getObjectStartPositionOsu(object);
        const sliderTail = getSliderTailPositionOsu(object);
        sliderHeadCanvasPoint = toCanvas(sliderHead.x, sliderHead.y);
        sliderTailCanvasPoint = toCanvas(sliderTail.x, sliderTail.y);
        sliderHeadElapsedMs = this.currentTimeMs - object.time;
        if (sliderHeadElapsedMs >= 0) {
          sliderHeadHitProgress = clamp(sliderHeadElapsedMs / SLIDER_HEAD_HIT_FADE_MS, 0, 1);
          const sliderHeadHitEaseOut = 1 - ((1 - sliderHeadHitProgress) * (1 - sliderHeadHitProgress));
          sliderHeadHitAlpha = OBJECT_VISUAL_MAX_ALPHA * Math.pow(1 - sliderHeadHitEaseOut, 1.25);
          sliderHeadHitRadius = drawnCircleRadius * (1 + (SLIDER_HEAD_HIT_SCALE_BOOST * sliderHeadHitEaseOut));
        }
      }
      let objectPosition = getObjectStartPositionOsu(object);
      if (object.kind === 'slider' && this.currentTimeMs >= object.time) {
        const sampledTime = clamp(this.currentTimeMs, object.time, object.endTime);
        objectPosition = getSliderBallPositionOsu(object, sampledTime);
      }
      const point = toCanvas(objectPosition.x, objectPosition.y);
      const timeUntil = object.time - this.currentTimeMs;
      const fadeAnchorTime = object.kind === 'circle' ? object.time : (Number.isFinite(object.endTime) ? object.endTime : object.time);
      const fadeWindowMs = object.kind === 'circle'
        ? Math.max(CIRCLE_POST_HIT_FADE_MS, SLIDER_HEAD_HIT_FADE_MS)
        : LONG_OBJECT_POST_HIT_FADE_MS;
      const timeSinceFadeAnchor = this.currentTimeMs - fadeAnchorTime;

      let baseAlpha = OBJECT_VISUAL_MAX_ALPHA;
      if (timeUntil > 0) {
        const fadeInElapsedMs = preemptMs - timeUntil;
        const fadeInProgress = clamp(fadeInElapsedMs / Math.max(1, timeFadeInMs), 0, 1);
        baseAlpha = OBJECT_VISUAL_MAX_ALPHA * fadeInProgress;
      } else if (timeSinceFadeAnchor > 0) {
        const fadeOutProgress = clamp(timeSinceFadeAnchor / fadeWindowMs, 0, 1);
        const fadeOutAlpha = Math.pow(1 - fadeOutProgress, 1.8);
        baseAlpha = OBJECT_VISUAL_MAX_ALPHA * fadeOutAlpha;
      } else {
        baseAlpha = OBJECT_VISUAL_MAX_ALPHA;
      }

      let objectRenderAlpha = baseAlpha;
      let objectRenderRadius = drawnCircleRadius;
      if (object.kind === 'circle' && timeSinceFadeAnchor >= 0) {
        const circleHitProgress = clamp(timeSinceFadeAnchor / SLIDER_HEAD_HIT_FADE_MS, 0, 1);
        const circleHitEaseOut = 1 - ((1 - circleHitProgress) * (1 - circleHitProgress));
        objectRenderAlpha = OBJECT_VISUAL_MAX_ALPHA * Math.pow(1 - circleHitEaseOut, 1.25);
        objectRenderRadius = drawnCircleRadius * (1 + (SLIDER_HEAD_HIT_SCALE_BOOST * circleHitEaseOut));
      }
      if (objectRenderAlpha <= 0.001) continue;
      const sliderSharedOutlineAlpha = clamp((objectRenderAlpha * 1.12) + 0.03, 0, 1);
      const sliderSharedOutlineWidth = Math.max(1.3, objectRenderRadius * 0.1);

      if (object.kind === 'slider') {
        // Match the slider's filled body plus outline to the visible hit-circle diameter.
        const sliderBodyRadius = Math.max(0.5, objectRenderRadius - sliderSharedOutlineWidth);
        const sliderRenderPathPoints = getSliderRenderPathPointsOsu(object, scaleX, scaleY);
        let sliderDrawPointsOsu = sliderRenderPathPoints;
        const sliderRenderPathLength = getSliderRenderPathLength(sliderRenderPathPoints);
        const {
          totalDuration: sliderDuration, slides, spanDuration,
        } = getSliderSpanTiming(object);

        if (this.snakingSliders && timeUntil > 0) {
          const fadeInElapsedMs = preemptMs - timeUntil;
          // osu!lazer's SnakingSliderBody snakes over a third of the approach,
          // not over the fade-in: the two only agree at AR 5, and at AR 9 the
          // body took twice as long to reach its tail as it should have.
          const snakeProgress = clamp(fadeInElapsedMs / Math.max(1, preemptMs / 3), 0, 1);
          if (sliderRenderPathLength > 0) {
            sliderDrawPointsOsu = trimPathToLength(
              sliderRenderPathPoints,
              sliderRenderPathLength * snakeProgress,
            );
          }
        } else if (this.sliderSnakeOut && this.currentTimeMs > object.time) {
          const elapsed = clamp(this.currentTimeMs - object.time, 0, sliderDuration);
          const spanIndex = Math.min(slides - 1, Math.floor(elapsed / Math.max(1, spanDuration)));

          if (spanIndex === slides - 1 && sliderRenderPathLength > 0) {
            const spanProgress = clamp((elapsed - (spanIndex * spanDuration)) / Math.max(1, spanDuration), 0, 1);
            if ((spanIndex % 2) === 0) {
              sliderDrawPointsOsu = trimPathFromStart(
                sliderRenderPathPoints,
                sliderRenderPathLength * spanProgress,
              );
            } else {
              sliderDrawPointsOsu = trimPathToLength(
                sliderRenderPathPoints,
                sliderRenderPathLength * (1 - spanProgress),
              );
            }
          }
        }

        const drawCount = sliderDrawPointsOsu.length;
        if (drawCount > 0) {
          this.ensureSliderCoordScratch(drawCount);
          const xs = this.sliderPathXScratch;
          const ys = this.sliderPathYScratch;
          for (let i = 0; i < drawCount; i += 1) {
            xs[i] = playfieldX + (sliderDrawPointsOsu[i].x * scaleX);
            ys[i] = playfieldY + (sliderDrawPointsOsu[i].y * scaleY);
          }
          // osu!lazer's DrawableSliderTail puts the end circle on whichever end
          // the last span finishes at, which on a slider with an even number of
          // spans is back at the head rather than out at the tail.
          const tailIdx = ((slides - 1) % 2) === 0 ? drawCount - 1 : 0;
          sliderTailCanvasPoint = { x: xs[tailIdx], y: ys[tailIdx] };

          if (drawCount > 1) {
            // Trace the slider path once and stroke shadow, outline, and body
            // on the same path instead of rebuilding it 3x per frame.
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(xs[0], ys[0]);
            for (let i = 1; i < drawCount; i += 1) {
              ctx.lineTo(xs[i], ys[i]);
            }

            const sliderShadowAlpha = clamp(baseAlpha * 0.24, 0, 0.3);
            ctx.strokeStyle = withAlpha({ r: 0, g: 0, b: 0 }, sliderShadowAlpha);
            ctx.lineWidth = (sliderBodyRadius * 2 * STANDARD_OBJECT_SHADOW_SCALE) + Math.max(1.6, circleRadius * 0.2);
            ctx.stroke();

            ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, sliderSharedOutlineAlpha);
            ctx.lineWidth = (sliderBodyRadius * 2) + (sliderSharedOutlineWidth * 2);
            ctx.stroke();

            ctx.strokeStyle = withAlpha(combo, baseAlpha * 0.56);
            ctx.lineWidth = sliderBodyRadius * 2;
            ctx.stroke();
          }
        }

        // Ticks and reverse-arrow animations stay outside `drawCount > 1` so
        // `sliderSnakeOut` collapsing the body at endTime does not clip their
        // active hit-fades.
        if (sliderRenderPathPoints.length > 1) {
          const sliderTicks = this.buildSliderTicks(object);
          if (sliderTicks.length > 0) {
            const baseTickRadius = Math.max(1.6, drawnCircleRadius * 0.14);
            const firstTickIndex = findFirstIndexAtOrAfter(sliderTicks, this.currentTimeMs - SLIDER_HEAD_HIT_FADE_MS);
            const maxTickPreempt = (spanDuration / 2) + Math.max(SLIDER_TICK_REPEAT_OFFSET_MS, preemptMs * 0.66);
            for (let t = firstTickIndex; t < sliderTicks.length; t += 1) {
              const tick = sliderTicks[t];
              if (tick.time - maxTickPreempt > this.currentTimeMs) {
                break;
              }
              if (!tick?.position) {
                continue;
              }

              const tickElapsed = this.currentTimeMs - tick.time;
              const tickPreempt = Number.isFinite(tick.preempt) ? tick.preempt : 0;
              if (tickElapsed < -tickPreempt) {
                continue;
              }

              let tickAlpha = objectRenderAlpha * 0.72;
              let tickRadius = baseTickRadius;

              if (tickElapsed > 0) {
                const tickFadeProgress = clamp(tickElapsed / SLIDER_HEAD_HIT_FADE_MS, 0, 1);
                const tickEaseOut = 1 - ((1 - tickFadeProgress) * (1 - tickFadeProgress));
                tickAlpha *= (1 - tickFadeProgress);
                // Scale expansion: grow by 80% as it fades out to make it punchier.
                tickRadius = baseTickRadius * (1 + (0.8 * tickEaseOut));
              } else {
                // Comes in over lazer's 150ms, swelling from half size over four
                // times that, so a tick arrives rather than simply being there.
                const sinceAppeared = tickPreempt + tickElapsed;
                tickAlpha *= clamp(sinceAppeared / SLIDER_TICK_FADE_IN_MS, 0, 1);
                const grow = clamp(sinceAppeared / (SLIDER_TICK_FADE_IN_MS * 4), 0, 1);
                tickRadius = baseTickRadius * (0.5 + (0.5 * (1 - ((1 - grow) ** 2))));
              }
              if (tickAlpha <= 0.001) {
                continue;
              }

              const tickPoint = toCanvas(tick.position.x, tick.position.y);
              ctx.fillStyle = withAlpha({ r: 255, g: 255, b: 255 }, tickAlpha);
              ctx.beginPath();
              ctx.arc(tickPoint.x, tickPoint.y, tickRadius, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          if (slides > 1) {
            const indicatorSize = Math.max(5, drawnCircleRadius * 0.45);
            const animDuration = Math.min(300, spanDuration);
            // Only visit spans whose reverse indicator can be visible now (O(1)
            // instead of scanning up to thousands of repeats every frame).
            const firstActiveSpan = Math.max(
              0,
              Math.floor((this.currentTimeMs - animDuration - object.time) / Math.max(1, spanDuration)) - 1,
            );
            const lastActiveSpan = Math.min(
              slides - 2,
              Math.max(0, Math.floor((this.currentTimeMs - object.time) / Math.max(1, spanDuration)) + 1),
            );
            const fullPathEnd = (atEnd) => {
              const endOsu = getPathEnd(sliderRenderPathPoints, atEnd);
              return {
                position: toCanvas(endOsu.position.x, endOsu.position.y),
                direction: { x: endOsu.direction.x * scaleX, y: endOsu.direction.y * scaleY },
              };
            };
            const drawPathEnd = (atEnd) => {
              const source = drawCount > 1 ? sliderDrawPointsOsu : sliderRenderPathPoints;
              const endOsu = getPathEnd(source, atEnd);
              return {
                position: toCanvas(endOsu.position.x, endOsu.position.y),
                direction: { x: endOsu.direction.x * scaleX, y: endOsu.direction.y * scaleY },
              };
            };

            for (let spanIndex = firstActiveSpan; spanIndex <= lastActiveSpan; spanIndex += 1) {
              const reverseTime = object.time + ((spanIndex + 1) * spanDuration);
              const isAtEnd = (spanIndex % 2) === 0;
              const elapsed = this.currentTimeMs - reverseTime;
              // osu!lazer's SliderEndCircle: the first arrow fades in with the
              // slider itself, and each later one simply appears two spans
              // ahead, with no fade. Giving them all the approach preempt
              // showed the first one late on a slow slider and stacked half a
              // dozen of them at each end of a fast one.
              const reversePreempt = spanIndex === 0
                ? preemptMs + (reverseTime - object.time)
                : spanDuration * 2;
              const reverseFadeInMs = spanIndex === 0 ? timeFadeInMs : 0;

              if (-elapsed > reversePreempt) {
                continue;
              }

              let reverseAlpha = 0;
              let reverseSize = indicatorSize;
              let reverseCircleRadius = drawnCircleRadius;

              if (elapsed >= 0) {
                // Hit Animation: expand and fade out (lazer uses Math.min(300, spanDuration))
                if (elapsed >= animDuration) {
                  continue; // Fully faded out
                }
                const hitProgress = clamp(elapsed / animDuration, 0, 1);
                const hitEaseOut = 1 - ((1 - hitProgress) * (1 - hitProgress));

                reverseAlpha = OBJECT_VISUAL_MAX_ALPHA * (1 - hitEaseOut);
                reverseSize = indicatorSize * (1.0 + (0.5 * hitEaseOut)); // Expands 1.0 -> 1.5
                reverseCircleRadius = drawnCircleRadius * (1 + (SLIDER_HEAD_HIT_SCALE_BOOST * hitEaseOut));
              } else {
                const fadeInProgress = reverseFadeInMs > 0
                  ? clamp((reversePreempt + elapsed) / reverseFadeInMs, 0, 1)
                  : 1;
                reverseAlpha = OBJECT_VISUAL_MAX_ALPHA * fadeInProgress;

                // Continuous Heartbeat Pulse Animation
                // 300ms loop: 0-35ms snaps out to 1.3x, 35-285ms smoothly shrinks back to 1.0x.
                // osu!lazer times the loop from when the arrow itself appeared;
                // running it off the map clock made every arrow on screen pulse
                // together and let a new one pop in halfway through a beat.
                const loopCurrentTime = (this.currentTimeMs - (reverseTime - reversePreempt)) % 300;
                let scaleAmount = 1.0;

                if (loopCurrentTime < 35) {
                  const t = loopCurrentTime / 35;
                  const easeOut = 1 - ((1 - t) * (1 - t));
                  scaleAmount = 1.0 + (0.3 * easeOut); // 1.0 -> 1.3
                } else if (loopCurrentTime < 285) {
                  const t = (loopCurrentTime - 35) / 250;
                  const easeOut = 1 - ((1 - t) * (1 - t));
                  scaleAmount = 1.3 - (0.3 * easeOut); // 1.3 -> 1.0
                }

                reverseSize = indicatorSize * scaleAmount;
              }

              if (reverseAlpha <= 0.001) {
                continue;
              }

              // Lazer leaves a hit repeat where it was: on the last span the
              // snake pulls away from this end and would drag it along.
              sliderReverseIndicators.push({
                ...(elapsed >= 0 ? fullPathEnd(isAtEnd) : drawPathEnd(isAtEnd)),
                size: reverseSize,
                circleRadius: reverseCircleRadius,
                alpha: reverseAlpha,
              });
            }
          }
        }
      } else if (object.kind === 'spinner') {
        const centerX = playfieldX + (playfieldWidth / 2);
        const centerY = playfieldY + (playfieldHeight / 2);
        const spinnerDuration = Math.max(1, object.endTime - object.time);
        const spinnerProgress = clamp((this.currentTimeMs - object.time) / spinnerDuration, 0, 1);
        const spinnerStartRadius = Math.min(playfieldWidth, playfieldHeight) * 0.46;
        const spinnerEndRadius = Math.max(
          drawnCircleRadius * 1.1,
          Math.min(playfieldWidth, playfieldHeight) * 0.08,
        );
        const spinnerRadius = spinnerStartRadius - ((spinnerStartRadius - spinnerEndRadius) * spinnerProgress);

        ctx.strokeStyle = withAlpha({ r: 0, g: 0, b: 0 }, baseAlpha * 0.28);
        ctx.lineWidth = Math.max(3, drawnCircleRadius * 0.46);
        ctx.beginPath();
        ctx.arc(centerX, centerY, spinnerRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = withAlpha(combo, baseAlpha * 0.8);
        ctx.lineWidth = Math.max(2, drawnCircleRadius * 0.3);
        ctx.beginPath();
        ctx.arc(centerX, centerY, spinnerRadius, 0, Math.PI * 2);
        ctx.stroke();

        this.hitTargets.push({
          index: objectIndex,
          x: centerX,
          y: centerY,
          radius: spinnerRadius,
        });
        continue;
      }

      if (timeUntil > 0 && timeUntil <= preemptMs) {
        const approachProgress = clamp(timeUntil / preemptMs, 0, 1);
        const approachRadius = drawnCircleRadius * (1 + ((APPROACH_CIRCLE_START_SCALE - 1) * approachProgress));
        const approachFadeInElapsedMs = preemptMs - timeUntil;
        const approachAlpha = 0.9 * clamp(approachFadeInElapsedMs / Math.max(1, timeFadeInMs), 0, 1);
        ctx.strokeStyle = withAlpha(combo, approachAlpha);
        ctx.lineWidth = Math.max(1.5, drawnCircleRadius * 0.14);
        ctx.beginPath();
        ctx.arc(point.x, point.y, approachRadius, 0, Math.PI * 2);
        ctx.stroke();
      }

      const objectOutlineAlpha = clamp((objectRenderAlpha * 1.12) + 0.03, 0, 1);
      const objectOutlineWidth = Math.max(1.3, objectRenderRadius * 0.1);
      const sliderBallVisible = object.kind === 'slider'
        && this.currentTimeMs >= object.time
        && this.currentTimeMs <= object.endTime;
      const renderPrimaryCircle = object.kind !== 'slider'
        || this.currentTimeMs < object.time
        || sliderBallVisible;
      if (object.kind === 'slider' && this.sliderEndCircles && sliderTailCanvasPoint) {
        // On a repeat slider the tail is one more SliderEndCircle: it appears
        // two spans ahead like the reverses do, rather than stacking on their
        // circles from the start.
        const { slides, spanDuration } = getSliderSpanTiming(object);
        if (slides === 1 || this.currentTimeMs >= object.endTime - (spanDuration * 2)) {
          drawSliderEndCircle(ctx, sliderTailCanvasPoint, drawnCircleRadius, combo, objectRenderAlpha);
        }
      }

      // Latest first: each repeat comes in behind the one still at its end.
      for (let i = sliderReverseIndicators.length - 1; i >= 0; i -= 1) {
        const indicator = sliderReverseIndicators[i];
        if (this.sliderEndCircles) {
          drawSliderEndCircle(ctx, indicator.position, indicator.circleRadius, combo, indicator.alpha);
        }
        drawReverseIndicator(
          ctx,
          indicator.position,
          indicator.direction,
          indicator.size,
          indicator.alpha * 0.95,
        );
      }

      if (renderPrimaryCircle) {
        if (sliderBallVisible) {
          const sliderBallRadius = objectRenderRadius * 0.92;
          ctx.fillStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectRenderAlpha * 0.5);
          ctx.beginPath();
          ctx.arc(point.x, point.y, sliderBallRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectOutlineAlpha);
          ctx.lineWidth = objectOutlineWidth;
          ctx.beginPath();
          ctx.arc(
            point.x,
            point.y,
            Math.max(0.5, sliderBallRadius - (objectOutlineWidth * 0.5)),
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        } else {
          drawPieceCircle(ctx, point.x, point.y, objectRenderRadius, combo, objectRenderAlpha);
        }
      }

      if (object.kind === 'slider' && sliderHeadCanvasPoint && sliderHeadHitAlpha > 0.001) {
        drawPieceCircle(
          ctx,
          sliderHeadCanvasPoint.x,
          sliderHeadCanvasPoint.y,
          sliderHeadHitRadius,
          combo,
          sliderHeadHitAlpha,
        );
      }

      if ((object.kind === 'circle' || object.kind === 'slider') && Number.isFinite(object.comboNumber)) {
        let numberPosition = point;
        let numberAlpha = objectRenderAlpha * 0.98;
        let numberRadius = objectRenderRadius;
        if (object.kind === 'slider' && sliderHeadCanvasPoint) {
          numberPosition = sliderHeadCanvasPoint;
          if (sliderHeadElapsedMs >= 0) {
            numberAlpha = sliderHeadHitAlpha * 0.98;
            numberRadius = sliderHeadHitRadius;
          }
        }
        if (numberAlpha > 0.001) {
          drawComboNumber(
            ctx,
            object.comboNumber,
            numberPosition.x,
            numberPosition.y,
            numberRadius,
            numberAlpha,
          );
        }
      }

      const hitPoint = object.kind === 'slider' && sliderHeadCanvasPoint
        ? sliderHeadCanvasPoint
        : point;
      this.hitTargets.push({
        index: objectIndex,
        x: hitPoint.x,
        y: hitPoint.y,
        radius: drawnCircleRadius,
      });
    }

    if (layered) {
      composeFollowLineLayers(playfieldCtx, layers);
    }

    // Rings over everything, on the canvas itself rather than the object
    // layer: what is picked out has to stay visible through a follow line or a
    // slider drawn after it.
    this.drawSelection(playfieldCtx);
  }

  drawSelection(ctx, toCanvas = null, circleRadius = 0) {
    const selected = this.host.getSelectionToRing?.();
    if (!selected || selected.size === 0) {
      return;
    }
    if (this.hitTargets.length > 0) {
      drawSelectionRings(ctx, this.hitTargets, selected);
      return;
    }
    if (typeof toCanvas !== 'function' || !(circleRadius > 0)) {
      return;
    }
    const objects = this.mapData?.objects;
    if (!Array.isArray(objects)) {
      return;
    }
    const fallbackTargets = [];
    for (const object of this.visibleObjectsScratch) {
      const index = objects.indexOf(object);
      if (index < 0 || !selected.has(index)) {
        continue;
      }
      const position = getObjectStartPositionOsu(object);
      const point = toCanvas(position.x, position.y);
      fallbackTargets.push({ index, x: point.x, y: point.y, radius: circleRadius });
    }
    drawSelectionRings(ctx, fallbackTargets, selected);
  }

  // Two offscreen layers matched to the playfield canvas and cleared, or null
  // where there is no OffscreenCanvas (as under node) or the target has zero
  // dimensions. Only clears the lines layer upfront; the objects layer is
  // cleared only when follow lines are actually drawn this frame.
  prepareFollowLineLayers(target) {
    if (!target?.canvas || target.canvas.width <= 0 || target.canvas.height <= 0) {
      return null;
    }
    if (this.followLineLayers === undefined) {
      const lines = createLayer();
      const objects = lines && createLayer();
      this.followLineLayers = (lines && objects) ? { lines, objects } : null;
    }
    if (!this.followLineLayers) {
      return null;
    }
    clearLayer(this.followLineLayers.lines, target);
    return this.followLineLayers;
  }
}

export {
  FOLLOW_LINE_EDGE_RADII,
  FOLLOW_LINE_MAX_ALPHA,
  applyPreviewStacking,
  getCircleRadius,
  getStandardPlayfieldLayout,
};
