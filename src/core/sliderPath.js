// Slider curve geometry, shared by the osu!standard renderer and the ruleset
// converters. It used to live only in renderer.js, so the catch converter had
// its own straight-line approximation and put every droplet on a curved slider
// in the wrong place.

import { clamp } from './math.js';

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

// Takes the first `targetLength` units of a polyline. Used for slider snaking,
// which must never extend past the real path, so this stays a pure truncation:
// fitting to a slider's declared distance is fitPathToExpectedDistance below.
const trimPathToLength = (points, targetLength) => {
  const cleanPoints = dedupeAdjacentPoints(points);
  if (cleanPoints.length < 2 || !Number.isFinite(targetLength)) {
    return cleanPoints;
  }
  if (targetLength <= 0) {
    return [cleanPoints[0]];
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

const trimPathFromStart = (points, trimLength) => {
  const cleanPoints = dedupeAdjacentPoints(points);
  if (cleanPoints.length < 2 || !Number.isFinite(trimLength) || trimLength <= 0) {
    return cleanPoints;
  }

  let remaining = trimLength;
  for (let i = 1; i < cleanPoints.length; i += 1) {
    const start = cleanPoints[i - 1];
    const end = cleanPoints[i];
    const segmentLength = pointDistance(start, end);
    if (segmentLength <= 0) {
      continue;
    }

    if (remaining >= segmentLength) {
      remaining -= segmentLength;
      continue;
    }

    const t = clamp(remaining / segmentLength, 0, 1);
    return dedupeAdjacentPoints([
      {
        x: start.x + ((end.x - start.x) * t),
        y: start.y + ((end.y - start.y) * t),
      },
      ...cleanPoints.slice(i),
    ]);
  }

  return [cleanPoints[cleanPoints.length - 1]];
};

/**
 * Fits a sampled curve to the slider's declared distance, matching osu!lazer's
 * SliderPath.calculateLength(). A path longer than the declared distance is
 * truncated; a path *shorter* than it is extended along its final segment.
 * Only truncation used to be implemented, so sliders whose control points
 * describe less than the declared length rendered short and the ball reached
 * the tail early.
 *
 * osu!stable skips the extension when the last two control points coincide and
 * lazer reproduces that quirk, which is what `allowExtension` carries through.
 */
const fitPathToExpectedDistance = (points, expectedDistance, { allowExtension = true } = {}) => {
  const cleanPoints = dedupeAdjacentPoints(points);
  if (cleanPoints.length < 2 || !Number.isFinite(expectedDistance)) {
    return cleanPoints;
  }
  if (expectedDistance <= 0) {
    return [cleanPoints[0]];
  }

  const calculatedLength = getPathLength(cleanPoints);
  if (calculatedLength >= expectedDistance) {
    return trimPathToLength(cleanPoints, expectedDistance);
  }

  const last = cleanPoints[cleanPoints.length - 1];
  const previous = cleanPoints[cleanPoints.length - 2];
  const segmentLength = pointDistance(previous, last);
  if (!allowExtension || segmentLength <= 0) {
    return cleanPoints;
  }

  const shortfall = expectedDistance - calculatedLength;
  return [
    ...cleanPoints.slice(0, -1),
    {
      x: last.x + (((last.x - previous.x) / segmentLength) * shortfall),
      y: last.y + (((last.y - previous.y) / segmentLength) * shortfall),
    },
  ];
};

// osu!lazer's PathApproximator.BezierToPiecewiseLinear. A span is halved until
// every piece is flat to within a quarter of an osu!pixel, rather than sampled
// at a step count guessed from its control polygon: a fixed count both
// over-samples a near-straight span and under-samples a tight one, and an
// under-sampled span measures *short*, which fitPathToExpectedDistance then
// hides by extending the slider past where its control points really end.
const BEZIER_TOLERANCE = 0.25;
const BEZIER_FLATNESS_SQUARED = BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4;
// No real slider comes near this, but a corrupt file should not be able to
// spend a whole frame subdividing one span.
const MAX_BEZIER_POINTS = 65536;

// Spans are held as flat x, y pairs rather than point objects: this walks every
// control point of every slider in a map, and the per-point objects the old
// sampler allocated were most of what it cost.
const bezierIsFlatEnough = (span, count) => {
  for (let i = 1; i < count - 1; i += 1) {
    const x = span[(i - 1) * 2] - (2 * span[i * 2]) + span[(i + 1) * 2];
    const y = span[((i - 1) * 2) + 1] - (2 * span[(i * 2) + 1]) + span[((i + 1) * 2) + 1];
    if (((x * x) + (y * y)) > BEZIER_FLATNESS_SQUARED) {
      return false;
    }
  }
  return true;
};

// de Casteljau at the midpoint: `left` and `right` come back holding the control
// points of the two halves. `midpoints` is scratch the length of one span.
const bezierSubdivide = (span, left, right, midpoints, count) => {
  for (let i = 0; i < count * 2; i += 1) {
    midpoints[i] = span[i];
  }

  for (let i = 0; i < count; i += 1) {
    const last = count - i - 1;
    left[i * 2] = midpoints[0];
    left[(i * 2) + 1] = midpoints[1];
    right[last * 2] = midpoints[last * 2];
    right[(last * 2) + 1] = midpoints[(last * 2) + 1];
    for (let j = 0; j < last; j += 1) {
      midpoints[j * 2] = (midpoints[j * 2] + midpoints[(j + 1) * 2]) / 2;
      midpoints[(j * 2) + 1] = (midpoints[(j * 2) + 1] + midpoints[((j + 1) * 2) + 1]) / 2;
    }
  }
};

// A span flat enough to stop subdividing contributes one point per control
// point, each the weighted mean of its neighbours across both halves. `left`
// holds 2 * count - 1 points, the two halves laid end to end.
const bezierApproximate = (span, output, left, right, midpoints, count) => {
  bezierSubdivide(span, left, right, midpoints, count);

  for (let i = 0; i < count - 1; i += 1) {
    left[(count + i) * 2] = right[(i + 1) * 2];
    left[((count + i) * 2) + 1] = right[((i + 1) * 2) + 1];
  }

  output.push({ x: span[0], y: span[1] });
  for (let i = 1; i < count - 1; i += 1) {
    const index = 2 * i;
    output.push({
      x: 0.25 * (left[(index - 1) * 2] + (2 * left[index * 2]) + left[(index + 1) * 2]),
      y: 0.25 * (left[((index - 1) * 2) + 1] + (2 * left[(index * 2) + 1]) + left[((index + 1) * 2) + 1]),
    });
  }
};

const sampleBezierSegment = (controlPoints) => {
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
    return [];
  }
  // A two-point Bezier is exactly a line, and subdividing one only ever hands
  // back its own endpoints.
  if (controlPoints.length === 2) {
    return [controlPoints[0], controlPoints[1]];
  }

  const count = controlPoints.length;
  const left = new Float64Array(((count * 2) - 1) * 2);
  const right = new Float64Array(count * 2);
  const midpoints = new Float64Array(count * 2);
  const first = new Float64Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    first[i * 2] = controlPoints[i].x;
    first[(i * 2) + 1] = controlPoints[i].y;
  }

  const output = [];
  const toFlatten = [first];
  const freeSpans = [];

  while (toFlatten.length > 0 && output.length < MAX_BEZIER_POINTS) {
    const span = toFlatten.pop();
    if (bezierIsFlatEnough(span, count)) {
      bezierApproximate(span, output, left, right, midpoints, count);
      freeSpans.push(span);
      continue;
    }

    // The left half replaces the span itself, so the two go back on the stack
    // in order and the curve comes out start to end.
    const rightSpan = freeSpans.pop() || new Float64Array(count * 2);
    bezierSubdivide(span, left, rightSpan, midpoints, count);
    for (let i = 0; i < count * 2; i += 1) {
      span[i] = left[i];
    }
    toFlatten.push(rightSpan, span);
  }

  output.push(controlPoints[count - 1]);
  return output;
};

