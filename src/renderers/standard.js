// osu!standard: circles, sliders and spinners at fixed places on the 512x384
// field, with approach circles, follow lines and the stacking pass. Drawn in
// the legacy 640x480 view (see getStandardPlayfieldLayout).

import {
  buildSliderCurvePoints,
  getPathLength,
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
  PIECE_MAX_ALPHA,
  PIECE_SHADOW_SCALE,
  SELECTION_RING_COLOUR,
  drawPieceCircle,
  OSU_VIEW_HEIGHT,
  OSU_VIEW_WIDTH,
  OSU_WIDTH,
  getApproachPreemptMs,
  getComboColour,
  withAlpha,
} from './shared.js';

const OSU_FIELD_OFFSET_X = (OSU_VIEW_WIDTH - OSU_WIDTH) / 2;
const OSU_FIELD_OFFSET_Y = (OSU_VIEW_HEIGHT - OSU_HEIGHT) / 2;
// Match the slight downward field placement observed in osu!'s legacy layout.
const OSU_FIELD_VERTICAL_SHIFT = 8;
const STANDARD_PLAYFIELD_BACKGROUND = 'rgba(19, 21, 26, 0.95)';
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
const sliderPathMetricsCache = new WeakMap();
const sliderRenderPathLengthCache = new WeakMap();
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

const getCircleRadius = (cs) => 54.4 - (4.48 * clamp(cs, 0, 10));

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
    && cachedPath.points.length >= 2
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

const getSliderPathMetrics = (path) => {
  const cached = sliderPathMetricsCache.get(path);
  if (cached) return cached;

  const cumulativeLengths = new Float64Array(path.length);
  for (let i = 1; i < path.length; i += 1) {
    cumulativeLengths[i] = cumulativeLengths[i - 1]
      + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  const metrics = { cumulativeLengths, totalLength: cumulativeLengths.at(-1) || 0 };
  sliderPathMetricsCache.set(path, metrics);
  return metrics;
};

const positionOnSliderPathAtProgress = (path, progress) => {
  if (!Array.isArray(path) || path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return path[0];

  const { cumulativeLengths, totalLength } = getSliderPathMetrics(path);
  if (totalLength <= 0) return path[0];
  const target = clamp(Number(progress) || 0, 0, 1) * totalLength;
  let low = 1;
  let high = path.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cumulativeLengths[middle] < target) low = middle + 1;
    else high = middle;
  }

  const start = path[low - 1];
  const end = path[low];
  const segmentStartLength = cumulativeLengths[low - 1];
  const segmentLength = cumulativeLengths[low] - segmentStartLength;
  const segmentProgress = segmentLength <= 0
    ? 0
    : clamp((target - segmentStartLength) / segmentLength, 0, 1);
  return {
    x: start.x + ((end.x - start.x) * segmentProgress),
    y: start.y + ((end.y - start.y) * segmentProgress),
  };
};

const getSliderRenderPathLength = (path) => {
  if (sliderRenderPathLengthCache.has(path)) {
    return sliderRenderPathLengthCache.get(path);
  }
  const length = getPathLength(path);
  sliderRenderPathLengthCache.set(path, length);
  return length;
};

