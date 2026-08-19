import {
  DEFAULT_MANIA_SCROLL_SPEED,
  DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM,
  calculateManiaScrollTimeMs,
} from './settings.js';
import {
  buildSliderCurvePoints,
  getPathLength,
  pointDistance,
  trimPathFromStart,
  trimPathToLength,
} from './core/sliderPath.js';
import { getTimingStateAt } from './core/controlPoints.js';

const OSU_WIDTH = 512;
const OSU_HEIGHT = 384;
// osu!lazer: StackOffset = StackHeight * Scale * -6.4, with Scale = radius/64,
// so one stack level is worth radius/10 osu! pixels — 4.5px at CS 2 down to
// 2.3px at CS 7. This constant is only the CS 5 value, used as a fallback when
// an object has not been through the stacking pass.
const STACK_OFFSET_OSU_AT_CS5 = 3.2;
const getStackOffsetUnit = (circleSize) => getCircleRadius(circleSize) / 10;
const DRAWN_CIRCLE_RADIUS_SCALE = 0.92;
const CIRCLE_POST_HIT_FADE_MS = 120;
const LONG_OBJECT_POST_HIT_FADE_MS = 140;
const SLIDER_HEAD_HIT_FADE_MS = 120;
const SLIDER_HEAD_HIT_SCALE_BOOST = 0.2;
const COMBO_NUMBER_FONT_SCALE = 0.84;
const OBJECT_VISUAL_MAX_ALPHA = 0.84;
const STANDARD_OBJECT_SHADOW_ALPHA = 0.26;
const STANDARD_OBJECT_SHADOW_SCALE = 1.12;
const STANDARD_FADE_IN_BASE_MS = 400;
const STANDARD_FADE_IN_PREEMPT_THRESHOLD_MS = 450;
const APPROACH_CIRCLE_START_SCALE = 4;
const MANIA_SCROLL_TRAVEL_HEIGHT_SCALE = 1.34;
const MAX_CANVAS_DPR = 2;
const CANVAS_CONTEXT_OPTIONS = { alpha: false, desynchronized: true };
const canvasContextCache = new WeakMap();
const sliderPathCache = new WeakMap();
// Unstacked slider endpoints, keyed by object. Separate from sliderPathCache
// because that one is keyed on the stack offset, which is exactly what the
// stacking algorithm has not decided yet when it asks for these.
const rawSliderEndCache = new WeakMap();
const standardSliderTickCache = new WeakMap();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Hit objects and catch render objects are kept sorted by `time`, so the start
// of the visible window can be found with a binary search rather than scanning
// from index 0 on every frame.
const findFirstIndexAtOrAfter = (items, timeMs) => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const value = items[mid]?.time;
    if (Number.isFinite(value) && value < timeMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

const getCircleRadius = (cs) => 54.4 - (4.48 * clamp(cs, 0, 10));

const getStandardPlayfieldLayout = (canvasWidth, canvasHeight, circleSize, padding = 0) => {
  const width = Math.max(1, Number(canvasWidth) || 1);
  const height = Math.max(1, Number(canvasHeight) || 1);
  const safePadding = Math.max(0, Number(padding) || 0);
  const availableWidth = Math.max(10, width - (safePadding * 2));
  const availableHeight = Math.max(10, height - (safePadding * 2));
  const edgeRadiusOsu = Math.max(0, getCircleRadius(circleSize) * DRAWN_CIRCLE_RADIUS_SCALE);
  const scale = Math.min(
    availableWidth / (OSU_WIDTH + (edgeRadiusOsu * 2)),
    availableHeight / (OSU_HEIGHT + (edgeRadiusOsu * 2)),
  );
  const playfieldWidth = OSU_WIDTH * scale;
  const playfieldHeight = OSU_HEIGHT * scale;
  const edgePadding = edgeRadiusOsu * scale;
  const visualWidth = playfieldWidth + (edgePadding * 2);
  const visualHeight = playfieldHeight + (edgePadding * 2);
  const visualX = (width - visualWidth) / 2;
  const visualY = (height - visualHeight) / 2;
  const playfieldX = visualX + edgePadding;
  const playfieldY = visualY + edgePadding;

  return {
    scale,
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

const getSliderBallPositionOsu = (object, currentTime) => {
  const path = buildSliderPathPointsOsu(object);

  if (path.length <= 1) {
    const offset = getObjectStackOffset(object);
    return { x: object.x + offset.x, y: object.y + offset.y };
  }

  const totalDuration = Math.max(1, (object.endTime || object.time) - object.time);
  const slides = Math.max(1, object.slides || 1);
  const spanDuration = totalDuration / slides;
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
  const localProgress = isForward ? spanProgress : (1 - spanProgress);

  const segmentLengths = [];
  let totalPathLength = 0;
  for (let i = 1; i < path.length; i += 1) {
    const dx = path[i].x - path[i - 1].x;
    const dy = path[i].y - path[i - 1].y;
    const length = Math.hypot(dx, dy);
    segmentLengths.push(length);
    totalPathLength += length;
  }

  if (totalPathLength <= 0) {
    return { x: object.x, y: object.y };
  }

  let targetDistance = localProgress * totalPathLength;
  for (let i = 0; i < segmentLengths.length; i += 1) {
    const segmentLength = segmentLengths[i];
    const start = path[i];
    const end = path[i + 1];

    if (targetDistance <= segmentLength || i === segmentLengths.length - 1) {
      const t = segmentLength <= 0 ? 0 : clamp(targetDistance / segmentLength, 0, 1);
      return {
        x: start.x + ((end.x - start.x) * t),
        y: start.y + ((end.y - start.y) * t),
      };
    }
    targetDistance -= segmentLength;
  }

  return path[path.length - 1];
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

const drawComboNumber = (ctx, text, x, y, radius, alpha = 1) => {
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

const deterministicUnitValue = (seed) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
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
      comboIndexWithOffsets += 1 + comboOffset;
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

const applyPreviewStackingModern = (objects, approachRate, stackLeniency) => {
  const stackThreshold = calculatePreviewStackThreshold(approachRate, stackLeniency);
  const stackDistance = 3;
  let extendedEndIndex = objects.length - 1;

  // Extend the range when a stack continues beyond the caller-provided end.
  // The preview processes the whole map, but retaining this pass mirrors lazer's
  // handling of partial update ranges and keeps the dependency explicit.
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    let stackBaseIndex = i;
    for (let n = stackBaseIndex + 1; n < objects.length; n += 1) {
      const stackBaseObject = objects[stackBaseIndex];
      const objectN = objects[n];
      if (stackBaseObject.kind === 'spinner') {
        break;
      }
      if (objectN.kind === 'spinner') {
        continue;
      }

      const stackBaseEndTime = Number(stackBaseObject.endTime) || stackBaseObject.time;
      if (objectN.time - stackBaseEndTime > stackThreshold) {
        break;
      }

      const stackedOnStart = getRawObjectStartPositionOsu(objectN);
      if (
        distanceBetweenOsuPositions(getRawObjectStartPositionOsu(stackBaseObject), stackedOnStart) < stackDistance
        || (
          stackBaseObject.kind === 'slider'
          && distanceBetweenOsuPositions(getRawObjectEndPositionOsu(stackBaseObject), stackedOnStart) < stackDistance
        )
      ) {
        stackBaseIndex = n;
        objectN.stackIndex = 0;
      }
    }

    if (stackBaseIndex > extendedEndIndex) {
      extendedEndIndex = stackBaseIndex;
    }
  }

  let extendedStartIndex = 0;
  for (let i = extendedEndIndex; i > 0; i -= 1) {
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

        if (n < extendedStartIndex) {
          objectN.stackIndex = 0;
          extendedStartIndex = n;
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

const buildDensityBins = (objects, durationMs, bins = 150, startTimeMs = 0) => {
  if (!Array.isArray(objects) || objects.length === 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return new Array(bins).fill(0);
  }

  const counts = new Array(bins).fill(0);
  const endTimeMs = startTimeMs + durationMs;
  for (const object of objects) {
    if (!object || object.time < startTimeMs || object.time > endTimeMs) {
      continue;
    }
    const ratio = clamp((object.time - startTimeMs) / durationMs, 0, 1);
    const index = Math.min(bins - 1, Math.floor(ratio * bins));
    counts[index] += 1;
  }

  const max = Math.max(...counts, 1);
  return counts.map((count) => count / max);
};

const easeOutCubic = (t) => 1 - ((1 - clamp(t, 0, 1)) ** 3);

const getCanvasContext = (canvas) => {
  let cached = canvasContextCache.get(canvas);
  if (!cached) {
    cached = {
      ctx: canvas.getContext('2d', CANVAS_CONTEXT_OPTIONS) || canvas.getContext('2d'),
    };
    canvasContextCache.set(canvas, cached);
  }

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  const { ctx } = cached;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
};

const drawFollowPoints = ({
  ctx,
  toCanvas,
  objects,
  currentTime,
  preemptMs,
  minVisibleTime,
  maxVisibleTime,
  maxObjectDurationMs = 0,
  circleRadius,
  scale,
}) => {
  if (!Array.isArray(objects) || objects.length < 2) {
    return;
  }

  const timeFadeInMs = getStandardFadeInMs(preemptMs);
  // `next` is the object being filtered, so start one pair earlier than the
  // first candidate index.
  const startIndex = Math.max(
    0,
    findFirstIndexAtOrAfter(objects, minVisibleTime - maxObjectDurationMs) - 1,
  );

  for (let i = startIndex; i < objects.length - 1; i += 1) {
    const current = objects[i];
    const next = objects[i + 1];
    if (!current || !next) continue;
    if (next.time > maxVisibleTime) break;
    if ((current.comboIndex ?? 0) !== (next.comboIndex ?? 0)) continue;
    if (current.kind === 'spinner' || next.kind === 'spinner') continue;
    if (next.endTime < minVisibleTime) continue;

    const shootDuration = Math.min(250, timeFadeInMs);
    const fadeInStart = next.time - preemptMs;
    const fadeInEnd = fadeInStart + shootDuration;
    const fadeOutEnd = next.time;
    // Quick opacity fade right before the hit, without any retract animation
    const fadeOutStart = Math.max(fadeInEnd, next.time - 120);

    if (currentTime < fadeInStart || currentTime > fadeOutEnd) continue;

    const start = getObjectEndPositionOsu(current);
    const end = getObjectStartPositionOsu(next);

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);

    // Do not draw if the gap is too small to fit between the hitcircles
    if (!Number.isFinite(distance) || distance <= 100) continue;

    // Progress of the line shooting out towards the next object
    let headProgress = 1;
    if (currentTime < fadeInEnd) {
      const p = clamp((currentTime - fadeInStart) / shootDuration, 0, 1);
      headProgress = 1 - Math.pow(1 - p, 4); // Extremely aggressive ease-out
    }

    let alpha = 0.45;
    if (currentTime > fadeOutStart) {
      const alphaProgress = clamp((currentTime - fadeOutStart) / (fadeOutEnd - fadeOutStart), 0, 1);
      alpha = 0.45 * (1 - alphaProgress); // Quick linear fade out
    }

    if (alpha <= 0.001) continue;

    const startCanvas = toCanvas(start.x, start.y);
    const endCanvas = toCanvas(end.x, end.y);

    const canvasDx = endCanvas.x - startCanvas.x;
    const canvasDy = endCanvas.y - startCanvas.y;
    const canvasDistance = Math.hypot(canvasDx, canvasDy);
    if (canvasDistance < 0.001) continue;

    const nx = canvasDx / canvasDistance;
    const ny = canvasDy / canvasDistance;

    // Trim the start and end by the radius so the line connects cleanly edge-to-edge
    const trim = circleRadius * 1.05;
    const fromX = startCanvas.x + (nx * trim);
    const fromY = startCanvas.y + (ny * trim);
    const toX = endCanvas.x - (nx * trim);
    const toY = endCanvas.y - (ny * trim);

    const drawFromX = fromX;
    const drawFromY = fromY;
    const drawToX = fromX + ((toX - fromX) * headProgress);
    const drawToY = fromY + ((toY - fromY) * headProgress);

    ctx.strokeStyle = `rgba(255, 255, 255, ${clamp(alpha, 0, 1)})`;
    // Thinner continuous line, decoupled from circle radius
    ctx.lineWidth = Math.max(1.0, 2.5 * scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(drawFromX, drawFromY);
    ctx.lineTo(drawToX, drawToY);
    ctx.stroke();
  }
};

export class PreviewRenderer {
  constructor(playfieldCanvas, timelineCanvas) {
    this.playfieldCanvas = playfieldCanvas;
    this.timelineCanvas = timelineCanvas;
    this.mapData = null;
    this.breaks = [];
    this.durationMs = 0;
    this.currentTimeMs = 0;
    this.timelineDensity = [];
    this.visualTimelineDurationMs = 1;
    this.timelineDurationAnimation = null;
    this.timelineViewStartMs = 0;
    this.timelineViewDurationMs = null;
    this.timelineViewAnimation = null;
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
    this.standardSnakingSliders = false;
    this.standardSliderSnakeOut = false;
    this.standardSliderEndCircles = true;
    this.catchRenderObjects = null;
  }

  setBeatmap(mapData, breaks, durationMs) {
    this.mapData = mapData;
    this.breaks = Array.isArray(breaks) ? breaks : [];
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.visualTimelineDurationMs = this.durationMs;
    this.timelineDurationAnimation = null;
    this.resetTimelineZoom({ animate: false });
    this.timelineDensity = buildDensityBins(mapData?.objects || [], this.durationMs);
    this.comboColours = (Array.isArray(mapData?.comboColours) && mapData.comboColours.length > 0)
      ? mapData.comboColours
      : DEFAULT_COLOURS;

    // Objects are sorted by start time but may overlap, so the visible-window
    // search has to look back by the longest object in the map to avoid
    // skipping a long slider or spinner that started before the window.
    this.maxObjectDurationMs = 0;
    for (const object of (mapData?.objects || [])) {
      const duration = (Number(object?.endTime) || 0) - (Number(object?.time) || 0);
      if (duration > this.maxObjectDurationMs) {
        this.maxObjectDurationMs = duration;
      }
    }

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

  getVisualTimelineDuration(now = performance.now()) {
    if (!this.timelineDurationAnimation) {
      return this.visualTimelineDurationMs || this.durationMs || 1;
    }

    const progress = clamp(
      (now - this.timelineDurationAnimation.startTime) / this.timelineDurationAnimation.durationMs,
      0,
      1,
    );

    if (progress >= 1) {
      this.visualTimelineDurationMs = this.timelineDurationAnimation.to;
      this.timelineDurationAnimation = null;
      return this.visualTimelineDurationMs;
    }

    this.visualTimelineDurationMs = this.timelineDurationAnimation.from
      + ((this.timelineDurationAnimation.to - this.timelineDurationAnimation.from) * easeOutCubic(progress));
    return this.visualTimelineDurationMs;
  }

  isTimelineDurationAnimating() {
    return Boolean(this.timelineDurationAnimation);
  }

  isTimelineViewAnimating() {
    return Boolean(this.timelineViewAnimation);
  }

  isTimelineAnimating() {
    return this.isTimelineDurationAnimating() || this.isTimelineViewAnimating();
  }

  setDuration(durationMs, { animate = false } = {}) {
    const nextDurationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    const currentVisualDurationMs = this.getVisualTimelineDuration();
    const previousDurationMs = this.durationMs;
    this.durationMs = nextDurationMs;
    this.timelineDensity = buildDensityBins(this.mapData?.objects || [], this.durationMs);
    if (this.timelineViewDurationMs !== null && this.timelineViewDurationMs >= nextDurationMs) {
      this.resetTimelineZoom({ animate: false });
    } else if (this.timelineViewDurationMs !== null) {
      this.timelineViewStartMs = clamp(this.timelineViewStartMs, 0, Math.max(0, nextDurationMs - this.timelineViewDurationMs));
    }

    if (animate && nextDurationMs > currentVisualDurationMs) {
      this.visualTimelineDurationMs = currentVisualDurationMs;
      this.timelineDurationAnimation = {
        startTime: performance.now(),
        durationMs: 340,
        from: currentVisualDurationMs,
        to: nextDurationMs,
      };
      return true;
    }

    if (
      this.timelineDurationAnimation
      && nextDurationMs === previousDurationMs
      && this.timelineDurationAnimation.to === nextDurationMs
    ) {
      return true;
    }

    this.visualTimelineDurationMs = nextDurationMs;
    this.timelineDurationAnimation = null;
    return false;
  }

  setTime(ms) {
    this.currentTimeMs = clamp(ms, 0, this.durationMs || 1);
  }

  isTimelineZoomed() {
    const { durationMs } = this.getTimelineViewRange();
    return durationMs < this.durationMs - 0.5;
  }

  animateTimelineView(toStartMs, toDurationMs, animate = true) {
    const durationMs = this.durationMs || 1;
    const nextDurationMs = Math.min(durationMs, Math.max(1, toDurationMs));
    const nextStartMs = clamp(toStartMs, 0, Math.max(0, durationMs - nextDurationMs));
    const { startMs, durationMs: currentDurationMs } = this.getTimelineViewRange();

    if (!animate) {
      this.timelineViewStartMs = nextStartMs;
      this.timelineViewDurationMs = nextDurationMs >= durationMs ? null : nextDurationMs;
      this.timelineViewAnimation = null;
      return;
    }

    this.timelineViewAnimation = {
      startTime: performance.now(),
      durationMs: 180,
      fromStartMs: startMs,
      fromDurationMs: currentDurationMs,
      toStartMs: nextStartMs,
      toDurationMs: nextDurationMs,
    };
    this.timelineViewStartMs = nextStartMs;
    this.timelineViewDurationMs = nextDurationMs >= durationMs ? null : nextDurationMs;
  }

  resetTimelineZoom({ animate = true } = {}) {
    this.animateTimelineView(0, this.durationMs || 1, animate);
  }

  setTimelineZoom(centerTimeMs, windowMs = 4000, { animate = true, anchorRatio = 0.5 } = {}) {
    const durationMs = this.durationMs || 1;
    const zoomDurationMs = Math.min(durationMs, Math.max(1000, Number.isFinite(windowMs) ? windowMs : 4000));
    if (zoomDurationMs >= durationMs) {
      this.resetTimelineZoom({ animate });
      return;
    }

    const center = clamp(Number.isFinite(centerTimeMs) ? centerTimeMs : this.currentTimeMs, 0, durationMs);
    const ratio = clamp(Number.isFinite(anchorRatio) ? anchorRatio : 0.5, 0, 1);
    this.animateTimelineView(center - (zoomDurationMs * ratio), zoomDurationMs, animate);
    this.timelineDurationAnimation = null;
  }

  getTimelineViewRange() {
    const fullDurationMs = this.getVisualTimelineDuration();
    let startMs = this.timelineViewDurationMs !== null ? this.timelineViewStartMs : 0;
    let durationMs = this.timelineViewDurationMs !== null ? this.timelineViewDurationMs : fullDurationMs;

    if (this.timelineViewAnimation) {
      const progress = clamp(
        (performance.now() - this.timelineViewAnimation.startTime) / this.timelineViewAnimation.durationMs,
        0,
        1,
      );
      const eased = easeOutCubic(progress);
      startMs = this.timelineViewAnimation.fromStartMs
        + ((this.timelineViewAnimation.toStartMs - this.timelineViewAnimation.fromStartMs) * eased);
      durationMs = this.timelineViewAnimation.fromDurationMs
        + ((this.timelineViewAnimation.toDurationMs - this.timelineViewAnimation.fromDurationMs) * eased);

      if (progress >= 1) {
        this.timelineViewAnimation = null;
        startMs = this.timelineViewStartMs;
        durationMs = this.timelineViewDurationMs !== null ? this.timelineViewDurationMs : fullDurationMs;
      }
    }

    durationMs = Math.max(1, durationMs || fullDurationMs || this.durationMs || 1);
    startMs = clamp(startMs, 0, Math.max(0, (this.durationMs || durationMs) - durationMs));
    return {
      startMs,
      durationMs,
      endMs: startMs + durationMs,
    };
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

  getCurrentManiaBpm(currentTime) {
    const timingPoints = Array.isArray(this.mapData?.timingPoints) ? this.mapData.timingPoints : [];
    let activeBpm = Number.isFinite(this.mapData?.bpmMin) && this.mapData.bpmMin > 0
      ? this.mapData.bpmMin
      : 120;

    for (const timingPoint of timingPoints) {
      if (!timingPoint || timingPoint.time > currentTime) {
        break;
      }
      if (Number.isFinite(timingPoint.bpm) && timingPoint.bpm > 0) {
        activeBpm = timingPoint.bpm;
      }
    }

    return activeBpm;
  }

  getManiaTimingControlPoints() {
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

  getManiaTimingState(time) {
    const controlPoints = this.getManiaTimingControlPoints();
    const applyInheritedSv = !(this.mapData?.conversion?.sourceMode === 0
      && this.mapData?.conversion?.targetMode === 3);
    let beatLength = 60000 / 120;
    let svMultiplier = 1;
    let sectionStart = 0;

    for (const point of controlPoints) {
      if (!point || point.time > time) {
        break;
      }

      if (point.uninherited && point.beatLength > 0) {
        beatLength = point.beatLength;
        svMultiplier = 1;
        sectionStart = point.time;
      } else if (applyInheritedSv && !point.uninherited && point.svMultiplier > 0) {
        svMultiplier = point.svMultiplier;
      }
    }

    return {
      beatLength,
      bpm: 60000 / Math.max(1, beatLength),
      svMultiplier,
      sectionStart,
    };
  }

  getManiaPixelsPerMs(time, playfieldHeight) {
    const state = this.getManiaTimingState(time);
    const baseScrollTimeMs = calculateManiaScrollTimeMs(this.maniaScrollSpeed, 120, false);
    const basePixelsPerMs = playfieldHeight / Math.max(1, baseScrollTimeMs);
    const referenceBpm = this.maniaScaleScrollSpeedWithBpm ? 120 : this.getManiaReferenceBpm();
    const bpmScale = state.bpm / Math.max(1, referenceBpm);
    return basePixelsPerMs * bpmScale * state.svMultiplier;
  }

  getManiaScrollOffset(startTime, endTime, playfieldHeight) {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime === endTime) {
      return 0;
    }

    const direction = endTime >= startTime ? 1 : -1;
    const fromTime = direction > 0 ? startTime : endTime;
    const toTime = direction > 0 ? endTime : startTime;
    const controlPoints = this.getManiaTimingControlPoints();
    let distance = 0;
    let segmentStart = fromTime;

    for (const point of controlPoints) {
      if (!point || point.time <= fromTime) {
        continue;
      }
      if (point.time >= toTime) {
        break;
      }

      distance += this.getManiaPixelsPerMs(segmentStart, playfieldHeight) * (point.time - segmentStart);
      segmentStart = point.time;
    }

    distance += this.getManiaPixelsPerMs(segmentStart, playfieldHeight) * (toTime - segmentStart);
    return distance * direction;
  }

  getManiaTimingNoteColour(time) {
    const timing = this.getManiaTimingState(time);
    const beatLength = Math.max(1, timing.beatLength);
    const sectionStart = Number.isFinite(timing.sectionStart) ? timing.sectionStart : 0;
    const beatPosition = (time - sectionStart) / beatLength;
    const fraction = beatPosition - Math.floor(beatPosition);
    const normalized = ((fraction % 1) + 1) % 1;
    const snapColours = [
      { denominator: 1, colour: { r: 255, g: 238, b: 134 } },
      { denominator: 2, colour: { r: 105, g: 196, b: 255 } },
      { denominator: 3, colour: { r: 202, g: 146, b: 255 } },
      { denominator: 4, colour: { r: 255, g: 116, b: 162 } },
      { denominator: 6, colour: { r: 126, g: 232, b: 169 } },
      { denominator: 8, colour: { r: 255, g: 174, b: 103 } },
      { denominator: 12, colour: { r: 132, g: 255, b: 226 } },
      { denominator: 16, colour: { r: 235, g: 139, b: 255 } },
    ];

    for (const { denominator, colour } of snapColours) {
      const scaled = normalized * denominator;
      if (Math.abs(scaled - Math.round(scaled)) <= 0.035) {
        return colour;
      }
    }

    return { r: 255, g: 255, b: 255 };
  }

  getTaikoTimingControlPoints() {
    return Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
  }

  getTaikoTimingState(time) {
    const controlPoints = this.getTaikoTimingControlPoints();
    let beatLength = 60000 / 120;
    let svMultiplier = 1;
    let meter = 4;
    let sectionStart = 0;
    let omitFirstBarLine = false;

    for (const point of controlPoints) {
      if (!point || point.time > time) {
        break;
      }

      if (point.uninherited && point.beatLength > 0) {
        beatLength = point.beatLength;
        svMultiplier = 1;
        meter = Number.isFinite(point.meter) && point.meter > 0 ? point.meter : 4;
        sectionStart = point.time;
        omitFirstBarLine = Boolean(point.omitFirstBarLine);
      } else if (!point.uninherited && point.svMultiplier > 0) {
        svMultiplier = point.svMultiplier;
      }
    }

    return {
      beatLength,
      svMultiplier,
      meter,
      sectionStart,
      omitFirstBarLine,
    };
  }

  getTaikoPixelsPerMs(time, playfieldWidth) {
    const timing = this.getTaikoTimingState(time);
    const baseSliderVelocity = Number.isFinite(this.mapData?.sliderMultiplier) && this.mapData.sliderMultiplier > 0
      ? this.mapData.sliderMultiplier
      : 1.4;
    const scale = playfieldWidth / OSU_WIDTH;
    const pixelsPerBeat = 100 * baseSliderVelocity * timing.svMultiplier * scale;
    return pixelsPerBeat / Math.max(1, timing.beatLength);
  }

  getTaikoScrollOffset(startTime, endTime, playfieldWidth) {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime === endTime) {
      return 0;
    }

    const direction = endTime >= startTime ? 1 : -1;
    const fromTime = direction > 0 ? startTime : endTime;
    const toTime = direction > 0 ? endTime : startTime;
    const controlPoints = this.getTaikoTimingControlPoints();
    let distance = 0;
    let segmentStart = fromTime;

    for (const point of controlPoints) {
      if (!point || point.time <= fromTime) {
        continue;
      }
      if (point.time >= toTime) {
        break;
      }

      distance += this.getTaikoPixelsPerMs(segmentStart, playfieldWidth) * (point.time - segmentStart);
      segmentStart = point.time;
    }

    distance += this.getTaikoPixelsPerMs(segmentStart, playfieldWidth) * (toTime - segmentStart);
    return distance * direction;
  }

  getTaikoMeasureLines(visibleStart, visibleEnd) {
    const controlPoints = this.getTaikoTimingControlPoints().filter((point) => point?.uninherited && point.beatLength > 0);
    if (controlPoints.length === 0 || visibleEnd < visibleStart) {
      return [];
    }

    const lines = [];
    for (let i = 0; i < controlPoints.length; i += 1) {
      const point = controlPoints[i];
      const sectionStart = point.time;
      const sectionEnd = (i + 1 < controlPoints.length) ? controlPoints[i + 1].time : visibleEnd + (point.beatLength * point.meter);
      const sectionVisibleStart = Math.max(visibleStart, sectionStart);
      const sectionVisibleEnd = Math.min(visibleEnd, sectionEnd);
      if (sectionVisibleEnd < sectionVisibleStart) {
        continue;
      }

      const meter = Number.isFinite(point.meter) && point.meter > 0 ? point.meter : 4;
      const measureLength = point.beatLength * meter;
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

  getCatchTimingState(time) {
    const controlPoints = Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
    let beatLength = 60000 / 120;

    for (const point of controlPoints) {
      if (!point || point.time > time) {
        break;
      }
      if (point.uninherited && point.beatLength > 0) {
        beatLength = point.beatLength;
      }
    }

    return {
      beatLength,
      bpm: 60000 / Math.max(1, beatLength),
    };
  }

  getStandardTimingState(time) {
    return getTimingStateAt(this.mapData?.timingControlPoints, time);
  }

  buildStandardSliderTicks(object) {
    if (!object || object.kind !== 'slider') {
      return [];
    }

    const sliderTickRate = Number.isFinite(this.mapData?.sliderTickRate) && this.mapData.sliderTickRate > 0
      ? this.mapData.sliderTickRate
      : 1;
    const stackIndex = object.stackIndex || 0;
    const cachedTicks = standardSliderTickCache.get(object);
    if (
      cachedTicks
      && Array.isArray(cachedTicks.ticks)
      && cachedTicks.sliderTickRate === sliderTickRate
      && cachedTicks.stackIndex === stackIndex
    ) {
      return cachedTicks.ticks;
    }

    const totalDuration = Math.max(1, (object.endTime || object.time) - object.time);
    const slides = Math.max(1, object.slides || 1);
    const spanDuration = totalDuration / slides;
    const pathLength = Number.isFinite(object.length) && object.length > 0 ? object.length : 0;
    const ticks = [];
    const cacheTicks = () => {
      standardSliderTickCache.set(object, { sliderTickRate, stackIndex, ticks });
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
    const segmentLengths = [];
    let totalPathLength = 0;
    for (let i = 1; i < path.length; i += 1) {
      const segLen = pointDistance(path[i - 1], path[i]);
      segmentLengths.push(segLen);
      totalPathLength += segLen;
    }
    if (totalPathLength <= 0 || path.length < 2) {
      return cacheTicks();
    }

    const positionAtProgress = (progress) => {
      let target = clamp(progress, 0, 1) * totalPathLength;
      for (let i = 0; i < segmentLengths.length; i += 1) {
        const segLen = segmentLengths[i];
        if (target <= segLen || i === segmentLengths.length - 1) {
          const t = segLen <= 0 ? 0 : clamp(target / segLen, 0, 1);
          return {
            x: path[i].x + ((path[i + 1].x - path[i].x) * t),
            y: path[i].y + ((path[i + 1].y - path[i].y) * t),
          };
        }
        target -= segLen;
      }
      return path[path.length - 1];
    };

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
          position: positionAtProgress(pathProgress),
        });
      }
    }

    return cacheTicks();
  }

  buildCatchSliderRenderObjects(object) {
    const renderObjects = [];
    const totalDuration = Math.max(1, (object.endTime || object.time) - object.time);
    const slides = Math.max(1, object.slides || 1);
    const spanDuration = totalDuration / slides;
    const beatLength = this.getCatchTimingState(object.time).beatLength;
    const sliderTickRate = Number.isFinite(this.mapData?.sliderTickRate) && this.mapData.sliderTickRate > 0
      ? this.mapData.sliderTickRate
      : 1;
    const tickInterval = sliderTickRate > 0 ? (beatLength / sliderTickRate) : spanDuration;
    const tinyInterval = Math.max(45, Math.min(90, tickInterval / 4));

    const pushAtTime = (time, type) => {
      const position = getSliderBallPositionOsu(object, clamp(time, object.time, object.endTime));
      renderObjects.push({
        time,
        x: position.x,
        type,
        comboIndexWithOffsets: getComboColourIndex(object),
      });
    };

    pushAtTime(object.time, 'fruit');
    for (let spanIndex = 0; spanIndex < slides; spanIndex += 1) {
      const spanStart = object.time + (spanIndex * spanDuration);
      const spanEnd = Math.min(object.endTime, spanStart + spanDuration);
      const anchors = [spanStart];

      if (Number.isFinite(tickInterval) && tickInterval > 0) {
        for (let tickTime = spanStart + tickInterval; tickTime < (spanEnd - 0.001); tickTime += tickInterval) {
          anchors.push(tickTime);
          pushAtTime(tickTime, 'droplet');
        }
      }

      anchors.push(spanEnd);
      if (spanEnd > object.time && spanEnd <= object.endTime) {
        pushAtTime(spanEnd, 'fruit');
      }

      anchors.sort((a, b) => a - b);
      for (let i = 1; i < anchors.length; i += 1) {
        const segmentStart = anchors[i - 1];
        const segmentEnd = anchors[i];
        for (let tinyTime = segmentStart + tinyInterval; tinyTime < (segmentEnd - 0.001); tinyTime += tinyInterval) {
          const position = getSliderBallPositionOsu(object, tinyTime);
          renderObjects.push({
            time: tinyTime,
            x: position.x,
            type: 'tinyDroplet',
            comboIndexWithOffsets: getComboColourIndex(object),
          });
        }
      }
    }

    return renderObjects;
  }

  buildCatchSpinnerRenderObjects(object) {
    const renderObjects = [];
    const duration = Math.max(1, object.endTime - object.time);
    const beatLength = this.getCatchTimingState(object.time).beatLength;
    const bananaInterval = Math.max(20, Math.min(44, beatLength / 8));
    const count = Math.max(18, Math.floor(duration / bananaInterval));

    for (let i = 0; i <= count; i += 1) {
      const time = object.time + ((duration * i) / Math.max(1, count));
      const seed = (object.time * 0.0017) + (i * 0.61803398875);
      const x = deterministicUnitValue(seed) * OSU_WIDTH;
      renderObjects.push({
        time,
        x,
        type: 'banana',
        comboIndexWithOffsets: getComboColourIndex(object),
      });
    }

    return renderObjects;
  }

  getCatchRenderObjects() {
    if (Array.isArray(this.catchRenderObjects)) {
      return this.catchRenderObjects;
    }

    if (Array.isArray(this.mapData?.catchObjects)) {
      this.catchRenderObjects = this.mapData.catchObjects
        .map((object, index) => ({ ...object, renderId: Number.isInteger(object.renderId) ? object.renderId : index }))
        .sort((a, b) => a.time - b.time || a.renderId - b.renderId);
      return this.catchRenderObjects;
    }

    const built = [];
    const objects = Array.isArray(this.mapData?.objects) ? this.mapData.objects : [];
    for (const object of objects) {
      if (!object) {
        continue;
      }

      if (object.kind === 'spinner' || object.taikoType === 'swell') {
        built.push(...this.buildCatchSpinnerRenderObjects(object));
      } else if (object.kind === 'slider') {
        built.push(...this.buildCatchSliderRenderObjects(object));
      } else {
        built.push({
          time: object.time,
          x: object.x,
          type: 'fruit',
          comboIndexWithOffsets: getComboColourIndex(object),
        });
      }
    }

    built.sort((a, b) => a.time - b.time);
    for (let i = 0; i < built.length; i += 1) {
      built[i].renderId = i;
    }
    this.catchRenderObjects = built;
    return built;
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

  timeFromTimelineEvent(event) {
    const rect = this.timelineCanvas.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0;
    }

    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const { startMs, durationMs } = this.getTimelineViewRange();
    return startMs + (ratio * durationMs);
  }

  render() {
    this.renderPlayfield();
    this.renderTimeline();
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
    this.applyCatchHyperDashIndicators(catchObjects, catcherWidthOsu);
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
    const laneAreaWidth = playfieldWidth * 0.62;
    const laneAreaX = playfieldX + ((playfieldWidth - laneAreaWidth) / 2);
    const laneWidth = laneAreaWidth / keys;
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
    const { ctx, width, height } = getCanvasContext(this.playfieldCanvas);

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

    const padding = 14;
    const availableWidth = Math.max(10, width - (padding * 2));
    const availableHeight = Math.max(10, height - (padding * 2));
    let scale = Math.min(availableWidth / OSU_WIDTH, availableHeight / OSU_HEIGHT);
    let playfieldWidth = OSU_WIDTH * scale;
    let playfieldHeight = OSU_HEIGHT * scale;
    let playfieldX = Math.floor((width - playfieldWidth) / 2);
    let playfieldY = Math.floor((height - playfieldHeight) / 2);

    ctx.fillStyle = 'rgba(19, 21, 26, 0.95)';
    ctx.fillRect(playfieldX, playfieldY, playfieldWidth, playfieldHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(playfieldX + 0.5, playfieldY + 0.5, playfieldWidth - 1, playfieldHeight - 1);

    const mode = this.mapData.mode ?? 0;
    if (mode === 1) {
      this.renderTaiko(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight);
      return;
    }
    if (mode === 2) {
      this.renderCatch(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight);
      return;
    }
    if (mode === 3) {
      this.renderMania(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight);
      return;
    }

    const standardLayout = getStandardPlayfieldLayout(width, height, this.mapData.circleSize, 0);
    ({
      scale,
      playfieldX,
      playfieldY,
      playfieldWidth,
      playfieldHeight,
    } = standardLayout);

    ctx.fillStyle = 'rgba(8, 8, 10, 0.85)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(19, 21, 26, 0.95)';
    ctx.fillRect(
      standardLayout.visualX,
      standardLayout.visualY,
      standardLayout.visualWidth,
      standardLayout.visualHeight,
    );
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
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
    const drawnCircleRadius = circleRadius * DRAWN_CIRCLE_RADIUS_SCALE;
    const sliderBodyRadius = Math.max(2, drawnCircleRadius * 0.95);
    const minVisibleTime = this.currentTimeMs - Math.max(LONG_OBJECT_POST_HIT_FADE_MS, SLIDER_HEAD_HIT_FADE_MS);
    const maxVisibleTime = this.currentTimeMs + preemptMs + 220;

    drawFollowPoints({
      ctx,
      toCanvas,
      objects: this.mapData.objects,
      currentTime: this.currentTimeMs,
      preemptMs,
      minVisibleTime,
      maxVisibleTime,
      maxObjectDurationMs: this.maxObjectDurationMs,
      circleRadius: drawnCircleRadius,
      scale,
    });

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
      let sliderReverseIndicators = [];
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
        const fullPathPoints = buildSliderPathPointsOsu(object);
        let sliderDrawPointsOsu = fullPathPoints;
        const fullPathLength = getPathLength(fullPathPoints);
        if (this.standardSnakingSliders && timeUntil > 0) {
          const fadeInElapsedMs = preemptMs - timeUntil;
          const snakeProgress = clamp(fadeInElapsedMs / Math.max(1, timeFadeInMs), 0, 1);
          if (fullPathLength > 0) {
            sliderDrawPointsOsu = trimPathToLength(fullPathPoints, fullPathLength * snakeProgress);
          }
        } else if (this.standardSliderSnakeOut && this.currentTimeMs > object.time) {
          const sliderDuration = Math.max(1, object.endTime - object.time);
          const slides = Math.max(1, object.slides || 1);
          const spanDuration = sliderDuration / slides;
          const elapsed = clamp(this.currentTimeMs - object.time, 0, sliderDuration);
          const spanIndex = Math.min(slides - 1, Math.floor(elapsed / Math.max(1, spanDuration)));

          if (spanIndex === slides - 1 && fullPathLength > 0) {
            const spanProgress = clamp((elapsed - (spanIndex * spanDuration)) / Math.max(1, spanDuration), 0, 1);
            if ((spanIndex % 2) === 0) {
              sliderDrawPointsOsu = trimPathFromStart(fullPathPoints, fullPathLength * spanProgress);
            } else {
              sliderDrawPointsOsu = trimPathToLength(fullPathPoints, fullPathLength * (1 - spanProgress));
            }
          }
        }
        const pathPoints = sliderDrawPointsOsu.map((p) => toCanvas(p.x, p.y));
        if (pathPoints.length > 0) {
          sliderTailCanvasPoint = pathPoints[pathPoints.length - 1];
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
            let tickAlpha = objectRenderAlpha * 0.72;
            let tickRadius = baseTickRadius;

            if (tickElapsed > 0) {
              const tickFadeProgress = clamp(tickElapsed / SLIDER_HEAD_HIT_FADE_MS, 0, 1);
              const tickEaseOut = 1 - ((1 - tickFadeProgress) * (1 - tickFadeProgress));
              tickAlpha *= (1 - tickFadeProgress);
              // Scale expansion: grow by 80% as it fades out to make it punchier.
              tickRadius = baseTickRadius * (1 + (0.8 * tickEaseOut));
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
            const startPoint = pathPoints[0];
            const endPoint = pathPoints[pathPoints.length - 1];
            const startDir = {
              x: pathPoints[Math.min(1, pathPoints.length - 1)].x - startPoint.x,
              y: pathPoints[Math.min(1, pathPoints.length - 1)].y - startPoint.y,
            };
            const endDir = {
              x: pathPoints[Math.max(0, pathPoints.length - 2)].x - endPoint.x,
              y: pathPoints[Math.max(0, pathPoints.length - 2)].y - endPoint.y,
            };
            const indicatorSize = Math.max(5, drawnCircleRadius * 0.45);
            const slides = object.slides || 1;
            const totalDuration = Math.max(1, (object.endTime || object.time) - object.time);
            const spanDuration = totalDuration / slides;
            // Generate a reverse indicator for each span boundary.
            // Reverse at end of span i occurs at object.time + (i+1) * spanDuration.
            // Even span index → reverse at path end; odd → at path start.
            for (let spanIndex = 0; spanIndex < slides - 1; spanIndex += 1) {
              const reverseTime = object.time + ((spanIndex + 1) * spanDuration);
              const isAtEnd = (spanIndex % 2) === 0;
              const elapsed = this.currentTimeMs - reverseTime;
              const timeUntil = -elapsed;

              if (timeUntil > preemptMs) {
                // Not yet visible according to Approach Rate
                continue;
              }

              let reverseAlpha = 0;
              let reverseSize = indicatorSize;

              if (elapsed >= 0) {
                // Hit Animation: expand and fade out (lazer uses Math.min(300, spanDuration))
                const animDuration = Math.min(300, spanDuration);
                if (elapsed >= animDuration) {
                  continue; // Fully faded out
                }
                const hitProgress = clamp(elapsed / animDuration, 0, 1);
                const hitEaseOut = 1 - ((1 - hitProgress) * (1 - hitProgress));

                reverseAlpha = (OBJECT_VISUAL_MAX_ALPHA * 0.95) * (1 - hitEaseOut);
                reverseSize = indicatorSize * (1.0 + (0.5 * hitEaseOut)); // Expands 1.0 -> 1.5
              } else {
                // Fade in based on standard AR fade-in time
                const fadeInElapsedMs = preemptMs - timeUntil;
                const fadeInProgress = clamp(fadeInElapsedMs / Math.max(1, timeFadeInMs), 0, 1);
                reverseAlpha = (OBJECT_VISUAL_MAX_ALPHA * 0.95) * fadeInProgress;

                // Continuous Heartbeat Pulse Animation
                // 300ms loop: 0-35ms snaps out to 1.3x, 35-285ms smoothly shrinks back to 1.0x
                const loopCurrentTime = this.currentTimeMs % 300;
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

              sliderReverseIndicators.push({
                position: isAtEnd ? endPoint : startPoint,
                direction: isAtEnd ? endDir : startDir,
                size: reverseSize,
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
        ctx.fillStyle = withAlpha({ r: 0, g: 0, b: 0 }, objectRenderAlpha * STANDARD_OBJECT_SHADOW_ALPHA);
        ctx.beginPath();
        ctx.arc(
          sliderTailCanvasPoint.x,
          sliderTailCanvasPoint.y,
          drawnCircleRadius * STANDARD_OBJECT_SHADOW_SCALE,
          0,
          Math.PI * 2,
        );
        ctx.fill();

        ctx.fillStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectBodyBaseAlpha);
        ctx.beginPath();
        ctx.arc(sliderTailCanvasPoint.x, sliderTailCanvasPoint.y, drawnCircleRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = withAlpha(combo, objectBodyComboAlpha);
        ctx.beginPath();
        ctx.arc(sliderTailCanvasPoint.x, sliderTailCanvasPoint.y, drawnCircleRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectOutlineAlpha);
        ctx.lineWidth = objectOutlineWidth;
        ctx.beginPath();
        ctx.arc(sliderTailCanvasPoint.x, sliderTailCanvasPoint.y, objectOutlineRadius, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (const indicator of sliderReverseIndicators) {
        drawReverseIndicator(
          ctx,
          indicator.position,
          indicator.direction,
          indicator.size,
          indicator.alpha,
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
  }

  renderTimeline() {
    const { ctx, width, height } = getCanvasContext(this.timelineCanvas);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(36, 34, 42, 1)';
    ctx.fillRect(0, 0, width, height);

    const { startMs, durationMs: timelineDurationMs, endMs } = this.getTimelineViewRange();

    // Render Kiai Sections
    const timingPoints = this.mapData?.timingControlPoints || [];
    if (timingPoints.length > 0) {
      let kiaiStart = -1;
      for (let i = 0; i < timingPoints.length; i += 1) {
        const tp = timingPoints[i];
        if (tp.kiai && kiaiStart === -1) {
          kiaiStart = tp.time;
        } else if (!tp.kiai && kiaiStart !== -1) {
          const segmentStart = Math.max(kiaiStart, startMs);
          const segmentEnd = Math.min(tp.time, endMs);
          if (segmentEnd > segmentStart) {
            const startX = ((segmentStart - startMs) / timelineDurationMs) * width;
            const endX = ((segmentEnd - startMs) / timelineDurationMs) * width;
            ctx.fillStyle = 'rgba(255, 204, 34, 0.15)';
            ctx.fillRect(startX, 0, endX - startX, height);
          }
          kiaiStart = -1;
        }
      }
      if (kiaiStart !== -1) {
        const segmentStart = Math.max(kiaiStart, startMs);
        const segmentEnd = endMs;
        if (segmentEnd > segmentStart) {
          const startX = ((segmentStart - startMs) / timelineDurationMs) * width;
          const endX = width;
          ctx.fillStyle = 'rgba(255, 204, 34, 0.15)';
          ctx.fillRect(startX, 0, endX - startX, height);
        }
      }
    }

    const density = this.isTimelineZoomed() || this.isTimelineDurationAnimating()
      ? buildDensityBins(this.mapData?.objects || [], timelineDurationMs, 150, startMs)
      : (this.timelineDensity || []);
    if (density.length > 0) {
      const barWidth = width / density.length;
      const usableHeight = Math.max(4, height * 0.56);
      const baselineY = Math.round((height + usableHeight) / 2);
      const barWidthDrawn = Math.max(1, barWidth - 0.5);
      // One fill colour for every bar: setting it inside the loop cost a canvas
      // state change per bar, 150 of them on every frame.
      ctx.fillStyle = 'rgb(63, 155, 106)';
      for (let i = 0; i < density.length; i += 1) {
        const h = Math.max(1, density[i] * usableHeight);
        ctx.fillRect(i * barWidth, baselineY - h, barWidthDrawn, h);
      }
    }

    if (this.currentTimeMs >= startMs && this.currentTimeMs <= endMs) {
      const progress = (this.currentTimeMs - startMs) / (timelineDurationMs || 1);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.shadowBlur = 4;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect((progress * width) - 1, 0, 2, height);
      ctx.shadowBlur = 0;
    }
  }
}

export {
  DEFAULT_COLOURS,
  assignComboIndices,
  applyPreviewStacking,
  formatTime,
  clamp,
  getComboColour,
  getCircleRadius,
  getStandardPlayfieldLayout,
};