const distanceToSegmentSquared = (point, start, end, scaleX, scaleY) => {
  const pointX = (point.x - start.x) * scaleX;
  const pointY = (point.y - start.y) * scaleY;
  const segmentX = (end.x - start.x) * scaleX;
  const segmentY = (end.y - start.y) * scaleY;
  const segmentLengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  if (segmentLengthSquared <= 0) {
    return (pointX * pointX) + (pointY * pointY);
  }

  const projection = clamp(
    ((pointX * segmentX) + (pointY * segmentY)) / segmentLengthSquared,
    0,
    1,
  );
  const deltaX = pointX - (projection * segmentX);
  const deltaY = pointY - (projection * segmentY);
  return (deltaX * deltaX) + (deltaY * deltaY);
};

// Ramer–Douglas–Peucker in rendered-pixel space. The canonical slider path is
// kept intact for timing, ticks, and the slider ball; this smaller polyline is
// only for drawing the body. `minPointCount` leaves ordinary paths alone: a
// tolerance-sized error still turns a smooth arc into a handful of long chords,
// which is only an acceptable trade on anchor-dense decorative sliders.
const simplifyPathForRendering = (
  points,
  tolerance = 0.25,
  scaleX = 1,
  scaleY = 1,
  minPointCount = 0,
) => {
  if (
    !Array.isArray(points)
    || points.length < 3
    || points.length <= Math.max(0, Number(minPointCount) || 0)
  ) {
    return points || [];
  }

  const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
  const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;
  const safeTolerance = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0.25;
  const toleranceSquared = safeTolerance * safeTolerance;
  const kept = new Uint8Array(points.length);
  const pending = [[0, points.length - 1]];
  kept[0] = 1;
  kept[points.length - 1] = 1;

  while (pending.length) {
    const [startIndex, endIndex] = pending.pop();
    const start = points[startIndex];
    const end = points[endIndex];
    let furthestIndex = -1;
    let furthestDistance = toleranceSquared;

    for (let i = startIndex + 1; i < endIndex; i += 1) {
      const distance = distanceToSegmentSquared(
        points[i], start, end, safeScaleX, safeScaleY,
      );
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthestIndex = i;
      }
    }

    if (furthestIndex >= 0) {
      kept[furthestIndex] = 1;
      pending.push([startIndex, furthestIndex], [furthestIndex, endIndex]);
    }
  }

  const simplified = [];
  for (let i = 0; i < points.length; i += 1) {
    if (kept[i]) simplified.push(points[i]);
  }
  return simplified;
};

