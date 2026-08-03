import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapPreviewData } from '../src/parser.js';
import {
  convertMapForMode,
  getManiaConversionSeed,
  getManiaKeyCount,
} from '../src/core/beatmapConversion.js';

const standardMap = `
osu file format v14

[General]
Mode:0

[Difficulty]
CircleSize:4
OverallDifficulty:6
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,1,5,0:0:0:0:
256,192,1500,2,2,B|356:192,1,200,2,
128,192,3000,8,4,4000
`;

test('converts a standard map to taiko objects when requested', () => {
  const map = convertMapForMode(parseMapPreviewData(standardMap), 1);

  assert.equal(map.mode, 1);
  assert.equal(map.conversion.targetMode, 1);
  assert.equal(map.objects[0].kind, 'circle');
  assert.equal(map.objects[0].hitSound, 5);
  assert.ok(map.objects.some((object) => object.kind === 'hold' || object.kind === 'circle'));
  assert.equal(map.objects.at(-1).kind, 'spinner');
});

test('converts a standard map to catch without changing its source geometry', () => {
  const source = parseMapPreviewData(standardMap);
  const map = convertMapForMode(source, 2);

  assert.equal(map.mode, 2);
  assert.equal(map.conversion.targetMode, 2);
  assert.deepEqual(map.objects.map((object) => object.x), source.objects.map((object) => object.x));
  assert.deepEqual(map.objects.map((object) => object.kind), ['circle', 'slider', 'spinner']);
});

test('converts standard objects to deterministic mania columns and holds', () => {
  const source = parseMapPreviewData(standardMap);
  const map = convertMapForMode(source, 3);

  assert.equal(map.mode, 3);
  assert.equal(map.circleSize, getManiaKeyCount(source));
  assert.ok(map.objects.every((object) => object.x >= 0 && object.x <= 512));
  assert.ok(map.objects.some((object) => object.kind === 'hold'));
  assert.equal(map.objects.at(-1).kind, 'hold');
  assert.deepEqual(
    map.objects.map((object) => object.x),
    convertMapForMode(source, 3).objects.map((object) => object.x),
  );
  assert.ok(map.objects.every((object) => Number.isInteger(object.column)));
  assert.equal(map.mania.stageCount, 1);
});

test('uses the official mania conversion seed inputs and separates same-time notes', () => {
  const source = parseMapPreviewData(standardMap.replace(
    '[Difficulty]',
    '[Difficulty]\nHPDrainRate:7',
  ).replace(
    '64,192,1000,1,5,0:0:0:0:',
    '64,192,1000,1,5,0:0:0:0:\n448,192,1000,1,4,0:0:0:0:',
  ));
  const map = convertMapForMode(source, 3);

  assert.equal(getManiaConversionSeed(source), 473);
  const sameTimeColumns = map.objects
    .filter((object) => object.time === 1000)
    .map((object) => object.column);
  assert.equal(new Set(sameTimeColumns).size, sameTimeColumns.length);
  assert.equal(map.conversion.randomSeed, 473);
});

test('converts taiko sliders to hits or drumrolls and spinners to swells', () => {
  const source = {
    mode: 0,
    overallDifficulty: 5,
    sliderMultiplier: 1.4,
    sliderTickRate: 1,
    timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, svMultiplier: 1 }],
    objects: [
      { kind: 'slider', x: 64, y: 192, time: 0, endTime: 100, slides: 1, length: 50, hitSound: 0 },
      { kind: 'slider', x: 64, y: 192, time: 500, endTime: 4500, slides: 2, length: 400, hitSound: 0 },
      { kind: 'spinner', x: 256, y: 192, time: 5000, endTime: 7000, hitSound: 0 },
    ],
  };
  const map = convertMapForMode(source, 1);

  assert.ok(map.objects.some((object) => object.taikoType === 'drumroll'));
  assert.ok(map.objects.some((object) => object.taikoType === 'swell'));
  assert.ok(map.objects.some((object) => object.taikoType === 'hit'));
  assert.equal(map.conversion.velocityMultiplier, 1.4);
});

test('materializes catch fruits, slider droplets, repeats, and banana showers', () => {
  const map = convertMapForMode(parseMapPreviewData(standardMap), 2);
  const types = new Set(map.catchObjects.map((object) => object.type));

  assert.ok(types.has('fruit'));
  assert.ok(types.has('droplet'));
  assert.ok(types.has('tinyDroplet'));
  assert.ok(types.has('banana'));
  assert.ok(map.catchObjects.every((object) => Number.isFinite(object.time)));
});

test('normalizes native mania columns and keeps unusual objects visible', () => {
  const native = parseMapPreviewData(standardMap.replace('Mode:0', 'Mode:3'));
  const result = convertMapForMode(native, 3);

  assert.equal(result.mode, 3);
  assert.equal(result.conversion, undefined);
  assert.ok(result.objects.every((object) => Number.isInteger(object.column)));
  assert.ok(result.objects.some((object) => object.kind === 'hold'));
});

test('does not convert an already-native non-standard map', () => {
  const native = parseMapPreviewData(standardMap.replace('Mode:0', 'Mode:3'));
  const result = convertMapForMode(native, 1);

  assert.equal(result.mode, 3);
  assert.equal(result.conversion, undefined);
});
