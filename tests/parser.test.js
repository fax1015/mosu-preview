import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBreakPeriods, parseColours, parseMapPreviewData } from '../src/parser.js';

test('parses up to eight osu combo colours and ignores optional alpha', () => {
  const colours = parseColours(`
[Colours]
Combo1: 255, 192, 0, 12 // alpha is ignored for beatmap colours
Combo2: 0,202,0
Combo9: 255,0,0
combo3: 1,2,3
Combo3: 18,124,255
`);

  assert.deepEqual(colours, [
    { r: 255, g: 192, b: 0 },
    { r: 0, g: 202, b: 0 },
    { r: 18, g: 124, b: 255 },
  ]);
});

test('missing ApproachRate falls back to OverallDifficulty', () => {
  const map = parseMapPreviewData(`
osu file format v14

[Difficulty]
OverallDifficulty:8

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`);

  assert.equal(map.approachRate, 8);
});

test('parses HP drain and hit sample metadata', () => {
  const map = parseMapPreviewData(`
osu file format v14

[Difficulty]
HPDrainRate:7
OverallDifficulty:6

[HitObjects]
256,192,1000,1,5,2:3:4:80:hit.wav
256,192,1500,2,0,B|356:192,2,200,2|4,2:3|3:4,1:2:0:60:slider.wav
`);

  assert.equal(map.hpDrainRate, 7);
  assert.equal(map.objects[0].sampleSet, 2);
  assert.equal(map.objects[0].additionSet, 3);
  assert.equal(map.objects[0].customIndex, 4);
  assert.equal(map.objects[0].sampleVolume, 80);
  assert.equal(map.objects[0].sampleFilename, 'hit.wav');
  assert.deepEqual(map.objects[1].nodeSamples, [
    { normalSet: 2, additionSet: 3, edgeIndex: 0 },
    { normalSet: 3, additionSet: 4, edgeIndex: 1 },
  ]);
});

test('timing points are sorted before slider duration is calculated', () => {
  const map = parseMapPreviewData(`
osu file format v14

[Difficulty]
SliderMultiplier:1

[TimingPoints]
2000,1000,4,2,0,100,1,0
0,500,4,2,0,100,1,0

[HitObjects]
256,192,1000,2,0,B|356:192,1,100
`);

  assert.equal(map.objects[0].endTime, 1500);
  assert.deepEqual(map.timingControlPoints.map((tp) => tp.time), [0, 2000]);
});

test('mania hold endTime is parsed from hit object extras', () => {
  const map = parseMapPreviewData(`
osu file format v14

[General]
Mode:3

[HitObjects]
64,192,1000,128,0,1750:0:0:0:0:
`);

  assert.equal(map.objects[0].kind, 'hold');
  assert.equal(map.objects[0].endTime, 1750);
});

test('break periods are parsed from events', () => {
  const breaks = parseBreakPeriods(`
[Events]
//Break Periods
2,1000,2000
Break,3000,4500
`);

  assert.deepEqual(breaks, [
    { start: 1000, end: 2000 },
    { start: 3000, end: 4500 },
  ]);
});
