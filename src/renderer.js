import {
  DEFAULT_MANIA_SCROLL_SPEED,
  DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM,
  calculateManiaScrollTimeMs,
} from './settings.js';

const OSU_WIDTH = 512;
const OSU_HEIGHT = 384;
const STACK_OFFSET_OSU = 5.2;
const DRAWN_CIRCLE_RADIUS_SCALE = 0.93;
const CIRCLE_POST_HIT_FADE_MS = 120;
const LONG_OBJECT_POST_HIT_FADE_MS = 140;
const FOLLOW_POINT_FADE_LEAD_MS = 120;
const FOLLOW_POINT_FADE_OUT_MS = 120;
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
const IS_FIREFOX = /firefox/i.test(globalThis.navigator?.userAgent || '');
const MAX_CANVAS_DPR = IS_FIREFOX ? 1 : 2;
const CANVAS_CONTEXT_OPTIONS = { alpha: false, desynchronized: true };
const canvasContextCache = new WeakMap();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getCircleRadius = (cs) => 54.4 - (4.48 * clamp(cs, 0, 10));

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

const DEFAULT_COLOURS = [
  { r: 255, g: 102, b: 171 },
  { r: 92, g: 197, b: 255 },
  { r: 132, g: 255, b: 128 },
  { r: 255, g: 218, b: 89 },
];

const pointsEqual = (a, b, epsilon = 0.001) => (
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon
);

const pointDistance = (a, b) => Math.hypot((b.x - a.x), (b.y - a.y));

const dedupeAdjacentPoints = (points, epsilon = 0.001) => {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (!pointsEqual(points[i], out[out.length - 1], epsilon)) {
      out.push(points[i]);
    }
  }
  return out;
};

const trimPathToLength = (points, targetLength) => {
  const cleanPoints = dedupeAdjacentPoints(points);
  if (cleanPoints.length < 2 || !Number.isFinite(targetLength) || targetLength <= 0) {
    return cleanPoints;
  }

  let remaining = targetLength;
  const trimmed = [cleanPoints[0]];
  for (let i = 1; i < cleanPoints.length; i += 1) {
    const start = cleanPoints[i - 1];
    const end = cleanPoints[i];
    const segmentLength = pointDistance(start, end);
    if (segmentLength <= 0) {
      continue;
    }

    if (remaining >= segmentLength) {
      trimmed.push(end);
      remaining -= segmentLength;
      continue;
    }

    const t = clamp(remaining / segmentLength, 0, 1);
    trimmed.push({
      x: start.x + ((end.x - start.x) * t),
      y: start.y + ((end.y - start.y) * t),
    });
    return dedupeAdjacentPoints(trimmed);
  }

  return dedupeAdjacentPoints(trimmed);
};

const getPathLength = (points) => {
  const cleanPoints = dedupeAdjacentPoints(points);
  if (cleanPoints.length < 2) {
    return 0;
  }

  let totalLength = 0;
  for (let i = 1; i < cleanPoints.length; i += 1) {
    totalLength += pointDistance(cleanPoints[i - 1], cleanPoints[i]);
  }
  return totalLength;
};

const evaluateBezierPoint = (controlPoints, t) => {
  const temp = controlPoints.map((point) => ({ x: point.x, y: point.y }));
  for (let order = temp.length - 1; order > 0; order -= 1) {
    for (let i = 0; i < order; i += 1) {
      temp[i].x += (temp[i + 1].x - temp[i].x) * t;
      temp[i].y += (temp[i + 1].y - temp[i].y) * t;
    }
  }
  return temp[0];
};

const sampleBezierSegment = (controlPoints) => {
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
    return [];
  }

  let estimate = 0;
  for (let i = 1; i < controlPoints.length; i += 1) {
    estimate += pointDistance(controlPoints[i - 1], controlPoints[i]);
  }

  const steps = Math.max(8, Math.min(96, Math.ceil(estimate / 6)));
  const sampled = [];
  for (let i = 0; i <= steps; i += 1) {
    sampled.push(evaluateBezierPoint(controlPoints, i / steps));
  }
  return sampled;
};

