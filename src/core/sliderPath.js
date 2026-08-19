// Slider curve geometry, shared by the osu!standard renderer and the ruleset
// converters. It used to live only in renderer.js, so the catch converter had
// its own straight-line approximation and put every droplet on a curved slider
// in the wrong place.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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

/** Position at a 0-1 fraction of a polyline's arc length. */
const positionOnPathAtProgress = (path, progress) => {
  if (!Array.isArray(path) || path.length === 0) {
    return { x: 0, y: 0 };
  }
  if (path.length === 1) {
    return path[0];
  }

  let target = clamp(Number(progress) || 0, 0, 1) * getPathLength(path);
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
  trimPathFromStart,
  trimPathToLength,
};
