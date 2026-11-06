import {
  DEFAULT_MANIA_SCROLL_SPEED,
  DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM,
  calculateManiaScrollTimeMs,
} from './settings.js';
import {
  buildSliderCurvePoints,
  getPathLength,
  simplifyPathForRendering,
  trimPathFromStart,
  trimPathToLength,
} from './core/sliderPath.js';
import { getElapsedBeatsAt, getTimingSections, getTimingStateAt } from './core/controlPoints.js';
import { clamp, findFirstIndexAtOrAfter } from './core/math.js';
import {
  FOLLOW_LINE_FADE_OUT_MS,
  followLineAlphaAt,
  getFollowLineAt,
  getFollowLinePreemptMs,
} from './core/followPoints.js';
import { getCanvasContext } from './core/canvas.js';
import { TimelineRenderer } from './timeline.js';

const OSU_WIDTH = 512;
const OSU_HEIGHT = 384;
const OSU_VIEW_WIDTH = 640;
const OSU_VIEW_HEIGHT = 480;
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
const LONG_OBJECT_POST_HIT_FADE_MS = 140;
const SLIDER_HEAD_HIT_FADE_MS = 120;
const SLIDER_HEAD_HIT_SCALE_BOOST = 0.2;
// osu!lazer's DrawableSliderTick animation length, and the fixed lead-in
// SliderTick.ApplyDefaultsToSelf gives a tick on any span after the first.
const SLIDER_TICK_FADE_IN_MS = 150;
const SLIDER_TICK_REPEAT_OFFSET_MS = 200;
const COMBO_NUMBER_FONT_SCALE = 0.84;
const OBJECT_VISUAL_MAX_ALPHA = 0.84;
const STANDARD_OBJECT_SHADOW_ALPHA = 0.26;
const STANDARD_OBJECT_SHADOW_SCALE = 1.12;
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
const MANIA_SCROLL_TRAVEL_HEIGHT_SCALE = 1.34;
// Beat snaps for the timing-coloured mania notes, coarsest first so a note on a
// whole beat is never coloured as a 1/16.
const MANIA_SNAP_COLOURS = Object.freeze([
  { denominator: 1, colour: { r: 255, g: 238, b: 134 } },
  { denominator: 2, colour: { r: 105, g: 196, b: 255 } },
  { denominator: 3, colour: { r: 202, g: 146, b: 255 } },
  { denominator: 4, colour: { r: 255, g: 116, b: 162 } },
  { denominator: 6, colour: { r: 126, g: 232, b: 169 } },
  { denominator: 8, colour: { r: 255, g: 174, b: 103 } },
  { denominator: 12, colour: { r: 132, g: 255, b: 226 } },
  { denominator: 16, colour: { r: 235, g: 139, b: 255 } },
]);
const MANIA_UNSNAPPED_COLOUR = Object.freeze({ r: 255, g: 255, b: 255 });
// osu!lazer's TimingControlPoint floor for beat length.
const MIN_BEAT_LENGTH_MS = 6;
const sliderPathCache = new WeakMap();
const sliderRenderPathCache = new WeakMap();
const sliderPathMetricsCache = new WeakMap();
const sliderRenderPathLengthCache = new WeakMap();
// Unstacked slider endpoints, keyed by object. Separate from sliderPathCache
// because that one is keyed on the stack offset, which is exactly what the
// stacking algorithm has not decided yet when it asks for these.
const rawSliderEndCache = new WeakMap();
const standardSliderTickCache = new WeakMap();

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

const getApproachPreemptMs = (ar) => {
  const value = clamp(Number.isFinite(ar) ? ar : 5, 0, 11);
  if (value < 5) {
    return 1800 - (120 * value);
  }
  return 1200 - (150 * (value - 5));
};

const getStandardFadeInMs = (preemptMs) => (
  STANDARD_FADE_IN_BASE_MS * Math.min(1, Math.max(0, preemptMs) / STANDARD_FADE_IN_PREEMPT_THRESHOLD_MS)
);