// Repeated control points ("red anchors") split a bezier into independent
// segments, each starting where the previous one ended.
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

// osu!lazer's PathApproximator.catmull_detail: a fixed subdivision count per
// span, not one scaled to the span's length.
const CATMULL_DETAIL = 50;

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
    // Past the last control point lazer extrapolates the final tangent rather
    // than holding the endpoint still; clamping to p2 instead flattened the
    // tail of every Catmull slider.
    const p3 = (i + 2 < pathPoints.length)
      ? pathPoints[i + 2]
      : { x: (2 * p2.x) - p1.x, y: (2 * p2.y) - p1.y };

    for (let step = 0; step <= CATMULL_DETAIL; step += 1) {
      const t = step / CATMULL_DETAIL;
      const point = catmull(p0, p1, p2, p3, t);
      if (!sampled.length || !pointsEqual(sampled[sampled.length - 1], point)) {
        sampled.push(point);
      }
    }
  }

  return dedupeAdjacentPoints(sampled);
};

// osu!lazer's PathApproximator.circular_arc_tolerance, in osu!pixels, and a
// ceiling so a near-degenerate circumcircle cannot ask for an endless arc.
const CIRCULAR_ARC_TOLERANCE = 0.1;
const MAX_CIRCULAR_ARC_STEPS = 2048;

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

  // osu!lazer's PathApproximator.CircularArcToPiecewiseLinear: exactly enough
  // chords that none strays further than the tolerance from the arc, which on a
  // wide arc is fewer points than a length-based guess and on a tight one more.
  const arcAngle = angleDistance(angle0, angle2, direction);
  const steps = (2 * radius) <= CIRCULAR_ARC_TOLERANCE
    ? 1
    : clamp(
      Math.ceil(arcAngle / (2 * Math.acos(1 - (CIRCULAR_ARC_TOLERANCE / radius)))) - 1,
      1,
      MAX_CIRCULAR_ARC_STEPS,
    );

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

