import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertMapForMode,
  difficultyRange,
  getConversionDifficulty,
} from '../src/core/beatmapConversion.js';

const baseMap = (overrides = {}) => ({
  mode: 0,
  objects: [],
  breaks: [],
  circleSize: 4,
  approachRate: 9,
  overallDifficulty: 8,
  hpDrainRate: 6,
  sliderMultiplier: 1.4,
  sliderTickRate: 1,
  timingControlPoints: [
    { time: 0, beatLength: 300, uninherited: true, svMultiplier: 1, kiai: false },
  ],
  ...overrides,
});

test('difficultyRange is piecewise through (0,min) (5,mid) (10,max)', () => {
  // The old swell formula interpolated straight from min to max, so it only
  // agreed with lazer at the endpoints.
  assert.equal(difficultyRange(0, 3, 5, 7.5), 3);
  assert.equal(difficultyRange(5, 3, 5, 7.5), 5);
  assert.equal(difficultyRange(10, 3, 5, 7.5), 7.5);
  assert.equal(difficultyRange(2.5, 3, 5, 7.5), 4);
  assert.equal(difficultyRange(7.5, 3, 5, 7.5), 6.25);
});

test('conversion difficulty tracks note density, not just the difficulty settings', () => {
  const sparse = baseMap({
    objects: Array.from({ length: 50 }, (_, i) => ({ kind: 'circle', x: 100, y: 100, time: i * 2000, endTime: i * 2000 })),
  });
  const dense = baseMap({
    objects: Array.from({ length: 2000 }, (_, i) => ({ kind: 'circle', x: 100, y: 100, time: i * 50, endTime: i * 50 })),
  });

  assert.ok(
    getConversionDifficulty(dense) > getConversionDifficulty(sparse),
    'a denser map must convert at a higher difficulty',
  );
  // The old formula was OD + CS*0.1 + HP*0.08 for both, i.e. identical.
  assert.notEqual(getConversionDifficulty(dense), getConversionDifficulty(sparse));
});

test('conversion difficulty subtracts break time and is capped at 12', () => {
  const objects = Array.from({ length: 500 }, (_, i) => ({ kind: 'circle', x: 100, y: 100, time: i * 100, endTime: i * 100 }));
  const withoutBreak = getConversionDifficulty(baseMap({ objects }));
  const withBreak = getConversionDifficulty(baseMap({ objects, breaks: [{ start: 1000, end: 21000 }] }));

  assert.ok(withBreak > withoutBreak, 'removing drain time must raise the density term');
  assert.ok(getConversionDifficulty(baseMap({ objects, breaks: [{ start: 0, end: 49_000 }] })) <= 12);
});

test('catch droplets follow the slider curve, not the control polygon', () => {
  // A bezier that bows hard to the right. Straight-line interpolation between
  // the control points puts the midpoint near x=100; the real curve does not.
  const map = baseMap({
    objects: [{
      kind: 'slider',
      x: 0,
      y: 192,
      time: 0,
      endTime: 1000,
      slides: 1,
      sliderCurveType: 'B',
      sliderPoints: [{ x: 400, y: 192 }, { x: 200, y: 192 }],
      length: 400,
      newCombo: false,
      comboSkip: 0,
    }],
  });

  const converted = convertMapForMode(map, 2);
  const droplets = converted.catchObjects.filter((object) => object.type !== 'banana');
  assert.ok(droplets.length > 2, 'expected the slider to generate droplets');

  const maxX = Math.max(...droplets.map((object) => object.x));
  // The control polygon reaches x=400, but the curve itself never does.
  assert.ok(maxX < 400, `curve should stay inside its control polygon, reached ${maxX}`);
  assert.ok(maxX > 150, `curve should still travel right, only reached ${maxX}`);
});

test('a straight slider still places its tail at the declared distance', () => {
  const map = baseMap({
    objects: [{
      kind: 'slider',
      x: 50,
      y: 192,
      time: 0,
      endTime: 1000,
      slides: 1,
      sliderCurveType: 'L',
      sliderPoints: [{ x: 250, y: 192 }],
      length: 200,
      newCombo: false,
      comboSkip: 0,
    }],
  });

  const converted = convertMapForMode(map, 2);
  const fruits = converted.catchObjects.filter((object) => object.type === 'fruit');
  assert.equal(fruits.length, 2);
  assert.equal(Math.round(fruits[0].x), 50);
  assert.equal(Math.round(fruits[1].x), 250);
});

test('a slider with no declared distance falls back to its curve length', () => {
  // Fitting to a declared length of zero would collapse the path to one point.
  const map = baseMap({
    objects: [{
      kind: 'slider',
      x: 0,
      y: 192,
      time: 0,
      endTime: 500,
      slides: 1,
      sliderCurveType: 'L',
      sliderPoints: [{ x: 300, y: 192 }],
      length: 0,
      newCombo: false,
      comboSkip: 0,
    }],
  });

  const converted = convertMapForMode(map, 1);
  assert.ok(converted.objects.length > 0, 'a zero-length slider must still convert to something');
  assert.ok(
    converted.objects.some((object) => object.endTime > object.time || object.kind === 'circle'),
    'the taiko conversion should have a non-degenerate duration',
  );
});