const formatTime = (ms) => {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const withAlpha = (rgb, alpha) => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;

// Objects are sorted by start time but may overlap, so the visible-window
// search has to look back by the longest object in the map to avoid skipping a
// long slider or spinner that started before the window.
const getMaxObjectDurationMs = (objects) => {
  let longest = 0;
  for (const object of (objects || [])) {
    const duration = (Number(object?.endTime) || 0) - (Number(object?.time) || 0);
    if (duration > longest) {
      longest = duration;
    }
  }
  return longest;
};

const drawRoundedRect = (ctx, x, y, width, height, radius, stroke = false) => {
  const safeRadius = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  if (safeRadius <= 0 || typeof ctx.roundRect !== 'function') {
    if (stroke) ctx.strokeRect(x, y, width, height);
    else ctx.fillRect(x, y, width, height);
    return;
  }

  ctx.beginPath();
  ctx.roundRect(x, y, width, height, safeRadius);
  if (stroke) ctx.stroke();
  else ctx.fill();
};

// Matches osu!lazer's default legacy combo colours.
const DEFAULT_COLOURS = [
  { r: 255, g: 192, b: 0 },
  { r: 0, g: 202, b: 0 },
  { r: 18, g: 124, b: 255 },
  { r: 242, g: 24, b: 57 },
];

const getComboColourIndex = (object) => {
  const oneBasedIndex = Number.isFinite(object?.comboIndexWithOffsets)
    ? object.comboIndexWithOffsets
    : (Number.isFinite(object?.comboIndex) ? object.comboIndex : 1);
  return Math.max(0, oneBasedIndex - 1);
};

const getComboColour = (colours, object) => {
  const palette = (Array.isArray(colours) && colours.length > 0) ? colours : DEFAULT_COLOURS;
  const colourIndex = ((getComboColourIndex(object) % palette.length) + palette.length) % palette.length;
  return palette[colourIndex] || DEFAULT_COLOURS[0];
};

// White is the preview's own ink: a slider's border, the ball, a circle's rim
// and its combo number are all drawn in it over the combo colour. A combo
// colour near enough to white leaves nothing for them to read against, so a
// slider becomes one flat white slab with the ball lost somewhere inside it.
//
// How much a colour has in common with white is the smallest of its three
// channels, and scaling all three by one factor takes that down while leaving
// the hue and the saturation exactly where the mapper put them. Anything whose
// smallest channel is already under the cap goes through untouched, which is
// every ordinary combo colour -- the four defaults among them.
const MAX_COMBO_WHITENESS = 180;

const normalizeComboColour = (colour) => {
  const r = clamp(Math.round(Number(colour?.r) || 0), 0, 255);
  const g = clamp(Math.round(Number(colour?.g) || 0), 0, 255);
  const b = clamp(Math.round(Number(colour?.b) || 0), 0, 255);

  const whiteness = Math.min(r, g, b);
  if (whiteness <= MAX_COMBO_WHITENESS) {
    return { r, g, b };
  }

  const scale = MAX_COMBO_WHITENESS / whiteness;
  return {
    r: Math.round(r * scale),
    g: Math.round(g * scale),
    b: Math.round(b * scale),
  };
};

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
  const outlineWidth = Math.max(1.3, radius * 0.1);

  ctx.fillStyle = withAlpha({ r: 0, g: 0, b: 0 }, alpha * STANDARD_OBJECT_SHADOW_ALPHA);
  ctx.beginPath();
  ctx.arc(position.x, position.y, radius * STANDARD_OBJECT_SHADOW_SCALE, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = withAlpha({ r: 255, g: 255, b: 255 }, clamp((alpha * 0.8) + 0.012, 0, 0.78));
  ctx.beginPath();
  ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = withAlpha(combo, clamp(alpha * 0.56, 0, 1));
  ctx.beginPath();
  ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, clamp((alpha * 1.12) + 0.03, 0, 1));
  ctx.lineWidth = outlineWidth;
  ctx.beginPath();
  ctx.arc(position.x, position.y, Math.max(0.5, radius - (outlineWidth * 0.5)), 0, Math.PI * 2);
  ctx.stroke();
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

const assignComboIndices = (objects, mode = 0) => {
  let comboIndex = 0;
  let comboIndexWithOffsets = 0;
  let comboNumber = 1;
  let previousObject = null;

  for (let i = 0; i < objects.length; i += 1) {
    const object = objects[i];
    const isComboBarrier = (mode === 0 || mode === 2) && object.kind === 'spinner';
    const startsCombo = !isComboBarrier && (
      i === 0
      || Boolean(object.newCombo)
      || previousObject?.kind === 'spinner'
    );

    if (startsCombo) {
      comboIndex += 1;
      // Combo offsets are only meaningful when the beatmap explicitly marks
      // the object as a new combo. The forced combo after a spinner/banana
      // shower has no offset, matching osu!lazer's legacy decoder.
      const comboOffset = object.newCombo && !isComboBarrier
        ? Math.max(0, Number(object.comboSkip) || 0)
        : 0;
      if (comboIndexWithOffsets === 0) {
        comboIndexWithOffsets = object.newCombo && !isComboBarrier
          ? 2 + comboOffset
          : 1;
      } else {
        comboIndexWithOffsets += 1 + comboOffset;
      }
      comboNumber = 1;
    } else if (i > 0) {
      comboNumber += 1;
    }

    object.comboIndex = comboIndex;
    object.comboIndexWithOffsets = comboIndexWithOffsets;
    object.comboNumber = comboNumber;
    previousObject = object;
  }
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

export class PreviewRenderer {
  // Without a timeline canvas it draws the playfield only: the difficulties
  // shown next to the one you opened share that one's timeline, and draw to an
  // ordinary canvas rather than a low-latency one (see core/canvas.js).
  constructor(playfieldCanvas, timelineCanvas = null, { lowLatency = true } = {}) {
    this.playfieldCanvas = playfieldCanvas;
    this.timeline = timelineCanvas ? new TimelineRenderer(timelineCanvas) : null;
    this.lowLatencyPlayfield = lowLatency;
    this.mapData = null;
    this.durationMs = 0;
    this.currentTimeMs = 0;
    this.comboColours = DEFAULT_COLOURS;
    this.catcherRenderX = Number.NaN;
    this.catcherRenderTime = Number.NaN;
    this.catchCatcherTrailSamples = [];
    this.catchHyperDashHitEffects = [];
    this.catchTriggeredHitEffects = new Set();
    this.catchLastEffectTime = Number.NaN;
    this.maxObjectDurationMs = 0;
    this.maniaScrollSpeed = DEFAULT_MANIA_SCROLL_SPEED;
    this.maniaScaleScrollSpeedWithBpm = DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM;
    this.maniaScrollDirection = 'down';
    this.maniaTimingNoteColours = false;
    this.visibleObjectsScratch = [];
    // Created on first use; null where they cannot be.
    this.followLineLayers = undefined;
    this.standardSnakingSliders = false;
    this.standardSliderSnakeOut = false;
    this.standardSliderEndCircles = true;
    this.catchRenderObjects = null;
  }

  setBeatmap(mapData, durationMs, { previewTimeMs = -1 } = {}) {
    this.mapData = mapData;
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.timeline?.setBeatmap(mapData, this.durationMs, { previewTimeMs });
    this.comboColours = (Array.isArray(mapData?.comboColours) && mapData.comboColours.length > 0)
      ? mapData.comboColours.map(normalizeComboColour)
      : DEFAULT_COLOURS;

    this.maxObjectDurationMs = getMaxObjectDurationMs(mapData?.objects);

    if (Array.isArray(this.mapData?.objects)) {
      assignComboIndices(this.mapData.objects, this.mapData.mode ?? 0);
      this.catchRenderObjects = null;
      if ((this.mapData.mode ?? 0) === 2 && Array.isArray(this.mapData.catchObjects)) {
        for (const catchObject of this.mapData.catchObjects) {
          const sourceObject = this.mapData.objects[catchObject.sourceObjectIndex];
          if (sourceObject) {
            catchObject.comboIndex = sourceObject.comboIndex;
            catchObject.comboIndexWithOffsets = sourceObject.comboIndexWithOffsets;
          }
        }
      }
      if ((this.mapData.mode ?? 0) === 0) {
        applyPreviewStacking(
          this.mapData.objects,
          this.mapData.approachRate,
          this.mapData.stackLeniency,
          this.mapData.beatmapVersion,
          this.mapData.circleSize,
        );
      } else {
        this.catcherRenderX = Number.NaN;
        this.catcherRenderTime = Number.NaN;
        this.catchCatcherTrailSamples = [];
        this.catchHyperDashHitEffects = [];
        this.catchTriggeredHitEffects = new Set();
        this.catchLastEffectTime = Number.NaN;
      }
    }
  }

  /**
   * The same mania map converted again at another key count. Only the objects
   * change, so the timeline keeps its zoom and the full track's length rather
   * than starting over the way a new map does.
   */
  replaceManiaObjects(mapData) {
    this.mapData = mapData;
    this.maxObjectDurationMs = getMaxObjectDurationMs(mapData?.objects);
    this.timeline?.setObjects(mapData?.objects);
  }

  isTimelineDurationAnimating() {
    return Boolean(this.timeline?.isDurationAnimating());
  }

  setDuration(durationMs, { animate = false } = {}) {
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    return Boolean(this.timeline?.setDuration(this.durationMs, { animate }));
  }

  setTime(ms) {
    this.currentTimeMs = clamp(ms, 0, this.durationMs || 1);
    this.timeline?.setTime(this.currentTimeMs);
  }

  setPreviewSettings(settings = {}) {
    if (Object.hasOwn(settings, 'maniaScrollSpeed')) {
      this.maniaScrollSpeed = settings.maniaScrollSpeed;
    }
    if (Object.hasOwn(settings, 'maniaScaleScrollSpeedWithBpm')) {
      this.maniaScaleScrollSpeedWithBpm = Boolean(settings.maniaScaleScrollSpeedWithBpm);
    }
    if (Object.hasOwn(settings, 'maniaScrollDirection')) {
      this.maniaScrollDirection = settings.maniaScrollDirection === 'up' ? 'up' : 'down';
    }
    if (Object.hasOwn(settings, 'maniaTimingNoteColours')) {
      this.maniaTimingNoteColours = Boolean(settings.maniaTimingNoteColours);
    }
    if (Object.hasOwn(settings, 'standardSnakingSliders')) {
      this.standardSnakingSliders = Boolean(settings.standardSnakingSliders);
    }
    if (Object.hasOwn(settings, 'standardSliderSnakeOut')) {
      this.standardSliderSnakeOut = Boolean(settings.standardSliderSnakeOut);
    }
    if (Object.hasOwn(settings, 'standardSliderEndCircles')) {
      this.standardSliderEndCircles = Boolean(settings.standardSliderEndCircles);
    }
  }

  getControlPoints() {
    return Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
  }

  getManiaReferenceBpm() {
    const primaryBpm = Number(this.mapData?.primaryBpm);
    if (Number.isFinite(primaryBpm) && primaryBpm > 0) {
      return primaryBpm;
    }
    const fallbackBpm = Number(this.mapData?.bpmMin);
    return Number.isFinite(fallbackBpm) && fallbackBpm > 0 ? fallbackBpm : 120;
  }

  // A standard map converted to mania keeps its greenlines for the sliders it
  // was converted from, but they never meant anything for scroll speed.
  maniaAppliesInheritedSv() {
    return !(this.mapData?.conversion?.sourceMode === 0
      && this.mapData?.conversion?.targetMode === 3);
  }

  getManiaTimingState(time) {
    const timing = getTimingStateAt(this.getControlPoints(), time);
    return this.maniaAppliesInheritedSv() ? timing : { ...timing, svMultiplier: 1 };
  }

  // Pixels per beat at unit velocity. Scroll speed is this times the velocity
  // in force, divided by the beat length.
  getManiaPixelsPerBeat(playfieldHeight) {
    const baseScrollTimeMs = calculateManiaScrollTimeMs(this.maniaScrollSpeed, 120, false);
    const basePixelsPerMs = playfieldHeight / Math.max(1, baseScrollTimeMs);
    const referenceBpm = this.maniaScaleScrollSpeedWithBpm ? 120 : this.getManiaReferenceBpm();
    return basePixelsPerMs * (60000 / Math.max(1, referenceBpm));
  }

  getManiaPixelsPerMs(time, playfieldHeight) {
    const state = this.getManiaTimingState(time);
    return (this.getManiaPixelsPerBeat(playfieldHeight) * state.svMultiplier) / Math.max(1, state.beatLength);
  }

  /**
   * Distance a note travels between two timestamps. Scroll speed is piecewise
   * constant between control points, so this is the difference of two running
   * beat totals -- it used to re-walk the control points for every segment of
   * every note, every frame.
   */
  getManiaScrollOffset(startTime, endTime, playfieldHeight) {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime === endTime) {
      return 0;
    }

    const controlPoints = this.getControlPoints();
    const withSv = this.maniaAppliesInheritedSv();
    const elapsedBeats = getElapsedBeatsAt(controlPoints, endTime, { withSv })
      - getElapsedBeatsAt(controlPoints, startTime, { withSv });
    return elapsedBeats * this.getManiaPixelsPerBeat(playfieldHeight);
  }

  getManiaTimingNoteColour(time) {
    const timing = this.getManiaTimingState(time);
    const beatLength = Math.max(1, timing.beatLength);
    const sectionStart = Number.isFinite(timing.sectionStart) ? timing.sectionStart : 0;
    const beatPosition = (time - sectionStart) / beatLength;
    const fraction = beatPosition - Math.floor(beatPosition);
    const normalized = ((fraction % 1) + 1) % 1;

    for (const { denominator, colour } of MANIA_SNAP_COLOURS) {
      const scaled = normalized * denominator;
      if (Math.abs(scaled - Math.round(scaled)) <= 0.035) {
        return colour;
      }
    }

    return MANIA_UNSNAPPED_COLOUR;
  }

  getTaikoPixelsPerMs(time, playfieldWidth) {
    const timing = getTimingStateAt(this.getControlPoints(), time);
    const baseSliderVelocity = Number.isFinite(this.mapData?.sliderMultiplier) && this.mapData.sliderMultiplier > 0
      ? this.mapData.sliderMultiplier
      : 1.4;
    const scale = playfieldWidth / OSU_WIDTH;
    const pixelsPerBeat = 100 * baseSliderVelocity * timing.svMultiplier * scale;
    return pixelsPerBeat / Math.max(1, timing.beatLength);
  }

  getTaikoMeasureLines(visibleStart, visibleEnd) {
    const sections = getTimingSections(this.getControlPoints());
    if (sections.length === 0 || visibleEnd < visibleStart) {
      return [];
    }

    const lines = [];
    for (let i = 0; i < sections.length; i += 1) {
      const point = sections[i];
      const sectionStart = point.time;
      const meter = Number.isFinite(point.meter) && point.meter > 0 ? point.meter : 4;
      // Held to the shortest beat osu! accepts, so a corrupt beat length cannot
      // turn one frame into millions of bar lines.
      const measureLength = Math.max(MIN_BEAT_LENGTH_MS, point.beatLength) * meter;
      const sectionEnd = (i + 1 < sections.length) ? sections[i + 1].time : visibleEnd + measureLength;
      const sectionVisibleStart = Math.max(visibleStart, sectionStart);
      const sectionVisibleEnd = Math.min(visibleEnd, sectionEnd);
      if (sectionVisibleEnd < sectionVisibleStart) {
        continue;
      }
      if (!Number.isFinite(measureLength) || measureLength <= 0) {
        continue;
      }

      let measureIndex = Math.floor((sectionVisibleStart - sectionStart) / measureLength);
      if ((sectionStart + (measureIndex * measureLength)) < sectionVisibleStart) {
        measureIndex += 1;
      }

      for (; ; measureIndex += 1) {
        const measureTime = sectionStart + (measureIndex * measureLength);
        if (measureTime > sectionVisibleEnd) {
          break;
        }
        if (measureIndex === 0 && point.omitFirstBarLine) {
          continue;
        }
        lines.push(measureTime);
      }
    }

    return lines;
  }

  getStandardTimingState(time) {
    return getTimingStateAt(this.getControlPoints(), time);
  }

  buildStandardSliderTicks(object) {
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
    const pathLength = Number.isFinite(object.length) && object.length > 0 ? object.length : 0;
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
    const beatLength = this.getStandardTimingState(object.time).beatLength;
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

    for (let spanIndex = 0; spanIndex < slides; spanIndex += 1) {
      const spanStart = object.time + (spanIndex * spanDuration);
      const reversed = (spanIndex % 2) === 1;

      for (let d = tickDistance; d <= pathLength; d += tickDistance) {
        if (d >= pathLength - minDistanceFromEnd) {
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

  // Catch render objects come from the converter (convertMapForMode supplies
  // them for every catch map, native or converted). There used to be a second,
  // approximate generator here for maps without them, which nothing reached and
  // which placed droplets and bananas differently from the real one.
  getCatchRenderObjects() {
    if (Array.isArray(this.catchRenderObjects)) {
      return this.catchRenderObjects;
    }

    const catchObjects = Array.isArray(this.mapData?.catchObjects) ? this.mapData.catchObjects : [];
    this.catchRenderObjects = catchObjects
      .map((object, index) => ({ ...object, renderId: Number.isInteger(object.renderId) ? object.renderId : index }))
      .sort((a, b) => a.time - b.time || a.renderId - b.renderId);
    return this.catchRenderObjects;
  }

  applyCatchHyperDashIndicators(catchObjects, catcherWidthOsu) {
    if (!Array.isArray(catchObjects) || catchObjects.length === 0) {
      return;
    }

    const actionable = catchObjects.filter((object) => object && (object.type === 'fruit' || object.type === 'droplet'));
    const dashSpeedOsuPerMs = 1.0;

    for (const object of catchObjects) {
      if (object) {
        object.hyperDash = false;
        object.hyperDashFollowUp = false;
      }
    }

    for (let i = 0; i < actionable.length - 1; i += 1) {
      const current = actionable[i];
      const next = actionable[i + 1];
      const dt = next.time - current.time;
      if (!(Number.isFinite(dt) && dt > 0)) {
        continue;
      }

      const requiredDistance = Math.max(0, Math.abs(next.x - current.x) - catcherWidthOsu);
      const dashReach = dt * dashSpeedOsuPerMs;
      if (requiredDistance > dashReach) {
        current.hyperDash = true;
        next.hyperDashFollowUp = true;
      }
    }
  }

  getDurationLabel() {
    return formatTime(this.durationMs);
  }

  getCurrentLabel() {
    return formatTime(this.currentTimeMs);
  }

  render() {
    this.renderPlayfield();
    this.renderTimeline();
  }

  renderTimeline() {
    this.timeline?.render();
  }

  renderTaiko(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight) {
    const objects = this.mapData.objects;
    const currentTime = this.currentTimeMs;
    const laneY = playfieldY + (playfieldHeight * 0.5);
    const laneHeight = playfieldHeight * 0.22;
    const judgeX = playfieldX + (playfieldWidth * 0.12);
    const laneRightOverflow = Math.max(18, playfieldWidth * 0.055);
    const laneRightEdge = playfieldX + playfieldWidth + laneRightOverflow;
    const noteTravelWidth = (playfieldWidth * 0.82) + laneRightOverflow;
    const rightFadeWidth = Math.max(12, noteTravelWidth * 0.07);
    const rightFadeStartX = (judgeX + noteTravelWidth) - rightFadeWidth;
    const leftMeasureFadeWidth = Math.max(24, judgeX - playfieldX);
    const maxVisibleAheadMs = 8000;
    const maxVisibleBehindMs = 0;
    const spinnerFadeInMs = 1400;
    const visibleEnd = currentTime + maxVisibleAheadMs;
    const visibleStart = currentTime - maxVisibleBehindMs;
    const currentTaikoSpeed = Math.max(this.getTaikoPixelsPerMs(currentTime, playfieldWidth), 0.001);
    const measureLookBehindMs = Math.max(1000, (leftMeasureFadeWidth + 24) / currentTaikoSpeed);
    const measureVisibleStart = currentTime - measureLookBehindMs;
    const donColor = { r: 242, g: 86, b: 86 };
    const katColor = { r: 92, g: 166, b: 255 };
    const rollColor = { r: 255, g: 196, b: 84 };
    const taikoFadeAlphaAtX = (x) => {
      if (x <= rightFadeStartX) {
        return 1;
      }
      return clamp(((judgeX + noteTravelWidth) - x) / Math.max(rightFadeWidth, 1), 0, 1);
    };
    const taikoPositionAt = (targetTime, speedReferenceTime = targetTime) => (
      judgeX + ((targetTime - currentTime) * this.getTaikoPixelsPerMs(speedReferenceTime, playfieldWidth))
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(playfieldX, playfieldY, playfieldWidth, playfieldHeight);
    ctx.clip();

    ctx.fillStyle = 'rgba(28, 30, 36, 0.9)';
    ctx.fillRect(playfieldX, laneY - (laneHeight / 2), laneRightEdge - playfieldX, laneHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      playfieldX + 0.5,
      laneY - (laneHeight / 2) + 0.5,
      (laneRightEdge - playfieldX) - 1,
      laneHeight - 1,
    );

    const receptorRadius = Math.max(8, laneHeight * 0.38);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.beginPath();
    ctx.arc(judgeX, laneY, receptorRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.lineWidth = Math.max(1.2, laneHeight * 0.09);
    ctx.beginPath();
    ctx.arc(judgeX, laneY, receptorRadius, 0, Math.PI * 2);
    ctx.stroke();

    const measureLineTop = laneY - (laneHeight * 0.72);
    const measureLineBottom = laneY + (laneHeight * 0.72);
    for (const measureTime of this.getTaikoMeasureLines(measureVisibleStart, visibleEnd)) {
      const x = taikoPositionAt(measureTime, measureTime);
      if (x < (playfieldX - 12) || x > (laneRightEdge + 12)) {
        continue;
      }

      const futureDistance = Math.max(0, x - judgeX);
      const pastDistance = Math.max(0, judgeX - x);
      const alpha = measureTime >= currentTime
        ? (0.08 + (0.18 * clamp(1 - (futureDistance / Math.max(noteTravelWidth, 1)), 0, 1)))
        : (0.22 * clamp(1 - (pastDistance / Math.max(leftMeasureFadeWidth, 1)), 0, 1));
      const fadedAlpha = alpha * taikoFadeAlphaAtX(x);
      if (fadedAlpha <= 0.02) {
        continue;
      }

      ctx.strokeStyle = `rgba(255,255,255,${fadedAlpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, measureLineTop);
      ctx.lineTo(x + 0.5, measureLineBottom);
      ctx.stroke();
    }

    for (
      let i = findFirstIndexAtOrAfter(objects, visibleStart - this.maxObjectDurationMs);
      i < objects.length;
      i += 1
    ) {
      const object = objects[i];
      if (object.time > visibleEnd) {
        break;
      }
      if (object.endTime < visibleStart) {
        continue;
      }

      if (object.kind === 'spinner') {
        const duration = Math.max(1, object.endTime - object.time);
        const progress = clamp((currentTime - object.time) / duration, 0, 1);
        const radiusStart = laneHeight * 0.85;
        const radiusEnd = laneHeight * 0.28;
        const radius = radiusStart - ((radiusStart - radiusEnd) * progress);
        const alpha = currentTime < object.time
          ? clamp(1 - ((object.time - currentTime) / spinnerFadeInMs), 0, 1) * 0.6
          : clamp(1 - ((currentTime - object.endTime) / LONG_OBJECT_POST_HIT_FADE_MS), 0, 1) * 0.8;
        const fadedAlpha = alpha * taikoFadeAlphaAtX(judgeX);
        if (fadedAlpha <= 0.02) {
          continue;
        }
        ctx.strokeStyle = `rgba(255,255,255,${fadedAlpha})`;
        ctx.lineWidth = Math.max(2, laneHeight * 0.14);
        ctx.beginPath();
        ctx.arc(judgeX, laneY, radius, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      if (object.kind === 'slider' || object.kind === 'hold' || object.taikoType === 'drumroll') {
        const headX = taikoPositionAt(object.time, object.time);
        const tailX = taikoPositionAt(object.endTime, object.time);
        const leftX = Math.max(judgeX, Math.min(headX, tailX));
        const rightX = Math.max(headX, tailX);
        if (rightX <= judgeX || leftX > (laneRightEdge + 24)) {
          continue;
        }

        let alpha = 0.86;
        if (object.time > currentTime) {
          const futureDistance = Math.max(0, headX - judgeX);
          alpha = 0.18 + (0.68 * clamp(1 - (futureDistance / Math.max(noteTravelWidth, 1)), 0, 1));
        } else if (currentTime > object.endTime) {
          alpha = 0.86 * clamp(1 - ((currentTime - object.endTime) / LONG_OBJECT_POST_HIT_FADE_MS), 0, 1);
        }
        if (alpha <= 0.02) {
          continue;
        }

        const rollThickness = Math.max(6, laneHeight * 0.48);
        if (rightX > rightFadeStartX) {
          const rollGradient = ctx.createLinearGradient(leftX, laneY, rightX, laneY);
          const fadeStop = clamp((rightFadeStartX - leftX) / Math.max(rightX - leftX, 1), 0, 1);
          rollGradient.addColorStop(0, withAlpha(rollColor, alpha * 0.9));
          rollGradient.addColorStop(fadeStop, withAlpha(rollColor, alpha * 0.9));
          rollGradient.addColorStop(1, withAlpha(rollColor, 0));
          ctx.strokeStyle = rollGradient;
        } else {
          ctx.strokeStyle = withAlpha(rollColor, alpha * 0.9);
        }
        ctx.lineWidth = rollThickness;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(leftX, laneY);
        ctx.lineTo(rightX, laneY);
        ctx.stroke();

        if (rightX > rightFadeStartX) {
          const highlightGradient = ctx.createLinearGradient(leftX, laneY, rightX, laneY);
          const fadeStop = clamp((rightFadeStartX - leftX) / Math.max(rightX - leftX, 1), 0, 1);
          highlightGradient.addColorStop(0, withAlpha({ r: 255, g: 255, b: 255 }, alpha * 0.28));
          highlightGradient.addColorStop(fadeStop, withAlpha({ r: 255, g: 255, b: 255 }, alpha * 0.28));
          highlightGradient.addColorStop(1, withAlpha({ r: 255, g: 255, b: 255 }, 0));
          ctx.strokeStyle = highlightGradient;
        } else {
          ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, alpha * 0.28);
        }
        ctx.lineWidth = Math.max(1.2, rollThickness * 0.22);
        ctx.beginPath();
        ctx.moveTo(leftX, laneY);
        ctx.lineTo(rightX, laneY);
        ctx.stroke();
        continue;
      }

      const x = taikoPositionAt(object.time, object.time);
      if (x <= judgeX || x > (laneRightEdge + 20)) {
        continue;
      }
      const futureDistance = Math.max(0, x - judgeX);
      let alpha = 0.2 + (0.68 * clamp(1 - (futureDistance / Math.max(noteTravelWidth, 1)), 0, 1));
      alpha *= taikoFadeAlphaAtX(x);
      if (alpha <= 0.02) {
        continue;
      }

      const hitSound = Number.isFinite(object.hitSound) ? object.hitSound : 0;
      const isKat = object.taikoType === 'kat' || object.taikoType === 'rim'
        || ((object.taikoType !== 'don') && (hitSound & (2 | 8)) !== 0);
      const isFinish = Boolean(object.taikoStrong) || ((hitSound & 4) !== 0);
      const noteColor = isKat ? katColor : donColor;
      const baseRadius = Math.max(6, laneHeight * 0.28);
      const radius = baseRadius * (isFinish ? 1.38 : 1);
      ctx.fillStyle = withAlpha(noteColor, alpha);
      ctx.beginPath();
      ctx.arc(x, laneY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${clamp(alpha * 0.8, 0, 1)})`;
      ctx.lineWidth = Math.max(1.3, radius * 0.18);
      ctx.beginPath();
      ctx.arc(x, laneY, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  renderCatch(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight) {
    const catchObjects = this.getCatchRenderObjects();
    const currentTime = this.currentTimeMs;
    const preemptMs = getApproachPreemptMs(this.mapData.approachRate);
    const comboColours = this.comboColours;
    const circleSize = this.mapData.circleSize;
    const catcherY = playfieldY + (playfieldHeight * 0.9);
    const lookAheadMs = preemptMs;
    const postCatchFadeMs = 16;
    const lookBehindMs = Math.max(36, postCatchFadeMs + 14);
    const visibleStart = currentTime - lookBehindMs;
    const visibleEnd = currentTime + lookAheadMs + 140;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playfieldX, catcherY + 0.5);
    ctx.lineTo(playfieldX + playfieldWidth, catcherY + 0.5);
    ctx.stroke();

    const mapX = (x) => playfieldX + ((clamp(x, 0, OSU_WIDTH) / OSU_WIDTH) * playfieldWidth);

    const catcherWidth = Math.max(42, playfieldWidth * 0.1);
    const catcherHeight = Math.max(8, playfieldHeight * 0.03);
    const baseFruitRadius = Math.max(6, playfieldHeight * 0.038);
    const csRadiusScale = clamp(getCircleRadius(circleSize) / getCircleRadius(5), 0.45, 1.8);
    const fruitRadius = baseFruitRadius * csRadiusScale;
    const spawnY = playfieldY + 10;
    const catchContactY = catcherY - (catcherHeight / 2) - fruitRadius + 0.5;
    const dropDistance = Math.max(1, catchContactY - spawnY);
    const pixelsPerMs = dropDistance / lookAheadMs;
    const catcherWidthOsu = (catcherWidth / Math.max(1, playfieldWidth)) * OSU_WIDTH;
    // Depends only on the objects and the catcher's width, so it is worked out
    // when either changes. Redoing it every frame walked all of a marathon's
    // objects -- tens of thousands -- for an answer that never moved.
    const hyperDashKey = this.catchHyperDashKey;
    if (hyperDashKey?.objects !== catchObjects || hyperDashKey.catcherWidthOsu !== catcherWidthOsu) {
      this.applyCatchHyperDashIndicators(catchObjects, catcherWidthOsu);
      this.catchHyperDashKey = { objects: catchObjects, catcherWidthOsu };
    }
    const drawCatcherBody = (x, y, width, height, fillStyle) => {
      ctx.fillStyle = fillStyle;
      ctx.fillRect(x - (width / 2), y - (height / 2), width, height);
    };

    const objectScreenY = (time) => {
      const dt = time - currentTime;
      const fallingY = catchContactY - (dt * pixelsPerMs);
      return clamp(fallingY, spawnY, catchContactY);
    };

    const walkSpeedPxPerMs = (playfieldWidth / OSU_WIDTH) * 0.5;
    const dashSpeedPxPerMs = walkSpeedPxPerMs * 2;
    const resolveCatchMoveSpeedPxPerMs = (startX, endX, availableMs, hyperDashActive = false) => {
      const distancePx = Math.abs(endX - startX);
      if (!(distancePx > 0.001) || !(availableMs > 0)) {
        return 0;
      }

      const requiredSpeedPxPerMs = distancePx / Math.max(availableMs, 1);
      if (hyperDashActive) {
        return Math.max(dashSpeedPxPerMs, requiredSpeedPxPerMs);
      }
      if (requiredSpeedPxPerMs <= walkSpeedPxPerMs) {
        return walkSpeedPxPerMs;
      }
      if (requiredSpeedPxPerMs <= dashSpeedPxPerMs) {
        return dashSpeedPxPerMs;
      }
      return Math.max(dashSpeedPxPerMs, requiredSpeedPxPerMs);
    };
    const getCatchTravelPosition = (startX, endX, startTime, endTime, sampleTime, speedPxPerMs) => {
      const distancePx = Math.abs(endX - startX);
      if (!(distancePx > 0.001) || !(endTime > startTime) || !(speedPxPerMs > 0)) {
        return endX;
      }

      const moveDurationMs = distancePx / speedPxPerMs;
      const moveStartTime = endTime - moveDurationMs;
      if (sampleTime <= moveStartTime) {
        return startX;
      }
      if (sampleTime >= endTime) {
        return endX;
      }

      const travelledPx = (sampleTime - moveStartTime) * speedPxPerMs;
      return startX + (Math.sign(endX - startX) * travelledPx);
    };
    const visibleCatchTargets = [];
    for (
      let i = findFirstIndexAtOrAfter(catchObjects, currentTime - postCatchFadeMs);
      i < catchObjects.length;
      i += 1
    ) {
      const object = catchObjects[i];
      if (!object) {
        continue;
      }
      if ((object.time - currentTime) > lookAheadMs) {
        break;
      }
      if (object.type === 'banana') {
        continue;
      }

      const y = objectScreenY(object.time);
      if (y < playfieldY - 12 || y > catcherY + 8) {
        continue;
      }

      visibleCatchTargets.push(object);
    }

    const lastRenderX = Number.isFinite(this.catcherRenderX) ? this.catcherRenderX : Number.NaN;
    const lastRenderTime = Number.isFinite(this.catcherRenderTime) ? this.catcherRenderTime : Number.NaN;
    const deltaTime = currentTime - lastRenderTime;
    let previousVisible = null;
    let nextVisible = null;
    if (visibleCatchTargets.length > 0) {
      for (const object of visibleCatchTargets) {
        if (object.time <= currentTime) {
          previousVisible = object;
          continue;
        }
        nextVisible = object;
        break;
      }
    }

    let catcherX = Number.isFinite(lastRenderX)
      ? lastRenderX
      : (playfieldX + (playfieldWidth / 2));
    if (previousVisible && nextVisible && nextVisible.time > previousVisible.time) {
      const previousX = mapX(previousVisible.x);
      const nextX = mapX(nextVisible.x);
      const moveSpeedPxPerMs = resolveCatchMoveSpeedPxPerMs(
        previousX,
        nextX,
        nextVisible.time - previousVisible.time,
        previousVisible.hyperDash,
      );
      catcherX = getCatchTravelPosition(
        previousX,
        nextX,
        previousVisible.time,
        nextVisible.time,
        currentTime,
        moveSpeedPxPerMs,
      );
    } else if (nextVisible && nextVisible.time > currentTime) {
      const nextX = mapX(nextVisible.x);
      const moveSpeedPxPerMs = resolveCatchMoveSpeedPxPerMs(
        catcherX,
        nextX,
        nextVisible.time - currentTime,
        false,
      );
      if (Number.isFinite(lastRenderTime) && deltaTime > 0 && deltaTime <= 220 && moveSpeedPxPerMs > 0) {
        const stepPx = moveSpeedPxPerMs * deltaTime;
        const distancePx = nextX - catcherX;
        if (Math.abs(distancePx) <= stepPx) {
          catcherX = nextX;
        } else {
          catcherX += Math.sign(distancePx) * stepPx;
        }
      } else {
        catcherX = nextX;
      }
    } else if (previousVisible) {
      catcherX = mapX(previousVisible.x);
    }

    this.catcherRenderX = catcherX;
    if (!Number.isFinite(lastRenderX) || !Number.isFinite(lastRenderTime) || deltaTime < 0 || deltaTime > 220) {
      this.catchCatcherTrailSamples = [];
    }
    this.catcherRenderTime = currentTime;
    catcherX = this.catcherRenderX;

    if (!Number.isFinite(this.catchLastEffectTime) || currentTime < this.catchLastEffectTime - 8 || currentTime > this.catchLastEffectTime + 2000) {
      this.catchHyperDashHitEffects = [];
      this.catchTriggeredHitEffects = new Set();
    }
    this.catchLastEffectTime = currentTime;

    const catcherVelocity = (Number.isFinite(lastRenderX) && Number.isFinite(deltaTime) && deltaTime > 0)
      ? Math.abs(catcherX - lastRenderX) / deltaTime
      : 0;
    this.catchCatcherTrailSamples.push({ time: currentTime, x: catcherX });
    const trailWindowMs = 220;
    this.catchCatcherTrailSamples = this.catchCatcherTrailSamples.filter((sample) => (currentTime - sample.time) <= trailWindowMs);
    const velocityTrailStrength = clamp((catcherVelocity - 0.26) / 0.92, 0, 1);
    const velocityAfterimageCount = Math.max(0, Math.floor(velocityTrailStrength * 14));
    if (velocityAfterimageCount > 0 && this.catchCatcherTrailSamples.length > 1) {
      const trailLookbackMs = 36 + (170 * velocityTrailStrength);
      for (let i = velocityAfterimageCount; i >= 1; i -= 1) {
        const targetAge = (i / velocityAfterimageCount) * trailLookbackMs;
        const targetTime = currentTime - targetAge;
        let trailSample = this.catchCatcherTrailSamples[0];
        for (const sample of this.catchCatcherTrailSamples) {
          trailSample = sample;
          if (sample.time >= targetTime) {
            break;
          }
        }

        const layerProgress = 1 - ((i - 1) / velocityAfterimageCount);
        const easedAlpha = (0.018 + (0.17 * velocityTrailStrength)) * Math.pow(layerProgress, 1.35);
        drawCatcherBody(
          trailSample.x,
          catcherY,
          catcherWidth,
          catcherHeight,
          `rgba(255, 255, 255, ${easedAlpha})`,
        );
      }
    }

    for (
      let i = findFirstIndexAtOrAfter(catchObjects, currentTime - postCatchFadeMs);
      i < catchObjects.length;
      i += 1
    ) {
      const object = catchObjects[i];
      if (!object) {
        continue;
      }
      if (object.time > currentTime) {
        break;
      }
      if (object.type === 'banana') {
        continue;
      }
      if (!(object.hyperDash || object.hyperDashFollowUp) || this.catchTriggeredHitEffects.has(object.renderId)) {
        continue;
      }

      this.catchTriggeredHitEffects.add(object.renderId);
      this.catchHyperDashHitEffects.push({
        x: catcherX,
        y: catcherY,
        startTime: currentTime,
      });
    }

    const remainingHitEffects = [];
    for (const effect of this.catchHyperDashHitEffects) {
      const age = currentTime - effect.startTime;
      if (age < 0 || age > 220) {
        continue;
      }

      const progress = clamp(age / 220, 0, 1);
      const alpha = 0.42 * Math.pow(1 - progress, 1.5);
      const scale = 1 + (0.18 * progress);
      const lift = catcherHeight * 0.8 * progress;
      const width = catcherWidth * scale;
      const height = catcherHeight * scale;
      drawCatcherBody(effect.x, effect.y - lift, width, height, `rgba(255, 70, 70, ${alpha})`);
      remainingHitEffects.push(effect);
    }
    this.catchHyperDashHitEffects = remainingHitEffects;

    drawCatcherBody(catcherX, catcherY, catcherWidth, catcherHeight, 'rgba(255,255,255,0.85)');

    const dropletColor = { r: 176, g: 242, b: 255 };
    const tinyDropletColor = { r: 238, g: 252, b: 255 };
    const bananaColor = { r: 255, g: 222, b: 84 };

    for (
      let i = findFirstIndexAtOrAfter(catchObjects, visibleStart);
      i < catchObjects.length;
      i += 1
    ) {
      const object = catchObjects[i];
      if (object.time > visibleEnd) {
        break;
      }

      const dt = object.time - currentTime;
      if (dt > lookAheadMs) {
        continue;
      }
      const hitElapsed = Math.max(0, -dt);
      if (hitElapsed > postCatchFadeMs) {
        continue;
      }

      let alpha = 0.86;
      if (dt > 0) {
        const preHitProgress = clamp(1 - (dt / lookAheadMs), 0, 1);
        const minPreHitAlpha = 0.08;
        alpha = minPreHitAlpha + ((0.86 - minPreHitAlpha) * Math.pow(preHitProgress, 1.2));
      } else {
        alpha = 0.86 * (1 - clamp(hitElapsed / postCatchFadeMs, 0, 1));
      }
      if (alpha <= 0.02) {
        continue;
      }

      const x = mapX(object.x);
      const fallingY = catchContactY - (dt * pixelsPerMs);
      const y = clamp(fallingY, spawnY, catchContactY);
      if (y < playfieldY - 20 || y > catcherY + 8) {
        continue;
      }

      let color = getComboColour(comboColours, object);
      let radius = fruitRadius;
      if (object.type === 'droplet') {
        color = dropletColor;
        radius = fruitRadius * 0.58;
      } else if (object.type === 'tinyDroplet') {
        color = tinyDropletColor;
        radius = Math.max(1.6, fruitRadius * 0.26);
      } else if (object.type === 'banana') {
        color = bananaColor;
        radius = fruitRadius * 0.42;
      }

      ctx.fillStyle = withAlpha(color, alpha);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (object.hyperDash) {
        ctx.strokeStyle = `rgba(255, 111, 145, ${clamp(alpha * 0.95, 0, 1)})`;
        ctx.lineWidth = Math.max(1.2, radius * 0.2);
        ctx.beginPath();
        ctx.arc(x, y, radius + Math.max(2, radius * 0.28), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (object.type !== 'tinyDroplet') {
        ctx.strokeStyle = `rgba(255,255,255,${clamp(alpha * 0.8, 0, 1)})`;
        ctx.lineWidth = Math.max(1, radius * 0.18);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  renderMania(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight) {
    const objects = this.mapData.objects;
    const currentTime = this.currentTimeMs;
    const circleSize = this.mapData.circleSize;
    const keys = clamp(
      Math.round(this.mapData?.mania?.totalColumns || circleSize || 4),
      1,
      20,
    );
    // Four keys and up share the stage width between them. Fewer keep 4K's
    // lane width and leave the stage narrower, as lazer's fixed-width columns
    // do: a 1K stage spanning the whole field would be one wall of a note.
    const laneWidth = (playfieldWidth * 0.62) / Math.max(keys, 4);
    const laneAreaWidth = laneWidth * keys;
    const laneAreaX = playfieldX + ((playfieldWidth - laneAreaWidth) / 2);
    const scrollsUp = this.maniaScrollDirection === 'up';
    const receptorY = scrollsUp
      ? playfieldY + (playfieldHeight * 0.12)
      : playfieldY + (playfieldHeight * 0.88);
    const lookBehindMs = 80;
    const visibleStart = currentTime - lookBehindMs;
    const visibleEnd = currentTime + 10000;
    const centerLane = (keys % 2 === 1) ? Math.floor(keys / 2) : -1;
    const lightPinkBase = { r: 232, g: 210, b: 223 };
    const pinkBase = { r: 205, g: 113, b: 160 };
    const centerBase = { r: 231, g: 211, b: 58 };

    const getLaneGroupBase = (lane) => {
      if (lane === centerLane) {
        return centerBase;
      }
      if (centerLane >= 0) {
        const distanceFromCenter = Math.abs(lane - centerLane);
        return (distanceFromCenter % 2 === 1) ? pinkBase : lightPinkBase;
      }
      const half = keys / 2;
      const distanceFromSplit = lane < half
        ? ((half - 1) - lane)
        : (lane - half);
      return (distanceFromSplit % 2 === 0) ? pinkBase : lightPinkBase;
    };

    for (let lane = 0; lane < keys; lane += 1) {
      const laneX = laneAreaX + (lane * laneWidth);
      const base = getLaneGroupBase(lane);
      const laneAlpha = (lane % 2 === 0) ? 0.11 : 0.07;
      ctx.fillStyle = withAlpha(base, laneAlpha);
      ctx.fillRect(laneX, playfieldY, laneWidth, playfieldHeight);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(laneX + 0.5, playfieldY);
      ctx.lineTo(laneX + 0.5, playfieldY + playfieldHeight);
      ctx.stroke();
    }

    const receptorThickness = 4;
    const receptorHalf = receptorThickness / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(laneAreaX, receptorY - receptorHalf, laneAreaWidth, receptorThickness);

    const lanePadding = Math.max(2, laneWidth * 0.12);
    const noteWidth = Math.max(4, laneWidth - (lanePadding * 2));
    const noteHeight = Math.max(8, playfieldHeight * 0.03);
    // Mania notes spawn a bit above the visible field, so use a slightly larger travel distance.
    const scrollTravelHeight = playfieldHeight * MANIA_SCROLL_TRAVEL_HEIGHT_SCALE;
    const currentPixelsPerMs = Math.max(0.001, this.getManiaPixelsPerMs(currentTime, scrollTravelHeight));
    const edgeFadeHeight = Math.max(16, playfieldHeight * 0.11);
    const topFadeEndY = playfieldY + edgeFadeHeight;
    const bottomFadeStartY = playfieldY + playfieldHeight - edgeFadeHeight;
    const postJudgeTravelPx = Math.max(receptorHalf, noteHeight * 0.25);
    const postJudgeDelayMs = postJudgeTravelPx / currentPixelsPerMs;
    const holdBodyClampY = scrollsUp ? receptorY - receptorHalf : receptorY + receptorHalf;
    const receptorVanishCenterY = receptorY + ((scrollsUp ? -1 : 1) * receptorHalf * 0.5);
    const receptorVanishFadePx = Math.max(1, receptorHalf);

    for (
      let i = findFirstIndexAtOrAfter(objects, visibleStart - this.maxObjectDurationMs);
      i < objects.length;
      i += 1
    ) {
      const object = objects[i];
      if (object.time > visibleEnd) {
        break;
      }
      if (object.endTime < visibleStart) {
        continue;
      }
      const isHoldNote = object.kind === 'hold' || object.endTime > object.time;
      const dt = object.time - currentTime;
      const holdEndClampTime = object.endTime + postJudgeDelayMs;
      if (isHoldNote && currentTime > holdEndClampTime) {
        continue;
      }

      let alpha = 0.9;
      if (isHoldNote) {
        alpha = 0.9;
      } else if (dt < 0) {
        const postHitElapsed = (-dt) - postJudgeDelayMs;
        if (postHitElapsed <= 0) {
          alpha = 0.9;
        } else {
          alpha = 0.9 * clamp(1 - (postHitElapsed / CIRCLE_POST_HIT_FADE_MS), 0, 1);
        }
      }
      if (alpha <= 0.02) {
        continue;
      }

      const lane = clamp(
        Number.isInteger(object.column)
          ? object.column
          : Math.floor((clamp(object.x, 0, OSU_WIDTH - 0.001) / OSU_WIDTH) * keys),
        0,
        keys - 1,
      );
      const laneX = laneAreaX + (lane * laneWidth);
      const noteX = laneX + lanePadding;
      const scrollOffset = this.getManiaScrollOffset(currentTime, object.time, scrollTravelHeight);
      const rawHeadY = receptorY + ((scrollsUp ? 1 : -1) * scrollOffset) - (noteHeight / 2);
      const headY = (isHoldNote && currentTime >= object.time && currentTime <= holdEndClampTime)
        ? (receptorY - (noteHeight / 2))
        : rawHeadY;
      const shouldRenderHoldBody = isHoldNote && currentTime <= holdEndClampTime;

      const noteCenterY = headY + (noteHeight / 2);
      if (!isHoldNote && dt > 0) {
        const futureDistance = clamp(Math.abs(receptorY - noteCenterY), 0, playfieldHeight);
        alpha = 0.24 + (0.66 * clamp(1 - (futureDistance / Math.max(playfieldHeight, 1)), 0, 1));
      }
      if (!scrollsUp && noteCenterY < topFadeEndY) {
        alpha *= clamp((noteCenterY - playfieldY) / Math.max(edgeFadeHeight, 1), 0, 1);
        if (alpha <= 0.02) {
          continue;
        }
      } else if (scrollsUp && noteCenterY > bottomFadeStartY) {
        alpha *= clamp(((playfieldY + playfieldHeight) - noteCenterY) / Math.max(edgeFadeHeight, 1), 0, 1);
        if (alpha <= 0.02) {
          continue;
        }
      }

      if (!isHoldNote) {
        const overPx = scrollsUp
          ? receptorVanishCenterY - noteCenterY
          : noteCenterY - receptorVanishCenterY;
        if (overPx > 0) {
          alpha *= clamp(1 - (overPx / receptorVanishFadePx), 0, 1);
          if (alpha <= 0.02) {
            continue;
          }
        }
      }

      const groupBase = getLaneGroupBase(lane);
      const noteColor = {
        r: Math.min(255, groupBase.r + 16),
        g: Math.min(255, groupBase.g + 16),
        b: Math.min(255, groupBase.b + 16),
      };
      const noteFillColour = this.maniaTimingNoteColours
        ? this.getManiaTimingNoteColour(object.time)
        : noteColor;

      if (shouldRenderHoldBody) {
        const tailOffset = this.getManiaScrollOffset(currentTime, object.endTime, scrollTravelHeight);
        const tailY = receptorY + ((scrollsUp ? 1 : -1) * tailOffset) + (noteHeight / 2);
        const bodyTop = Math.max(playfieldY - 20, Math.min(headY, tailY));
        const bodyBottom = Math.min(
          scrollsUp ? (playfieldY + playfieldHeight + 20) : holdBodyClampY,
          Math.max(headY + noteHeight, tailY),
        );
        const bodyHeight = bodyBottom - bodyTop;
        if (bodyHeight > 2) {
          const bodyAlpha = alpha * 0.35;
          if (!scrollsUp && bodyTop < topFadeEndY) {
            const fadeStop = clamp((topFadeEndY - bodyTop) / Math.max(bodyHeight, 1), 0, 1);
            const startAlpha = bodyTop <= playfieldY
              ? 0
              : bodyAlpha * clamp((bodyTop - playfieldY) / Math.max(edgeFadeHeight, 1), 0, 1);
            const bodyGradient = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
            bodyGradient.addColorStop(0, withAlpha(noteFillColour, startAlpha));
            bodyGradient.addColorStop(fadeStop, withAlpha(noteFillColour, bodyAlpha));
            bodyGradient.addColorStop(1, withAlpha(noteFillColour, bodyAlpha));
            ctx.fillStyle = bodyGradient;
          } else if (scrollsUp && bodyBottom > bottomFadeStartY) {
            const fadeStart = clamp((bottomFadeStartY - bodyTop) / Math.max(bodyHeight, 1), 0, 1);
            const endAlpha = bodyBottom >= playfieldY + playfieldHeight
              ? 0
              : bodyAlpha * clamp(((playfieldY + playfieldHeight) - bodyBottom) / Math.max(edgeFadeHeight, 1), 0, 1);
            const bodyGradient = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
            bodyGradient.addColorStop(0, withAlpha(noteFillColour, bodyAlpha));
            bodyGradient.addColorStop(fadeStart, withAlpha(noteFillColour, bodyAlpha));
            bodyGradient.addColorStop(1, withAlpha(noteFillColour, endAlpha));
            ctx.fillStyle = bodyGradient;
          } else {
            ctx.fillStyle = withAlpha(noteFillColour, bodyAlpha);
          }
          drawRoundedRect(
            ctx,
            noteX + (noteWidth * 0.2),
            bodyTop,
            noteWidth * 0.6,
            bodyHeight,
            Math.min(3, noteHeight * 0.28),
          );
        }
      }

      if (headY > playfieldY + playfieldHeight + 20 || (headY + noteHeight) < playfieldY - 20) {
        continue;
      }

      ctx.fillStyle = withAlpha(noteFillColour, alpha);
      drawRoundedRect(ctx, noteX, headY, noteWidth, noteHeight, Math.min(3, noteHeight * 0.28));
      ctx.strokeStyle = `rgba(255,255,255,${clamp(alpha * 0.8, 0, 1)})`;
      ctx.lineWidth = 1;
      drawRoundedRect(
        ctx,
        noteX + 0.5,
        headY + 0.5,
        noteWidth - 1,
        noteHeight - 1,
        Math.min(2.5, noteHeight * 0.25),
        true,
      );
    }
  }

  renderPlayfield() {
    const { ctx, width, height } = getCanvasContext(this.playfieldCanvas, { lowLatency: this.lowLatencyPlayfield });

    ctx.fillStyle = 'rgba(8, 8, 10, 0.85)';
    ctx.fillRect(0, 0, width, height);

    if (!this.mapData || !Array.isArray(this.mapData.objects) || this.mapData.objects.length === 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.font = '600 14px Torus, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No preview data available', width / 2, height / 2);
      return;
    }

    const mode = this.mapData.mode ?? 0;
    if (mode === 0) {
      ctx.fillStyle = STANDARD_PLAYFIELD_BACKGROUND;
      ctx.fillRect(0, 0, width, height);
      this.renderStandard(ctx, width, height);
      return;
    }

    const padding = 14;
    const availableWidth = Math.max(10, width - (padding * 2));
    const availableHeight = Math.max(10, height - (padding * 2));
    const scale = Math.min(availableWidth / OSU_WIDTH, availableHeight / OSU_HEIGHT);
    const playfieldWidth = OSU_WIDTH * scale;
    const playfieldHeight = OSU_HEIGHT * scale;
    const playfieldX = Math.floor((width - playfieldWidth) / 2);
    const playfieldY = Math.floor((height - playfieldHeight) / 2);

    ctx.fillStyle = 'rgba(19, 21, 26, 0.95)';
    ctx.fillRect(playfieldX, playfieldY, playfieldWidth, playfieldHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(playfieldX + 0.5, playfieldY + 0.5, playfieldWidth - 1, playfieldHeight - 1);

    if (mode === 1) {
      this.renderTaiko(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight);
    } else if (mode === 2) {
      this.renderCatch(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight);
    } else {
      this.renderMania(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight);
    }
  }

  // osu!standard uses 640×480 game coordinates with a 512×384 field centered
  // inside them. The preview crops only the vertical view to the calibrated slider bounds.
  renderStandard(playfieldCtx, width, height) {
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
        if (this.standardSnakingSliders && timeUntil > 0) {
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
        } else if (this.standardSliderSnakeOut && this.currentTimeMs > object.time) {
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

          const sliderTicks = this.buildStandardSliderTicks(object);
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

      const objectBodyBaseAlpha = clamp((objectRenderAlpha * 0.8) + 0.012, 0, 0.78);
      const objectBodyComboAlpha = clamp(objectRenderAlpha * 0.56, 0, 1);
      const objectOutlineAlpha = clamp((objectRenderAlpha * 1.12) + 0.03, 0, 1);
      const objectOutlineWidth = Math.max(1.3, objectRenderRadius * 0.1);
      const objectOutlineRadius = Math.max(0.5, objectRenderRadius - (objectOutlineWidth * 0.5));
      const sliderBallVisible = object.kind === 'slider'
        && this.currentTimeMs >= object.time
        && this.currentTimeMs <= object.endTime;
      const renderPrimaryCircle = object.kind !== 'slider'
        || this.currentTimeMs < object.time
        || sliderBallVisible;
      if (object.kind === 'slider' && this.standardSliderEndCircles && sliderTailCanvasPoint) {
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
        if (this.standardSliderEndCircles) {
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
          ctx.fillStyle = withAlpha({ r: 0, g: 0, b: 0 }, objectRenderAlpha * STANDARD_OBJECT_SHADOW_ALPHA);
          ctx.beginPath();
          ctx.arc(point.x, point.y, objectRenderRadius * STANDARD_OBJECT_SHADOW_SCALE, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectBodyBaseAlpha);
          ctx.beginPath();
          ctx.arc(point.x, point.y, objectRenderRadius, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = withAlpha(combo, objectBodyComboAlpha);
          ctx.beginPath();
          ctx.arc(point.x, point.y, objectRenderRadius, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectOutlineAlpha);
          ctx.lineWidth = objectOutlineWidth;
          ctx.beginPath();
          ctx.arc(point.x, point.y, objectOutlineRadius, 0, Math.PI * 2);
          ctx.stroke();
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
  DEFAULT_COLOURS,
  FOLLOW_LINE_EDGE_RADII,
  FOLLOW_LINE_MAX_ALPHA,
  MAX_COMBO_WHITENESS,
  assignComboIndices,
  applyPreviewStacking,
  formatTime,
  getComboColour,
  normalizeComboColour,
  getCircleRadius,
  getStandardPlayfieldLayout,
};