/**
 * Samples a slider's curve into a polyline, fitted to its declared distance.
 * `offset` applies osu!standard's stack displacement; the converters pass none,
 * since only osu!standard stacks.
 */
const buildSliderCurvePoints = (object, offset = { x: 0, y: 0 }) => {
  if (!object || object.kind !== 'slider') {
    return [];
  }

  const offsetX = Number(offset?.x) || 0;
  const offsetY = Number(offset?.y) || 0;
  const rawPoints = [
    { x: (Number(object.x) || 0) + offsetX, y: (Number(object.y) || 0) + offsetY },
    ...(Array.isArray(object.sliderPoints) ? object.sliderPoints : []).map((point) => ({
      x: (Number(point.x) || 0) + offsetX,
      y: (Number(point.y) || 0) + offsetY,
    })),
  ];

  // Only three control points define an arc, so osu!lazer's ConvertHitObjectParser
  // downgrades any other perfect curve to a bezier. Reading just the first three
  // points instead silently dropped the rest of the slider.
  const declaredType = String(object.sliderCurveType || 'B').toUpperCase();
  const curveType = (declaredType === 'P' && rawPoints.length !== 3) ? 'B' : declaredType;

  const basePoints = curveType === 'B' ? rawPoints : dedupeAdjacentPoints(rawPoints);
  if (basePoints.length < 2) {
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

  const lastTwoCoincide = rawPoints.length >= 2
    && pointsEqual(rawPoints[rawPoints.length - 1], rawPoints[rawPoints.length - 2]);
  const fitted = fitPathToExpectedDistance(sampled, object.length, {
    allowExtension: !lastTwoCoincide,
  });
  return fitted.length >= 2 ? fitted : sampled;
};

/**
 * Position at a 0-1 fraction of a polyline's arc length. Runs every frame for
 * each visible slider ball, so it walks the path in place rather than building
 * a cleaned copy first; repeated points are zero-length segments either way.
 */
const positionOnPathAtProgress = (path, progress) => {
  if (!Array.isArray(path) || path.length === 0) {
    return { x: 0, y: 0 };
  }
  if (path.length === 1) {
    return path[0];
  }

  let totalLength = 0;
  for (let i = 1; i < path.length; i += 1) {
    totalLength += pointDistance(path[i - 1], path[i]);
  }
  let target = clamp(Number(progress) || 0, 0, 1) * totalLength;
  for (let i = 1; i < path.length; i += 1) {
    const segmentLength = pointDistance(path[i - 1], path[i]);
    if (target <= segmentLength || i === path.length - 1) {
      const t = segmentLength <= 0 ? 0 : clamp(target / segmentLength, 0, 1);
      return {
        x: path[i - 1].x + ((path[i].x - path[i - 1].x) * t),
        y: path[i - 1].y + ((path[i].y - path[i - 1].y) * t),
      };
    }
    target -= segmentLength;
  }

  return path[path.length - 1];
};

export {
  buildSliderCurvePoints,
  dedupeAdjacentPoints,
  fitPathToExpectedDistance,
  getPathLength,
  pointDistance,
  pointsEqual,
  positionOnPathAtProgress,
  sampleBezierPath,
  sampleCatmullPath,
  samplePerfectCirclePath,
  simplifyPathForRendering,
  trimPathFromStart,
  trimPathToLength,
};
