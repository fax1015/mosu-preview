import test from 'node:test';
import assert from 'node:assert/strict';
import { getElapsedBeatsAt, getTimingSections, getTimingStateAt } from '../src/core/controlPoints.js';
import { PreviewRenderer } from '../src/renderer.js';

// A deterministic SV-heavy map: a BPM change every few seconds, a greenline
// every 100ms, and some points sharing a timestamp the way real maps do.
const buildControlPoints = () => {
  const points = [];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let time = 1000; time < 60000; time += 100) {
    if (time % 4000 === 0) {
      points.push({ time, beatLength: 300 + Math.floor(next() * 300), uninherited: true, meter: 3 + (time % 3) });
    }
    points.push({ time, beatLength: -100, uninherited: false, svMultiplier: 0.5 + (next() * 2), kiai: next() > 0.7 });
  }
  return points;
};

// The walk every lookup used to do, kept here as the definition of correct.
const referenceStateAt = (points, time) => {
  const first = points.find((point) => point.uninherited && point.beatLength > 0);
  let beatLength = first ? first.beatLength : 500;
  let svMultiplier = 1;
  let kiai = false;
  for (const point of points) {
    if (point.time > time) break;
    kiai = Boolean(point.kiai);
    if (point.uninherited && point.beatLength > 0) {
      beatLength = point.beatLength;
      svMultiplier = 1;
    } else if (!point.uninherited && point.svMultiplier > 0) {
      svMultiplier = point.svMultiplier;
    }
  }
  return { beatLength, svMultiplier, kiai };
};

// Integrates SV / beat length segment by segment between control points.
const referenceElapsedBeats = (points, from, to, withSv) => {
  const sign = to >= from ? 1 : -1;
  const [start, end] = sign > 0 ? [from, to] : [to, from];
  let total = 0;
  let segmentStart = start;
  for (const point of points) {
    if (point.time <= start) continue;
    if (point.time >= end) break;
    const state = referenceStateAt(points, segmentStart);
    total += ((point.time - segmentStart) / state.beatLength) * (withSv ? state.svMultiplier : 1);
    segmentStart = point.time;
  }
  const state = referenceStateAt(points, segmentStart);
  total += ((end - segmentStart) / state.beatLength) * (withSv ? state.svMultiplier : 1);
  return total * sign;
};

test('indexed timing state agrees with a full walk everywhere', () => {
  const points = buildControlPoints();
  for (let time = -500; time < 61000; time += 37) {
    const expected = referenceStateAt(points, time);
    const actual = getTimingStateAt(points, time);
    assert.equal(actual.beatLength, expected.beatLength, `beat length at ${time}`);
    assert.equal(actual.svMultiplier, expected.svMultiplier, `SV at ${time}`);
    assert.equal(actual.kiai, expected.kiai, `kiai at ${time}`);
  }
});

test('elapsed beats between two times match an integral over every segment', () => {
  const points = buildControlPoints();
  const pairs = [[500, 900], [900, 5500], [12345, 23456], [40000, 39000], [58000, 61000], [-200, 1500]];
  for (const withSv of [true, false]) {
    for (const [from, to] of pairs) {
      const expected = referenceElapsedBeats(points, from, to, withSv);
      const actual = getElapsedBeatsAt(points, to, { withSv }) - getElapsedBeatsAt(points, from, { withSv });
      assert.ok(Math.abs(actual - expected) < 1e-6, `${from}->${to} withSv=${withSv}: ${actual} vs ${expected}`);
    }
  }
});

test('mania scroll offset is the old per-segment sum, computed without the walk', () => {
  const points = buildControlPoints();
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = { mode: 3, timingControlPoints: points, primaryBpm: 150 };
  renderer.maniaScrollSpeed = 28;

  const height = 800;
  for (const [from, to] of [[2000, 9000], [30000, 30050], [45000, 41000]]) {
    let expected = 0;
    const sign = to >= from ? 1 : -1;
    const [start, end] = sign > 0 ? [from, to] : [to, from];
    let segmentStart = start;
    for (const point of points) {
      if (point.time <= start) continue;
      if (point.time >= end) break;
      expected += renderer.getManiaPixelsPerMs(segmentStart, height) * (point.time - segmentStart);
      segmentStart = point.time;
    }
    expected += renderer.getManiaPixelsPerMs(segmentStart, height) * (end - segmentStart);
    expected *= sign;

    const actual = renderer.getManiaScrollOffset(from, to, height);
    assert.ok(Math.abs(actual - expected) < 1e-6, `${from}->${to}: ${actual} vs ${expected}`);
  }
});

test('a converted mania map scrolls without its greenlines', () => {
  const points = buildControlPoints();
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = {
    mode: 3,
    timingControlPoints: points,
    primaryBpm: 150,
    conversion: { sourceMode: 0, targetMode: 3 },
  };

  const expected = getElapsedBeatsAt(points, 9000, { withSv: false })
    - getElapsedBeatsAt(points, 2000, { withSv: false });
  const actual = renderer.getManiaScrollOffset(2000, 9000, 800) / renderer.getManiaPixelsPerBeat(800);
  assert.ok(Math.abs(actual - expected) < 1e-9);
});

test('notes before the first timing point scroll at that point\'s tempo, not 120 BPM', () => {
  // The renderer's own copies of the lookup each assumed 120 BPM here.
  const points = [{ time: 5000, beatLength: 250, uninherited: true, meter: 4 }];
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = { mode: 3, timingControlPoints: points, primaryBpm: 240 };

  assert.equal(renderer.getManiaTimingState(1000).beatLength, 250);
  assert.equal(
    renderer.getManiaPixelsPerMs(1000, 800),
    renderer.getManiaPixelsPerMs(6000, 800),
    'speed should not change when the first timing point is reached',
  );

  renderer.mapData = { mode: 1, timingControlPoints: points, sliderMultiplier: 1.4 };
  assert.equal(renderer.getTaikoPixelsPerMs(1000, 512), renderer.getTaikoPixelsPerMs(6000, 512));
});

test('taiko bar lines stay bounded on a corrupt beat length', () => {
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = {
    mode: 1,
    timingControlPoints: [{ time: 0, beatLength: 0.0001, uninherited: true, meter: 4 }],
  };

  const lines = renderer.getTaikoMeasureLines(0, 8000);
  assert.ok(lines.length <= 8000 / (6 * 4) + 2, `${lines.length} bar lines in one frame`);
});

test('timing sections are only the uninherited points, in order', () => {
  const points = buildControlPoints();
  const sections = getTimingSections(points);
  assert.ok(sections.length > 0);
  assert.ok(sections.every((point) => point.uninherited));
  assert.deepEqual(sections, points.filter((point) => point.uninherited));
});
