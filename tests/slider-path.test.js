import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSliderCurvePoints,
  fitPathToExpectedDistance,
  getPathLength,
  positionOnPathAtProgress,
} from '../src/core/sliderPath.js';
import { getTimingStateAt } from '../src/core/controlPoints.js';

const slider = (overrides = {}) => ({
  kind: 'slider',
  x: 0,
  y: 0,
  slides: 1,
  sliderCurveType: 'B',
  sliderPoints: [],
  length: 100,
  ...overrides,
});

test('a perfect curve with more than three control points falls back to bezier', () => {
  // osu!lazer's ConvertHitObjectParser downgrades any perfect curve that is not
  // exactly three control points to a bezier. Reading only the first three
  // points instead silently dropped the rest of the slider.
  const points = [
    { x: 100, y: 0 },
    { x: 200, y: 100 },
    { x: 300, y: 0 },
  ];
  const arc = buildSliderCurvePoints(slider({ sliderCurveType: 'P', sliderPoints: points.slice(0, 2), length: 200 }));
  const bezier = buildSliderCurvePoints(slider({ sliderCurveType: 'P', sliderPoints: points, length: 200 }));

  // The three-point form still traces a circular arc through its middle point.
  assert.ok(arc.length > 2);

  // The four-point form must not simply reuse the first three: its tail has to
  // head towards the fourth control point.
  const bezierTail = bezier[bezier.length - 1];
  assert.ok(bezierTail.x > 150, `expected the fourth control point to pull the tail right, got x=${bezierTail.x}`);
});

test('a path shorter than the declared distance is extended, not left short', () => {
  const path = [{ x: 0, y: 0 }, { x: 60, y: 0 }];
  const fitted = fitPathToExpectedDistance(path, 100);
  assert.equal(Math.round(getPathLength(fitted)), 100);
  assert.equal(Math.round(fitted[fitted.length - 1].x), 100);
});

test('a path longer than the declared distance is still truncated', () => {
  const path = [{ x: 0, y: 0 }, { x: 250, y: 0 }];
  const fitted = fitPathToExpectedDistance(path, 100);
  assert.equal(Math.round(getPathLength(fitted)), 100);
});

test('extension is skipped when the last two control points coincide', () => {
  // osu!stable does not extend in this case and lazer reproduces the quirk.
  const points = [{ x: 60, y: 0 }, { x: 60, y: 0 }];
  const curve = buildSliderCurvePoints(slider({ sliderCurveType: 'L', sliderPoints: points, length: 300 }));
  assert.ok(getPathLength(curve) < 100, `expected no extension, got ${getPathLength(curve)}`);
});

test('positions follow the curve rather than the control polygon', () => {
  // A single bezier arc: the true midpoint sits well off the straight line
  // between head and tail, which is what the catch converter used to assume.
  const curve = buildSliderCurvePoints(slider({
    sliderCurveType: 'B',
    sliderPoints: [{ x: 100, y: 200 }, { x: 200, y: 0 }],
    length: 260,
  }));
  const middle = positionOnPathAtProgress(curve, 0.5);
  assert.ok(middle.y > 40, `expected the curve to bow away from the chord, got y=${middle.y}`);
});

test('timing before the first control point uses that point, not a default tempo', () => {
  // 200 BPM = 300ms beat length. The old fallback reported 120 BPM for anything
  // ahead of the first timing point.
  const controlPoints = [{ time: 5000, beatLength: 300, uninherited: true, svMultiplier: 1 }];
  assert.equal(getTimingStateAt(controlPoints, 0).beatLength, 300);
  assert.equal(getTimingStateAt(controlPoints, 9999).beatLength, 300);
});

test('slider velocity resets at an uninherited timing point', () => {
  const controlPoints = [
    { time: 0, beatLength: 300, uninherited: true, svMultiplier: 1 },
    { time: 1000, beatLength: -50, uninherited: false, svMultiplier: 2 },
    { time: 2000, beatLength: 400, uninherited: true, svMultiplier: 1 },
  ];
  assert.equal(getTimingStateAt(controlPoints, 1500).svMultiplier, 2);
  assert.equal(getTimingStateAt(controlPoints, 2500).svMultiplier, 1);
  assert.equal(getTimingStateAt(controlPoints, 2500).beatLength, 400);
});