const sampleBezierPath = (pathPoints) => {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) {
    return pathPoints || [];
  }

  const segments = [];
  let current = [pathPoints[0]];

  for (let i = 1; i < pathPoints.length; i += 1) {
    const point = pathPoints[i];
    current.push(point);

    if (i < pathPoints.length - 1 && pointsEqual(point, pathPoints[i + 1])) {
      if (current.length >= 2) {
        segments.push(current);
      }
      current = [point];
      i += 1;
    }
  }

  if (current.length >= 2) {
    segments.push(current);
  }

  if (!segments.length) {
    return dedupeAdjacentPoints(pathPoints);
  }

  const sampled = [];
  for (const segment of segments) {
    const partial = sampleBezierSegment(segment);
    if (!partial.length) {
      continue;
    }
    if (sampled.length && pointsEqual(sampled[sampled.length - 1], partial[0])) {
      sampled.push(...partial.slice(1));
    } else {
      sampled.push(...partial);
    }
  }

  return dedupeAdjacentPoints(sampled);
};

const sampleCatmullPath = (pathPoints) => {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) {
    return pathPoints || [];
  }

  const sampled = [];
  const catmull = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + ((-p0.x + p2.x) * t) + ((2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2) + ((-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)),
      y: 0.5 * ((2 * p1.y) + ((-p0.y + p2.y) * t) + ((2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2) + ((-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)),
    };
  };

  for (let i = 0; i < pathPoints.length - 1; i += 1) {
    const p0 = i === 0 ? pathPoints[i] : pathPoints[i - 1];
    const p1 = pathPoints[i];
    const p2 = pathPoints[i + 1];
    const p3 = (i + 2 < pathPoints.length) ? pathPoints[i + 2] : pathPoints[i + 1];
    const steps = Math.max(6, Math.min(48, Math.ceil(pointDistance(p1, p2) / 8)));

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const point = catmull(p0, p1, p2, p3, t);
      if (!sampled.length || !pointsEqual(sampled[sampled.length - 1], point)) {
        sampled.push(point);
      }
    }
  }

  return dedupeAdjacentPoints(sampled);
};

const samplePerfectCirclePath = (pathPoints) => {
  if (!Array.isArray(pathPoints) || pathPoints.length < 3) {
    return null;
  }

  const p0 = pathPoints[0];
  const p1 = pathPoints[1];
  const p2 = pathPoints[2];

  const d = 2 * ((p0.x * (p1.y - p2.y)) + (p1.x * (p2.y - p0.y)) + (p2.x * (p0.y - p1.y)));
  if (Math.abs(d) < 0.0001) {
    return null;
  }

  const ux = (
    (((p0.x * p0.x) + (p0.y * p0.y)) * (p1.y - p2.y)) +
    (((p1.x * p1.x) + (p1.y * p1.y)) * (p2.y - p0.y)) +
    (((p2.x * p2.x) + (p2.y * p2.y)) * (p0.y - p1.y))
  ) / d;

  const uy = (
    (((p0.x * p0.x) + (p0.y * p0.y)) * (p2.x - p1.x)) +
    (((p1.x * p1.x) + (p1.y * p1.y)) * (p0.x - p2.x)) +
    (((p2.x * p2.x) + (p2.y * p2.y)) * (p1.x - p0.x))
  ) / d;

  const radius = pointDistance({ x: ux, y: uy }, p0);
  if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }

  const angle0 = Math.atan2(p0.y - uy, p0.x - ux);
  const angle1 = Math.atan2(p1.y - uy, p1.x - ux);
  const angle2 = Math.atan2(p2.y - uy, p2.x - ux);

  const angleDistance = (start, end, direction) => {
    if (direction > 0) {
      let delta = end - start;
      while (delta < 0) delta += Math.PI * 2;
      return delta;
    }
    let delta = start - end;
    while (delta < 0) delta += Math.PI * 2;
    return delta;
  };

  let direction = 1;
  const ccwStartMid = angleDistance(angle0, angle1, 1);
  const ccwStartEnd = angleDistance(angle0, angle2, 1);
  if (ccwStartMid > ccwStartEnd + 0.0001) {
    direction = -1;
  }

  const arcAngle = angleDistance(angle0, angle2, direction);
  const arcLength = arcAngle * radius;
  const steps = Math.max(10, Math.min(128, Math.ceil(arcLength / 6)));

  const sampled = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = angle0 + (direction * arcAngle * t);
    sampled.push({
      x: ux + (Math.cos(angle) * radius),
      y: uy + (Math.sin(angle) * radius),
    });
  }
  return dedupeAdjacentPoints(sampled);
};

