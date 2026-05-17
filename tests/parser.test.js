import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBreakPeriods, parseMapPreviewData } from '../src/parser.js';

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