// A slider's `slides` counts spans, not repeats: one span is head-to-tail, and
// each extra one is a reverse. Nearly everything that draws or times a slider
// needs the same three numbers off the back of that.
const getSliderSpanTiming = (object) => {
  const totalDuration = Math.max(1, (object.endTime || object.time) - object.time);
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

  const path = buildSliderPathPointsOsu(object, false);
  const endPosition = path.at(-1) || getRawObjectStartPositionOsu(object);
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
    if ((current.stackIndex || 0) !== 0 && current.kind !== 'slider') {
      continue;
    }

    let startTime = Number(current.endTime) || current.time;
    let sliderStack = 0;
    for (let j = i + 1; j < objects.length; j += 1) {
      const next = objects[j];
      if ((next.time - stackThreshold) > startTime) {
        break;
      }

      const currentStart = getRawObjectStartPositionOsu(current);
      const currentEnd = current.kind === 'slider'
        ? getRawObjectEndPositionOsu(current)
        : currentStart;
      const nextStart = getRawObjectStartPositionOsu(next);

      if (distanceBetweenOsuPositions(nextStart, currentStart) < 3) {
        current.stackIndex = (current.stackIndex || 0) + 1;
        startTime = next.time;
      } else if (distanceBetweenOsuPositions(nextStart, currentEnd) < 3) {
        sliderStack += 1;
        next.stackIndex -= sliderStack;
        startTime = next.time;
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

        const objectIEndTime = Number(objectN.endTime) || objectN.time;
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

    const fade = ctx.createLinearGradient(headX, headY, tailX, tailY);
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
      if (alpha > peak) peak = alpha;
      // Rounded well below a step of 8-bit alpha, so the colours parse from cache.
      fade.addColorStop(offset, `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
    }
    if (peak <= 0.001) continue;

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
    if ((mapData?.mode ?? 0) === 0 && Array.isArray(mapData?.objects)) {
      applyPreviewStacking(
        mapData.objects,
        mapData.approachRate,
        mapData.stackLeniency,
        mapData.beatmapVersion,
        mapData.circleSize,
      );
    }
  }

  render(ctx, width, height) {
    ctx.fillStyle = STANDARD_PLAYFIELD_BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    this.renderField(ctx, width, height);
  }

  getTimingState(time) {
    return getTimingStateAt(this.getControlPoints(), time);
  }

  buildSliderTicks(object) {
    if (!object || object.kind !== 'slider') {
      return [];
    }

    const sliderTickRate = Number.isFinite(this.mapData?.sliderTickRate) && this.mapData.sliderTickRate > 0
      ? this.mapData.sliderTickRate
      : 1;
    const stackIndex = object.stackIndex || 0;
    const objectPreemptMs = getApproachPreemptMs(this.mapData?.approachRate);
    const cachedTicks = standardSliderTickCache.get(object);
    if (
      cachedTicks
      && Array.isArray(cachedTicks.ticks)
      && cachedTicks.sliderTickRate === sliderTickRate
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
        sliderTickRate, stackIndex, objectPreemptMs, ticks,
      });
      return ticks;
    };

    if (pathLength <= 0) {
      return cacheTicks();
    }

    const velocity = pathLength / Math.max(1, spanDuration);
    const beatLength = this.getTimingState(object.time).beatLength;
    const scoringDistance = velocity * beatLength;
    const tickDistance = sliderTickRate > 0 ? (scoringDistance / sliderTickRate) : pathLength;

    if (!(Number.isFinite(tickDistance) && tickDistance > 0)) {
      return cacheTicks();
    }

    const minDistanceFromEnd = velocity * 10;

    const path = buildSliderPathPointsOsu(object);
    if (path.length < 2 || getPathLength(path) <= 0) {
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

    return cacheTicks();
  }

  /**
   * The object under a point on the playfield, as an index into the map's
   * objects, or -1.
   *
   * osu!standard only. There an object sits at a fixed place on the field for
   * as long as it is on screen, which is what makes it something to point at;
   * the other rulesets scroll their notes past a judgement line, so what is
   * under the pointer depends on the moment you look rather than on the note.
   *
   * Tested against the objects the last frame actually drew, so the answer can
   * never name something that is not on screen.
   */
  objectIndexAtPoint(canvasX, canvasY) {
    const objects = this.mapData?.objects;
    if ((this.mapData?.mode ?? 0) !== 0 || !Array.isArray(objects) || objects.length === 0) {
      return -1;
    }

    const width = Math.max(1, this.host.playfieldCanvas?.clientWidth || 0);
    const height = Math.max(1, this.host.playfieldCanvas?.clientHeight || 0);
    const layout = getStandardPlayfieldLayout(width, height, this.mapData.circleSize, 0);
    if (!(layout.scale > 0) || !(layout.scaleY > 0)) {
      return -1;
    }

    // Back into the map's own coordinates, where a circle's radius is one
    // number whatever the canvas is doing.
    const osuX = (canvasX - layout.playfieldX) / layout.scale;
    const osuY = (canvasY - layout.playfieldY) / layout.scaleY;
    const radiusOsu = getCircleRadius(clamp(Number(this.mapData.circleSize) || 5, 0, 10));
    const radiusSq = radiusOsu * radiusOsu;

    // The scratch list reaches a little further ahead than the objects are
    // actually drawn, so that sliders already under way are laid out. An
    // object still before its approach circle has not appeared yet and must
    // not be clickable through empty field.
    const preemptMs = getApproachPreemptMs(this.mapData.approachRate);

    let picked = null;
    for (const object of this.visibleObjectsScratch) {
      if (this.currentTimeMs < object.time - preemptMs) {
        continue;
      }
      const head = getObjectStartPositionOsu(object);
      const dx = head.x - osuX;
      const dy = head.y - osuY;
      if ((dx * dx) + (dy * dy) > radiusSq) {
        continue;
      }
      // A stack is drawn earliest on top, so that is the one being pointed at.
      if (!picked || object.time < picked.time) {
        picked = object;
      }
    }

    return picked ? objects.indexOf(picked) : -1;
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

    const toCanvas = (x, y) => ({
      x: playfieldX + ((x / OSU_WIDTH) * playfieldWidth),
      y: playfieldY + ((y / OSU_HEIGHT) * playfieldHeight),
    });

    const preemptMs = getApproachPreemptMs(this.mapData.approachRate);
    const timeFadeInMs = getStandardFadeInMs(preemptMs);
    const circleRadius = getCircleRadius(this.mapData.circleSize) * scale;
    const drawnCircleRadius = Math.max(
      0.5,
      (circleRadius * DRAWN_CIRCLE_RADIUS_SCALE) - DRAWN_CIRCLE_INSET_PX,
    );
    const minVisibleTime = this.currentTimeMs - Math.max(LONG_OBJECT_POST_HIT_FADE_MS, SLIDER_HEAD_HIT_FADE_MS);
    const maxVisibleTime = this.currentTimeMs + preemptMs + 220;

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
    const ctx = layered ? layers.objects.ctx : playfieldCtx;

    // Reused across frames: this is rebuilt every frame and discarded, and at
    // 60fps the throwaway arrays were a steady source of GC pressure.
    const visibleObjects = this.visibleObjectsScratch;
    visibleObjects.length = 0;
    for (
      let i = findFirstIndexAtOrAfter(this.mapData.objects, minVisibleTime - this.maxObjectDurationMs);
      i < this.mapData.objects.length;
      i += 1
    ) {
      const object = this.mapData.objects[i];
      if (object.time > maxVisibleTime) break;
      if (object.endTime < minVisibleTime) continue;
      visibleObjects.push(object);
    }

    visibleObjects.sort((a, b) => b.time - a.time);

    for (const object of visibleObjects) {
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
          sliderHeadHitAlpha = 0.95 * (1 - sliderHeadHitEaseOut);
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
      const fadeAnchorTime = object.kind === 'circle' ? object.time : object.endTime;
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
        const sliderRenderPathPoints = getSliderRenderPathPointsOsu(
          object,
          playfieldWidth / OSU_WIDTH,
          playfieldHeight / OSU_HEIGHT,
        );
        let sliderDrawPointsOsu = sliderRenderPathPoints;
        const sliderRenderPathLength = getSliderRenderPathLength(sliderRenderPathPoints);
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
          const {
            totalDuration: sliderDuration, slides, spanDuration,
          } = getSliderSpanTiming(object);
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
        const pathPoints = sliderDrawPointsOsu.map((p) => toCanvas(p.x, p.y));
        if (pathPoints.length > 0) {
          // osu!lazer's DrawableSliderTail puts the end circle on whichever end
          // the last span finishes at, which on a slider with an even number of
          // spans is back at the head rather than out at the tail.
          sliderTailCanvasPoint = ((getSliderSpanTiming(object).slides - 1) % 2) === 0
            ? pathPoints[pathPoints.length - 1]
            : pathPoints[0];
        }
        if (pathPoints.length > 1) {
          const sliderShadowAlpha = clamp(baseAlpha * 0.24, 0, 0.3);
          ctx.strokeStyle = withAlpha({ r: 0, g: 0, b: 0 }, sliderShadowAlpha);
          ctx.lineWidth = (sliderBodyRadius * 2 * STANDARD_OBJECT_SHADOW_SCALE) + Math.max(1.6, circleRadius * 0.2);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
          for (let i = 1; i < pathPoints.length; i += 1) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
          }
          ctx.stroke();

          ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, sliderSharedOutlineAlpha);
          ctx.lineWidth = (sliderBodyRadius * 2) + (sliderSharedOutlineWidth * 2);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
          for (let i = 1; i < pathPoints.length; i += 1) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
          }
          ctx.stroke();

          ctx.strokeStyle = withAlpha(combo, baseAlpha * 0.56);
          ctx.lineWidth = sliderBodyRadius * 2;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
          for (let i = 1; i < pathPoints.length; i += 1) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
          }
          ctx.stroke();

          const sliderTicks = this.buildSliderTicks(object);
          const baseTickRadius = Math.max(1.6, drawnCircleRadius * 0.14);
          for (const tick of sliderTicks) {
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

          if ((object.slides || 1) > 1) {
            const fullPathPoints = sliderDrawPointsOsu === sliderRenderPathPoints
              ? pathPoints
              : sliderRenderPathPoints.map((p) => toCanvas(p.x, p.y));
            const indicatorSize = Math.max(5, drawnCircleRadius * 0.45);
            const { slides, spanDuration } = getSliderSpanTiming(object);
            // Generate a reverse indicator for each span boundary.
            // Reverse at end of span i occurs at object.time + (i+1) * spanDuration.
            // Even span index → reverse at path end; odd → at path start.
            for (let spanIndex = 0; spanIndex < slides - 1; spanIndex += 1) {
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
                const animDuration = Math.min(300, spanDuration);
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
                ...getPathEnd(elapsed >= 0 ? fullPathPoints : pathPoints, isAtEnd),
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
        ctx.fillStyle = withAlpha({ r: 0, g: 0, b: 0 }, sliderHeadHitAlpha * 0.3);
        ctx.beginPath();
        ctx.arc(
          sliderHeadCanvasPoint.x,
          sliderHeadCanvasPoint.y,
          sliderHeadHitRadius * 1.1,
          0,
          Math.PI * 2,
        );
        ctx.fill();

        ctx.fillStyle = withAlpha(combo, sliderHeadHitAlpha);
        ctx.beginPath();
        ctx.arc(sliderHeadCanvasPoint.x, sliderHeadCanvasPoint.y, sliderHeadHitRadius, 0, Math.PI * 2);
        ctx.fill();

        const sliderHeadOutlineAlpha = clamp((sliderHeadHitAlpha * 1.2) + 0.05, 0, 1);
        const sliderHeadOutlineWidth = Math.max(1.5, sliderHeadHitRadius * 0.12);
        const sliderHeadOutlineRadius = Math.max(0.5, sliderHeadHitRadius - (sliderHeadOutlineWidth * 0.5));
        ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, sliderHeadOutlineAlpha);
        ctx.lineWidth = sliderHeadOutlineWidth;
        ctx.beginPath();
        ctx.arc(sliderHeadCanvasPoint.x, sliderHeadCanvasPoint.y, sliderHeadOutlineRadius, 0, Math.PI * 2);
        ctx.stroke();
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
    }

    if (layered) {
      composeFollowLineLayers(playfieldCtx, layers);
    }

    // Rings over everything, on the canvas itself rather than the object
    // layer: what is picked out has to stay visible through a follow line or a
    // slider drawn after it.
    this.drawSelection(playfieldCtx, toCanvas, drawnCircleRadius);
  }

  /**
   * A ring around each picked object that is on screen, matching the one the
   * timeline draws: the two are one selection, and it is what a copied
   * timestamp will name. Drawn by whichever playfield's map the timeline is
   * showing: the lead's, or a compared difficulty's while that one is in focus.
   */
  drawSelection(ctx, toCanvas, circleRadius) {
    if (!this.host.showsTimelineObjects()) {
      return;
    }
    const selected = this.host.selectionTimeline.selection;
    if (!selected || selected.size === 0) {
      return;
    }

    const objects = this.mapData?.objects;
    let traced = 0;
    ctx.save();
    ctx.beginPath();
    for (const object of this.visibleObjectsScratch) {
      const index = objects.indexOf(object);
      if (index < 0 || !selected.has(index)) {
        continue;
      }
      const position = getObjectStartPositionOsu(object);
      const point = toCanvas(position.x, position.y);
      const radius = circleRadius + 2.5;
      ctx.moveTo(point.x + radius, point.y);
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      traced += 1;
    }
    if (traced > 0) {
      ctx.strokeStyle = SELECTION_RING_COLOUR;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Two offscreen layers matched to the playfield canvas and cleared, or null
  // where there is no OffscreenCanvas (as under node).
  prepareFollowLineLayers(target) {
    if (this.followLineLayers === undefined) {
      const lines = createLayer();
      const objects = lines && createLayer();
      this.followLineLayers = (lines && objects) ? { lines, objects } : null;
    }
    if (!this.followLineLayers) {
      return null;
    }
    clearLayer(this.followLineLayers.lines, target);
    clearLayer(this.followLineLayers.objects, target);
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
