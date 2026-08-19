import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SLIDER_SLIDES,
  parseBreakPeriods,
  parseColours,
  parseMapPreviewData,
} from '../src/parser.js';

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

test('legacy timing points without an uninherited column use the beatLength sign', () => {
  // osu file format v4 and earlier omit the uninherited flag; a negative
  // beatLength marks an inherited slider-velocity multiplier.
  const map = parseMapPreviewData(`
osu file format v4

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0
1000,-50,4,2,0

[HitObjects]
100,100,1000,2,0,L|200:200,1,140
`);

  assert.deepEqual(map.timingControlPoints.map((tp) => tp.uninherited), [true, false]);
  assert.equal(map.timingControlPoints[1].svMultiplier, 2);
  // 140 units at SV x2 over a 500ms beat = 250ms, not the 500ms you get when
  // the inherited point is misread as uninherited.
  assert.equal(map.objects[0].endTime, 1250);
});

test('slider repeat count is clamped so a corrupt file cannot exhaust memory', () => {
  const map = parseMapPreviewData(`
osu file format v14

[Difficulty]
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
100,100,1000,2,0,L|200:200,999999999,140
`);

  assert.equal(map.objects[0].slides, MAX_SLIDER_SLIDES);
});

test('a truncated map still reports the full beatmap duration', () => {
  // Marathon maps exceed the object cap. Deriving the duration from the last
  // kept object left the rest of the map unreachable by the scrubber.
  const lines = [];
  for (let i = 0; i < 500; i += 1) {
    lines.push(`100,100,${1000 + (i * 1000)},1,0,0:0:0:0:`);
  }

  const map = parseMapPreviewData(`
osu file format v14

[Difficulty]
SliderMultiplier:1.4

[HitObjects]
${lines.join('\n')}
`, { maxObjects: 50 });

  assert.equal(map.objects.length, 50);
  assert.equal(map.renderedObjectCount, 50);
  assert.equal(map.hitObjectCount, 500);
  assert.equal(map.truncated, true);
  // Last object sits at 1000 + 499*1000 = 500000ms, not at the 50th object.
  assert.equal(map.maxObjectTime, 500000);
});

test('an untruncated map is not flagged as truncated', () => {
  const map = parseMapPreviewData(`
osu file format v14

[HitObjects]
100,100,1000,1,0,0:0:0:0:
100,100,2000,1,0,0:0:0:0:
`);

  assert.equal(map.truncated, false);
  assert.equal(map.hitObjectCount, 2);
  assert.equal(map.maxObjectTime, 2000);
});