const buildSliderPathPointsOsu = (object) => {
  if (!object || object.kind !== 'slider') {
    return [];
  }

  if (
    Array.isArray(object._cachedSliderPathPoints)
    && object._cachedSliderPathPoints.length >= 2
    && object._cachedSliderPathStackIndex === (object.stackIndex || 0)
  ) {
    return object._cachedSliderPathPoints;
  }

  const stackOffset = getObjectStackOffset(object);
  const rawPoints = [
    { x: object.x + stackOffset.x, y: object.y + stackOffset.y },
    ...(Array.isArray(object.sliderPoints) ? object.sliderPoints : []).map((point) => ({
      x: point.x + stackOffset.x,
      y: point.y + stackOffset.y,
    })),
  ];

  const curveType = String(object.sliderCurveType || 'B').toUpperCase();
  const basePoints = curveType === 'B'
    ? rawPoints
    : dedupeAdjacentPoints(rawPoints);

  if (basePoints.length < 2) {
    object._cachedSliderPathPoints = basePoints;
    return basePoints;
  }

  let sampled;
  if (curveType === 'L') {
    sampled = basePoints;
  } else if (curveType === 'C') {
    sampled = sampleCatmullPath(basePoints);
  } else if (curveType === 'P') {
    sampled = samplePerfectCirclePath(basePoints) || sampleBezierPath(basePoints);
  } else {
    sampled = sampleBezierPath(basePoints);
  }
  const trimmed = trimPathToLength(sampled, object.length);
  object._cachedSliderPathPoints = (trimmed.length >= 2) ? trimmed : sampled;
  object._cachedSliderPathStackIndex = object.stackIndex || 0;
  return object._cachedSliderPathPoints;
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

  const stackIndex = Math.max(0, Number(object.stackIndex) || 0);
  if (stackIndex <= 0) {
    return { x: 0, y: 0 };
  }

  const offset = stackIndex * STACK_OFFSET_OSU;
  return { x: -offset, y: -offset };
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
  ctx.lineWidth = Math.max(1.4, size * 0.16);
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

const assignComboIndices = (objects, comboColours = DEFAULT_COLOURS) => {
  const colours = (comboColours && comboColours.length) ? comboColours : DEFAULT_COLOURS;
  const colourCount = Math.max(1, colours.length);
  let comboIndex = 0;
  let comboNumber = 1;

  for (let i = 0; i < objects.length; i += 1) {
    if (i > 0 && objects[i].newCombo) {
      comboIndex = (comboIndex + 1 + (objects[i].comboSkip || 0)) % colourCount;
      comboNumber = 1;
    } else if (i > 0) {
      comboNumber += 1;
    }
    objects[i].comboIndex = comboIndex;
    objects[i].comboNumber = comboNumber;
  }
};

const applyPreviewStacking = (objects, approachRate, stackLeniency) => {
  if (!Array.isArray(objects) || objects.length === 0) {
    return;
  }

  const leniency = clamp(Number.isFinite(stackLeniency) ? stackLeniency : 0.7, 0, 2);
  const stackTimeThreshold = getApproachPreemptMs(approachRate) * leniency;
  const stackDistanceThreshold = 3;

  for (const object of objects) {
    object.stackIndex = 0;
    delete object._cachedSliderPathPoints;
    delete object._cachedSliderPathStackIndex;
  }

  for (let i = 1; i < objects.length; i += 1) {
    const object = objects[i];
    if (!object || object.kind === 'spinner') {
      continue;
    }

    let bestStack = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const previous = objects[j];
      if (!previous || previous.kind === 'spinner') {
        continue;
      }

      const dt = object.time - previous.time;
      if (dt > stackTimeThreshold) {
        break;
      }

      const dx = object.x - previous.x;
      const dy = object.y - previous.y;
      if (Math.hypot(dx, dy) <= stackDistanceThreshold) {
        bestStack = Math.max(bestStack, (previous.stackIndex || 0) + 1);
      }
    }

    object.stackIndex = bestStack;
  }
};

