const OSU_WIDTH = 512;
const OSU_HEIGHT = 384;
const STACK_OFFSET_OSU = 5.2;
const DRAWN_CIRCLE_RADIUS_SCALE = 0.93;
const CIRCLE_POST_HIT_FADE_MS = 42;
const LONG_OBJECT_POST_HIT_FADE_MS = 88;
const FOLLOW_POINT_FADE_LEAD_MS = 120;
const FOLLOW_POINT_FADE_OUT_MS = 120;
const SLIDER_HEAD_HIT_FADE_MS = 120;
const SLIDER_HEAD_HIT_SCALE_BOOST = 0.2;
const COMBO_NUMBER_FONT_SCALE = 0.84;
const OBJECT_VISUAL_MAX_ALPHA = 0.9;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const getCircleRadius = (cs) => 54.4 - (4.48 * clamp(cs, 0, 10));

const getApproachPreemptMs = (ar) => {
  const value = clamp(Number.isFinite(ar) ? ar : 5, 0, 11);
  if (value < 5) {
    return 1800 - (120 * value);
  }
  return 1200 - (150 * (value - 5));
};

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
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  const ctx = canvas.getContext('2d');
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
      if ((this.mapData.mode ?? 0) === 0) {
        applyPreviewStacking(this.mapData.objects, this.mapData.approachRate, this.mapData.stackLeniency);
      } else {
        this.catcherRenderX = Number.NaN;
        this.catcherRenderTime = Number.NaN;
      }
    }
  }

  setTime(ms) {
    this.currentTimeMs = clamp(ms, 0, this.durationMs || 1);
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
    const noteTravelWidth = playfieldWidth * 0.82;
    const lookAheadMs = 1200;
    const lookBehindMs = 180;
    const visibleEnd = currentTime + lookAheadMs + 80;
    const visibleStart = currentTime - lookBehindMs;
    const donColor = { r: 242, g: 86, b: 86 };
    const katColor = { r: 92, g: 166, b: 255 };
    const rollColor = { r: 255, g: 196, b: 84 };

    ctx.fillStyle = 'rgba(28, 30, 36, 0.9)';
    ctx.fillRect(playfieldX, laneY - (laneHeight / 2), playfieldWidth, laneHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(playfieldX + 0.5, laneY - (laneHeight / 2) + 0.5, playfieldWidth - 1, laneHeight - 1);

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
          ? clamp(1 - ((object.time - currentTime) / lookAheadMs), 0, 1) * 0.6
          : clamp(1 - ((currentTime - object.endTime) / LONG_OBJECT_POST_HIT_FADE_MS), 0, 1) * 0.8;
        if (alpha <= 0.02) {
          continue;
        }
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = Math.max(2, laneHeight * 0.14);
        ctx.beginPath();
        ctx.arc(judgeX, laneY, radius, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      if (object.kind === 'slider' || object.kind === 'hold') {
        const headDt = object.time - currentTime;
        const tailDt = object.endTime - currentTime;
        const headX = judgeX + ((headDt / lookAheadMs) * noteTravelWidth);
        const tailX = judgeX + ((tailDt / lookAheadMs) * noteTravelWidth);
        const leftX = Math.min(headX, tailX);
        const rightX = Math.max(headX, tailX);
        if (rightX < (playfieldX - 24) || leftX > (playfieldX + playfieldWidth + 24)) {
          continue;
        }

        let alpha = 0.86;
        if (headDt > 0) {
          alpha = 0.18 + (0.68 * clamp(1 - (headDt / lookAheadMs), 0, 1));
        } else if (currentTime > object.endTime) {
          alpha = 0.86 * clamp(1 - ((currentTime - object.endTime) / LONG_OBJECT_POST_HIT_FADE_MS), 0, 1);
        }
        if (alpha <= 0.02) {
          continue;
        }

        const rollThickness = Math.max(6, laneHeight * 0.48);
        ctx.strokeStyle = withAlpha(rollColor, alpha * 0.9);
        ctx.lineWidth = rollThickness;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(leftX, laneY);
        ctx.lineTo(rightX, laneY);
        ctx.stroke();

        ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, alpha * 0.28);
        ctx.lineWidth = Math.max(1.2, rollThickness * 0.22);
        ctx.beginPath();
        ctx.moveTo(leftX, laneY);
        ctx.lineTo(rightX, laneY);
        ctx.stroke();
        continue;
      }

      const dt = object.time - currentTime;
      const x = judgeX + ((dt / lookAheadMs) * noteTravelWidth);
      if (x < (playfieldX - 20) || x > (playfieldX + playfieldWidth + 20)) {
        continue;
      }

      let alpha = 0.88;
      if (dt > 0) {
        alpha = 0.2 + (0.68 * clamp(1 - (dt / lookAheadMs), 0, 1));
      } else if (dt < 0) {
        alpha = 0.88 * clamp(1 - ((-dt) / CIRCLE_POST_HIT_FADE_MS), 0, 1);
      }
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
  }

  renderCatch(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight) {
    const objects = this.mapData.objects;
    const currentTime = this.currentTimeMs;
    const preemptMs = getApproachPreemptMs(this.mapData.approachRate);
    const comboColours = this.comboColours;
    const circleSize = this.mapData.circleSize;
    const catcherY = playfieldY + (playfieldHeight * 0.9);
    const lookAheadMs = Math.max(900, preemptMs);
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

    let targetCatcherX = playfieldX + (playfieldWidth / 2);
    let previousObject = null;
    let nextObject = null;
    for (const object of objects) {
      if (!object || object.kind === 'spinner') {
        continue;
      }
      if (object.time <= currentTime) {
        previousObject = object;
        continue;
      }
      nextObject = object;
      break;
    }

    if (previousObject && nextObject && nextObject.time > previousObject.time) {
      const t = clamp((currentTime - previousObject.time) / (nextObject.time - previousObject.time), 0, 1);
      const prevX = mapX(previousObject.x);
      const nextX = mapX(nextObject.x);
      targetCatcherX = prevX + ((nextX - prevX) * t);
    } else if (nextObject) {
      targetCatcherX = mapX(nextObject.x);
    } else if (previousObject) {
      targetCatcherX = mapX(previousObject.x);
    }

    const lastRenderX = Number.isFinite(this.catcherRenderX) ? this.catcherRenderX : Number.NaN;
    const lastRenderTime = Number.isFinite(this.catcherRenderTime) ? this.catcherRenderTime : Number.NaN;
    const deltaTime = currentTime - lastRenderTime;
    if (!Number.isFinite(lastRenderX) || !Number.isFinite(lastRenderTime) || deltaTime < 0 || deltaTime > 220) {
      this.catcherRenderX = targetCatcherX;
    } else {
      const blend = clamp(deltaTime / 110, 0.14, 1);
      this.catcherRenderX = lastRenderX + ((targetCatcherX - lastRenderX) * blend);
    }
    this.catcherRenderTime = currentTime;
    const catcherX = this.catcherRenderX;

    const catcherWidth = Math.max(42, playfieldWidth * 0.1);
    const catcherHeight = Math.max(8, playfieldHeight * 0.03);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(catcherX - (catcherWidth / 2), catcherY - (catcherHeight / 2), catcherWidth, catcherHeight);

    const baseFruitRadius = Math.max(6, playfieldHeight * 0.038);
    const csRadiusScale = clamp(getCircleRadius(circleSize) / getCircleRadius(5), 0.45, 1.8);
    const fruitRadius = baseFruitRadius * csRadiusScale;
    const spawnY = playfieldY + 10;
    const catchContactY = catcherY - (catcherHeight / 2) - fruitRadius + 0.5;
    const dropDistance = Math.max(1, catchContactY - spawnY);
    const pixelsPerMs = dropDistance / lookAheadMs;

    for (const object of objects) {
      if (object.time > visibleEnd) {
        break;
      }
      if (object.time < visibleStart) {
        continue;
      }
      if (object.kind === 'spinner') {
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

      const combo = comboColours[object.comboIndex % comboColours.length] || DEFAULT_COLOURS[0];
      ctx.fillStyle = withAlpha(combo, alpha);
      ctx.beginPath();
      ctx.arc(x, y, fruitRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${clamp(alpha * 0.8, 0, 1)})`;
      ctx.lineWidth = Math.max(1.2, fruitRadius * 0.18);
      ctx.beginPath();
      ctx.arc(x, y, fruitRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  renderMania(ctx, playfieldX, playfieldY, playfieldWidth, playfieldHeight) {
    const objects = this.mapData.objects;
    const currentTime = this.currentTimeMs;
    const circleSize = this.mapData.circleSize;
    const approachRate = this.mapData.approachRate;
    const overallDifficulty = this.mapData.overallDifficulty;
    const keys = clamp(Math.round(circleSize || 4), 1, 10);
    const laneAreaWidth = playfieldWidth * 0.62;
    const laneAreaX = playfieldX + ((playfieldWidth - laneAreaWidth) / 2);
    const laneWidth = laneAreaWidth / keys;
    const receptorY = playfieldY + (playfieldHeight * 0.88);
    const diffValue = clamp(
      Number.isFinite(overallDifficulty)
        ? overallDifficulty
        : (Number.isFinite(approachRate) ? approachRate : 5),
      0,
      10,
    );
    const diffProgress = Math.pow(diffValue / 10, 0.95);
    const lookAheadMs = 1500 - (diffProgress * 1100);
    const lookBehindMs = 80;
    const speed = (receptorY - (playfieldY + 8)) / lookAheadMs;
    const visibleStart = currentTime - lookBehindMs;
    const visibleEnd = currentTime + lookAheadMs + 180;
    const centerLane = (keys % 2 === 1) ? Math.floor(keys / 2) : -1;
    const leftBase = { r: 86, g: 154, b: 255 };
    const rightBase = { r: 255, g: 120, b: 178 };
    const centerBase = { r: 255, g: 211, b: 108 };

    const getLaneGroupBase = (lane) => {
      if (lane === centerLane) {
        return centerBase;
      }
      if (centerLane >= 0) {
        return lane < centerLane ? leftBase : rightBase;
      }
      return lane < (keys / 2) ? leftBase : rightBase;
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
    const postJudgeTravelPx = Math.max(receptorHalf, noteHeight * 0.25);
    const postJudgeDelayMs = postJudgeTravelPx / Math.max(speed, 0.001);
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
      if (dt > 0) {
        alpha = 0.24 + (0.66 * clamp(1 - (dt / lookAheadMs), 0, 1));
      } else if (isHoldNote) {
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
      const rawHeadY = receptorY - ((object.time - currentTime) * speed) - (noteHeight / 2);
      const headY = (isHoldNote && currentTime >= object.time && currentTime <= holdEndClampTime)
        ? (receptorY - (noteHeight / 2))
        : rawHeadY;
      const shouldRenderHoldBody = isHoldNote && currentTime <= holdEndClampTime;

      if (!isHoldNote) {
        const noteCenterY = headY + (noteHeight / 2);
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
        const tailY = receptorY - ((object.endTime - currentTime) * speed) + (noteHeight / 2);
        const bodyTop = Math.max(playfieldY - 20, Math.min(headY, tailY));
        const bodyBottom = Math.min(
          holdBodyBottomClampY,
          Math.max(headY + noteHeight, tailY),
        );
        const bodyHeight = bodyBottom - bodyTop;
        if (bodyHeight > 2) {
          ctx.fillStyle = withAlpha(groupBase, alpha * 0.35);
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

    visibleObjects.sort((a, b) => {
      const aIsFuture = a.time > this.currentTimeMs;
      const bIsFuture = b.time > this.currentTimeMs;
      if (aIsFuture !== bIsFuture) {
        return aIsFuture ? -1 : 1;
      }
      return a.time - b.time;
    });

    for (const object of visibleObjects) {
      const combo = this.comboColours[object.comboIndex % this.comboColours.length] || DEFAULT_COLOURS[0];
      let sliderHeadCanvasPoint = null;
      let sliderHeadElapsedMs = -1;
      let sliderHeadHitProgress = 0;
      let sliderHeadHitAlpha = 0;
      let sliderHeadHitRadius = drawnCircleRadius;
      if (object.kind === 'slider') {
        const sliderHead = getObjectStartPositionOsu(object);
        sliderHeadCanvasPoint = toCanvas(sliderHead.x, sliderHead.y);
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
        const fadeInProgress = 1 - clamp(timeUntil / preemptMs, 0, 1);
        baseAlpha = OBJECT_VISUAL_MAX_ALPHA * Math.pow(fadeInProgress, 2.2);
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

      if (object.kind === 'slider') {
        const pathPoints = buildSliderPathPointsOsu(object).map((p) => toCanvas(p.x, p.y));
        if (pathPoints.length > 1) {
          const sliderBodyOutlineAlpha = clamp((baseAlpha * 0.9) + 0.015, 0, 0.86);
          ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, sliderBodyOutlineAlpha);
          ctx.lineWidth = (sliderBodyRadius * 2) + Math.max(1.3, circleRadius * 0.16);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
          for (let i = 1; i < pathPoints.length; i += 1) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
          }
          ctx.stroke();

          ctx.strokeStyle = withAlpha(combo, baseAlpha * 0.65);
          ctx.lineWidth = sliderBodyRadius * 2;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
          for (let i = 1; i < pathPoints.length; i += 1) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
          }
          ctx.stroke();

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

            drawReverseIndicator(ctx, endPoint, endDir, indicatorSize, baseAlpha * 0.95);
            if ((object.slides || 1) >= 3) {
              drawReverseIndicator(ctx, startPoint, startDir, indicatorSize, baseAlpha * 0.95);
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

        ctx.strokeStyle = withAlpha(combo, baseAlpha * 0.8);
        ctx.lineWidth = Math.max(2, drawnCircleRadius * 0.3);
        ctx.beginPath();
        ctx.arc(centerX, centerY, spinnerRadius, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      if (timeUntil > 0 && timeUntil <= preemptMs) {
        const approachProgress = clamp(timeUntil / preemptMs, 0, 1);
        const approachRadius = drawnCircleRadius * (1 + 2.2 * approachProgress);
        const fadeInProgress = 1 - approachProgress;
        ctx.strokeStyle = withAlpha(combo, (0.55 * fadeInProgress) + 0.06);
        ctx.lineWidth = Math.max(1.5, drawnCircleRadius * 0.14);
        ctx.beginPath();
        ctx.arc(point.x, point.y, approachRadius, 0, Math.PI * 2);
        ctx.stroke();
      }

      const objectBodyBaseAlpha = clamp((objectRenderAlpha * 0.9) + 0.015, 0, 0.86);
      const objectBodyComboAlpha = clamp(objectRenderAlpha * 0.65, 0, 1);
      ctx.fillStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectBodyBaseAlpha);
      ctx.beginPath();
      ctx.arc(point.x, point.y, objectRenderRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = withAlpha(combo, objectBodyComboAlpha);
      ctx.beginPath();
      ctx.arc(point.x, point.y, objectRenderRadius, 0, Math.PI * 2);
      ctx.fill();

      const objectOutlineAlpha = clamp((objectRenderAlpha * 1.12) + 0.03, 0, 1);
      const objectOutlineWidth = Math.max(1.3, objectRenderRadius * 0.1);
      const objectOutlineRadius = Math.max(0.5, objectRenderRadius - (objectOutlineWidth * 0.5));
      ctx.strokeStyle = withAlpha({ r: 255, g: 255, b: 255 }, objectOutlineAlpha);
      ctx.lineWidth = objectOutlineWidth;
      ctx.beginPath();
      ctx.arc(point.x, point.y, objectOutlineRadius, 0, Math.PI * 2);
      ctx.stroke();

      if (object.kind === 'slider' && sliderHeadCanvasPoint && sliderHeadHitAlpha > 0.001) {
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