const buildDensityBins = (objects, durationMs, bins = 150) => {
  if (!Array.isArray(objects) || objects.length === 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return new Array(bins).fill(0);
  }

  const counts = new Array(bins).fill(0);
  for (const object of objects) {
    const ratio = clamp(object.time / durationMs, 0, 1);
    const index = Math.min(bins - 1, Math.floor(ratio * bins));
    counts[index] += 1;
  }

  const max = Math.max(...counts, 1);
  return counts.map((count) => count / max);
};

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
  circleRadius,
}) => {
  if (!Array.isArray(objects) || objects.length < 2) {
    return;
  }

  for (let i = 0; i < objects.length - 1; i += 1) {
    const current = objects[i];
    const next = objects[i + 1];
    if (!current || !next) continue;
    if ((current.comboIndex ?? 0) !== (next.comboIndex ?? 0)) continue;
    if (current.kind === 'spinner' || next.kind === 'spinner') continue;
    if (next.time > maxVisibleTime || next.endTime < minVisibleTime) continue;

    const fadeInStart = next.time - preemptMs;
    const fadeInPeak = next.time - (preemptMs * 0.35);
    const fadeOutStart = next.time - FOLLOW_POINT_FADE_LEAD_MS;
    const fadeOutEnd = fadeOutStart + FOLLOW_POINT_FADE_OUT_MS;
    if (currentTime < fadeInStart || currentTime > fadeOutEnd) continue;

    let alpha = 1;
    let fadeOutProgress = 0;
    let fadeOutTrimProgress = 0;
    if (currentTime < fadeInPeak) {
      alpha = clamp((currentTime - fadeInStart) / Math.max(1, fadeInPeak - fadeInStart), 0, 1);
    } else if (currentTime >= fadeOutStart) {
      fadeOutProgress = clamp((currentTime - fadeOutStart) / FOLLOW_POINT_FADE_OUT_MS, 0, 1);
      fadeOutTrimProgress = 1 - Math.pow(1 - fadeOutProgress, 2.2);
      alpha = 1 - fadeOutTrimProgress;
    }
    if (alpha <= 0.003) continue;

    const start = getObjectEndPositionOsu(current);
    const end = getObjectStartPositionOsu(next);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    const minGapDistance = (circleRadius * 2) + 2;
    if (!Number.isFinite(distance) || distance <= minGapDistance) continue;

    const trim = (circleRadius * 1.02) + 1;
    const startCanvas = toCanvas(start.x, start.y);
    const endCanvas = toCanvas(end.x, end.y);
    const nx = dx / distance;
    const ny = dy / distance;
    const fromX = startCanvas.x + (nx * trim);
    const fromY = startCanvas.y + (ny * trim);
    const toX = endCanvas.x - (nx * trim);
    const toY = endCanvas.y - (ny * trim);

    let drawFromX = fromX;
    let drawFromY = fromY;
    let drawToX = toX;
    let drawToY = toY;

    if (fadeOutTrimProgress > 0) {
      const lineDx = toX - fromX;
      const lineDy = toY - fromY;
      const lineLength = Math.hypot(lineDx, lineDy);
      if (lineLength <= 0.001) {
        continue;
      }

      const ux = lineDx / lineLength;
      const uy = lineDy / lineLength;
      const totalTrim = lineLength * (0.98 * fadeOutTrimProgress);
      const startTrim = totalTrim * 0.68;
      const endTrim = totalTrim - startTrim;
      drawFromX = fromX + (ux * startTrim);
      drawFromY = fromY + (uy * startTrim);
      drawToX = toX - (ux * endTrim);
      drawToY = toY - (uy * endTrim);

      if (Math.hypot(drawToX - drawFromX, drawToY - drawFromY) <= 0.4) {
        continue;
      }
    }

    ctx.strokeStyle = `rgba(255, 255, 255, ${clamp(alpha * 0.2, 0, 1)})`;
    const baseLineWidth = Math.max(0.9, circleRadius * 0.08);
    const widthScale = 1 - (fadeOutTrimProgress * 0.65);
    ctx.lineWidth = Math.max(0.35, baseLineWidth * widthScale);
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
    this.comboColours = DEFAULT_COLOURS;
    this.catcherRenderX = Number.NaN;
    this.catcherRenderTime = Number.NaN;
    this.catchCatcherTrailSamples = [];
    this.catchHyperDashHitEffects = [];
    this.catchTriggeredHitEffects = new Set();
    this.catchLastEffectTime = Number.NaN;
    this.maniaScrollSpeed = DEFAULT_MANIA_SCROLL_SPEED;
    this.maniaScaleScrollSpeedWithBpm = DEFAULT_MANIA_SCROLL_SCALE_WITH_BPM;
    this.standardSnakingSliders = false;
    this.standardSliderEndCircles = true;
    this.catchRenderObjects = null;
  }

  setBeatmap(mapData, breaks, durationMs) {
    this.mapData = mapData;
    this.breaks = Array.isArray(breaks) ? breaks : [];
    this.durationMs = Number.isFinite(durationMs) ? Math.max(durationMs, 1) : 1;
    this.timelineDensity = buildDensityBins(mapData?.objects || [], this.durationMs);
    this.comboColours = (Array.isArray(mapData?.comboColours) && mapData.comboColours.length > 0)
      ? mapData.comboColours
      : DEFAULT_COLOURS;

    if (Array.isArray(this.mapData?.objects)) {
      assignComboIndices(this.mapData.objects, this.comboColours);
      this.catchRenderObjects = null;
      if ((this.mapData.mode ?? 0) === 0) {
        applyPreviewStacking(this.mapData.objects, this.mapData.approachRate, this.mapData.stackLeniency);
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

  setTime(ms) {
    this.currentTimeMs = clamp(ms, 0, this.durationMs || 1);
  }

  setPreviewSettings(settings = {}) {
    if (Object.hasOwn(settings, 'maniaScrollSpeed')) {
      this.maniaScrollSpeed = settings.maniaScrollSpeed;
    }
    if (Object.hasOwn(settings, 'maniaScaleScrollSpeedWithBpm')) {
      this.maniaScaleScrollSpeedWithBpm = Boolean(settings.maniaScaleScrollSpeedWithBpm);
    }
    if (Object.hasOwn(settings, 'standardSnakingSliders')) {
      this.standardSnakingSliders = Boolean(settings.standardSnakingSliders);
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
    let beatLength = 60000 / 120;
    let svMultiplier = 1;

    for (const point of controlPoints) {
      if (!point || point.time > time) {
        break;
      }

      if (point.uninherited && point.beatLength > 0) {
        beatLength = point.beatLength;
        svMultiplier = 1;
      } else if (!point.uninherited && point.svMultiplier > 0) {
        svMultiplier = point.svMultiplier;
      }
    }

    return {
      beatLength,
      bpm: 60000 / Math.max(1, beatLength),
      svMultiplier,
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
    const controlPoints = Array.isArray(this.mapData?.timingControlPoints) ? this.mapData.timingControlPoints : [];
    let beatLength = 60000 / 120;
    let svMultiplier = 1;

    for (const point of controlPoints) {
      if (!point || point.time > time) {
        break;
      }
      if (point.uninherited && point.beatLength > 0) {
        beatLength = point.beatLength;
      } else if (!point.uninherited && point.svMultiplier > 0) {
        svMultiplier = point.svMultiplier;
      }
    }

    return {
      beatLength,
      svMultiplier,
      bpm: 60000 / Math.max(1, beatLength),
    };
  }

  buildStandardSliderTicks(object) {
    if (!object || object.kind !== 'slider') {
      return [];
    }

    const sliderTickRate = Number.isFinite(this.mapData?.sliderTickRate) && this.mapData.sliderTickRate > 0
      ? this.mapData.sliderTickRate
      : 1;
    const stackIndex = object.stackIndex || 0;
    if (
      Array.isArray(object._cachedStandardSliderTicks)
      && object._cachedStandardSliderTickRate === sliderTickRate
      && object._cachedStandardSliderStackIndex === stackIndex
    ) {
      return object._cachedStandardSliderTicks;
    }

    const totalDuration = Math.max(1, (object.endTime || object.time) - object.time);
    const slides = Math.max(1, object.slides || 1);
    const spanDuration = totalDuration / slides;
    const beatLength = this.getStandardTimingState(object.time).beatLength;
    const tickInterval = sliderTickRate > 0 ? (beatLength / sliderTickRate) : spanDuration;
    const ticks = [];

    if (!(Number.isFinite(tickInterval) && tickInterval > 0)) {
      object._cachedStandardSliderTicks = ticks;
      object._cachedStandardSliderTickRate = sliderTickRate;
      object._cachedStandardSliderStackIndex = stackIndex;
      return ticks;
    }

    for (let spanIndex = 0; spanIndex < slides; spanIndex += 1) {
      const spanStart = object.time + (spanIndex * spanDuration);
      const spanEnd = Math.min(object.endTime, spanStart + spanDuration);
      for (let tickTime = spanStart + tickInterval; tickTime < (spanEnd - 0.001); tickTime += tickInterval) {
        ticks.push({
          time: tickTime,
          position: getSliderBallPositionOsu(object, tickTime),
        });
      }
    }

    object._cachedStandardSliderTicks = ticks;
    object._cachedStandardSliderTickRate = sliderTickRate;
    object._cachedStandardSliderStackIndex = stackIndex;
    return ticks;
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
        comboIndex: object.comboIndex || 0,
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
            comboIndex: object.comboIndex || 0,
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
        comboIndex: object.comboIndex || 0,
      });
    }

    return renderObjects;
  }

  getCatchRenderObjects() {
    if (Array.isArray(this.catchRenderObjects)) {
      return this.catchRenderObjects;
    }

    const built = [];
    const objects = Array.isArray(this.mapData?.objects) ? this.mapData.objects : [];
    for (const object of objects) {
      if (!object) {
        continue;
      }

      if (object.kind === 'spinner') {
        built.push(...this.buildCatchSpinnerRenderObjects(object));
      } else if (object.kind === 'slider') {
        built.push(...this.buildCatchSliderRenderObjects(object));
      } else {
        built.push({
          time: object.time,
          x: object.x,
          type: 'fruit',
          comboIndex: object.comboIndex || 0,
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
    return ratio * this.durationMs;
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

    for (const object of objects) {
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

      if (object.kind === 'slider' || object.kind === 'hold') {
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
      const isKat = (hitSound & (2 | 8)) !== 0;
      const isFinish = (hitSound & 4) !== 0;
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
    for (const object of catchObjects) {
      if (!object || object.type === 'banana') {
        continue;
      }

      const dt = object.time - currentTime;
      if (dt > lookAheadMs || dt < -postCatchFadeMs) {
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

    for (const object of catchObjects) {
      if (!object || object.type === 'banana') {
        continue;
      }
      if (!(object.hyperDash || object.hyperDashFollowUp) || this.catchTriggeredHitEffects.has(object.renderId)) {
        continue;
      }

      const hitElapsed = currentTime - object.time;
      if (hitElapsed < 0 || hitElapsed > postCatchFadeMs) {
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

    for (const object of catchObjects) {
      if (object.time > visibleEnd) {
        break;
      }
      if (object.time < visibleStart) {
        continue;
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

      let color = comboColours[object.comboIndex % comboColours.length] || DEFAULT_COLOURS[0];
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
    const keys = clamp(Math.round(circleSize || 4), 1, 10);
    const laneAreaWidth = playfieldWidth * 0.62;
    const laneAreaX = playfieldX + ((playfieldWidth - laneAreaWidth) / 2);
    const laneWidth = laneAreaWidth / keys;
    const receptorY = playfieldY + (playfieldHeight * 0.88);
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
    const topFadeHeight = Math.max(16, playfieldHeight * 0.11);
    const topFadeEndY = playfieldY + topFadeHeight;
    const postJudgeTravelPx = Math.max(receptorHalf, noteHeight * 0.25);
    const postJudgeDelayMs = postJudgeTravelPx / currentPixelsPerMs;
    const holdBodyBottomClampY = receptorY + receptorHalf;
    const receptorVanishCenterY = receptorY + (receptorHalf * 0.5);
    const receptorVanishFadePx = Math.max(1, receptorHalf);

    for (const object of objects) {
      if (object.time > visibleEnd) {
        break;
      }
      if (object.endTime < visibleStart) {
        continue;
      }
      if (object.kind === 'spinner') {
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
        Math.floor((clamp(object.x, 0, OSU_WIDTH - 0.001) / OSU_WIDTH) * keys),
        0,
        keys - 1,
      );
      const laneX = laneAreaX + (lane * laneWidth);
      const noteX = laneX + lanePadding;
      const rawHeadY = receptorY - this.getManiaScrollOffset(currentTime, object.time, scrollTravelHeight) - (noteHeight / 2);
      const headY = (isHoldNote && currentTime >= object.time && currentTime <= holdEndClampTime)
        ? (receptorY - (noteHeight / 2))
        : rawHeadY;
      const shouldRenderHoldBody = isHoldNote && currentTime <= holdEndClampTime;

      const noteCenterY = headY + (noteHeight / 2);
      if (!isHoldNote && dt > 0) {
        const futureDistance = clamp(receptorY - noteCenterY, 0, playfieldHeight);
        alpha = 0.24 + (0.66 * clamp(1 - (futureDistance / Math.max(playfieldHeight, 1)), 0, 1));
      }
      if (noteCenterY < topFadeEndY) {
        alpha *= clamp((noteCenterY - playfieldY) / Math.max(topFadeHeight, 1), 0, 1);
        if (alpha <= 0.02) {
          continue;
        }
      }

      if (!isHoldNote) {
        if (noteCenterY > receptorVanishCenterY) {
          const overPx = noteCenterY - receptorVanishCenterY;
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

      if (shouldRenderHoldBody) {
        const tailY = receptorY - this.getManiaScrollOffset(currentTime, object.endTime, scrollTravelHeight) + (noteHeight / 2);
        const bodyTop = Math.max(playfieldY - 20, Math.min(headY, tailY));
        const bodyBottom = Math.min(
          holdBodyBottomClampY,
          Math.max(headY + noteHeight, tailY),
        );
        const bodyHeight = bodyBottom - bodyTop;
        if (bodyHeight > 2) {
          const bodyAlpha = alpha * 0.35;
          if (bodyTop < topFadeEndY) {
            const fadeStop = clamp((topFadeEndY - bodyTop) / Math.max(bodyHeight, 1), 0, 1);
            const startAlpha = bodyTop <= playfieldY
              ? 0
              : bodyAlpha * clamp((bodyTop - playfieldY) / Math.max(topFadeHeight, 1), 0, 1);
            const bodyGradient = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
            bodyGradient.addColorStop(0, withAlpha(groupBase, startAlpha));
            bodyGradient.addColorStop(fadeStop, withAlpha(groupBase, bodyAlpha));
            bodyGradient.addColorStop(1, withAlpha(groupBase, bodyAlpha));
            ctx.fillStyle = bodyGradient;
          } else {
            ctx.fillStyle = withAlpha(groupBase, bodyAlpha);
          }
          ctx.fillRect(noteX + (noteWidth * 0.2), bodyTop, noteWidth * 0.6, bodyHeight);
        }
      }

      if (headY > playfieldY + playfieldHeight + 20 || (headY + noteHeight) < playfieldY - 20) {
        continue;
      }

      ctx.fillStyle = withAlpha(noteColor, alpha);
      ctx.fillRect(noteX, headY, noteWidth, noteHeight);
      ctx.strokeStyle = `rgba(255,255,255,${clamp(alpha * 0.8, 0, 1)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(noteX + 0.5, headY + 0.5, noteWidth - 1, noteHeight - 1);
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
      circleRadius: drawnCircleRadius,
    });

    const visibleObjects = [];
    for (const object of this.mapData.objects) {
      if (object.time > maxVisibleTime) break;
      if (object.endTime < minVisibleTime) continue;
      visibleObjects.push(object);
    }

    visibleObjects.sort((a, b) => b.time - a.time);

    for (const object of visibleObjects) {
      const combo = this.comboColours[object.comboIndex % this.comboColours.length] || DEFAULT_COLOURS[0];
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
        if (this.standardSnakingSliders && timeUntil > 0) {
          const fadeInElapsedMs = preemptMs - timeUntil;
          const snakeProgress = clamp(fadeInElapsedMs / Math.max(1, timeFadeInMs), 0, 1);
          const fullPathLength = getPathLength(fullPathPoints);
          if (fullPathLength > 0) {
            sliderDrawPointsOsu = trimPathToLength(fullPathPoints, fullPathLength * snakeProgress);
          }
        }
        const pathPoints = sliderDrawPointsOsu.map((p) => toCanvas(p.x, p.y));
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
          const tickRadius = Math.max(1.6, drawnCircleRadius * 0.14);
          for (const tick of sliderTicks) {
            if (!tick?.position) {
              continue;
            }

            const tickElapsed = this.currentTimeMs - tick.time;
            let tickAlpha = objectRenderAlpha * 0.72;
            if (tickElapsed > 0) {
              tickAlpha *= clamp(1 - (tickElapsed / SLIDER_HEAD_HIT_FADE_MS), 0, 1);
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

            sliderReverseIndicators.push({
              position: endPoint,
              direction: endDir,
              size: indicatorSize,
              alpha: baseAlpha * 0.95,
            });
            if ((object.slides || 1) >= 3) {
              sliderReverseIndicators.push({
                position: startPoint,
                direction: startDir,
                size: indicatorSize,
                alpha: baseAlpha * 0.95,
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

      for (const indicator of sliderReverseIndicators) {
        drawReverseIndicator(
          ctx,
          indicator.position,
          indicator.direction,
          indicator.size,
          indicator.alpha,
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
    }
  }

  renderTimeline() {
    const { ctx, width, height } = getCanvasContext(this.timelineCanvas);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(36, 34, 42, 1)';
    ctx.fillRect(0, 0, width, height);

    const density = this.timelineDensity || [];
    if (density.length > 0) {
      const barWidth = width / density.length;
      for (let i = 0; i < density.length; i += 1) {
        const v = density[i];
        const h = Math.max(1, v * (height - 1));
        ctx.fillStyle = 'rgb(63, 155, 106)';
        ctx.fillRect(i * barWidth, height - h, Math.max(1, barWidth - 0.5), h);
      }
    }

    const progress = clamp((this.currentTimeMs / (this.durationMs || 1)), 0, 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect((progress * width) - 1, 0, 2, height);
    ctx.shadowBlur = 0;
  }
}

export { formatTime, clamp };
