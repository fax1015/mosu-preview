import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapPreviewData } from '../src/parser.js';
import {
  convertMapForMode,
  getAutoManiaKeyCount,
  getManiaKeyCount,
} from '../src/core/beatmapConversion.js';
import { MANIA_KEY_COUNTS } from '../src/settings.js';

// Streams, jumps, a few sliders of different lengths and a spinner: enough for
// the converter to make chords, holds and split sliders.
const buildStandardMap = ({ mode = 0, circleSize = 4, overallDifficulty = 8 } = {}) => {
  const lines = [];
  for (let i = 0; i < 48; i += 1) {
    const x = (i * 97) % 512;
    const time = 1000 + (i * 125);
    // Every eighth note claps, which the converter turns into a two-note chord.
    lines.push(`${x},192,${time},1,${i % 8 === 0 ? 8 : 0},0:0:0:0:`);
  }
  lines.push('100,192,7200,2,0,B|300:192,1,200');
  lines.push('400,192,8000,2,0,L|200:192,2,120');
  lines.push('256,100,9000,2,0,P|300:50|350:100,1,90');
  lines.push('256,192,10000,12,0,11500,0:0:0:0:');
  return parseMapPreviewData(`
osu file format v14

[General]
Mode:${mode}

[Difficulty]
HPDrainRate:6
CircleSize:${circleSize}
OverallDifficulty:${overallDifficulty}
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,375,4,2,0,100,1,0

[HitObjects]
${lines.join('\n')}
`);
};

// Object lists for the column-count rule, which only reads kinds and counts.
const withRatio = (total, endTimeObjects, difficulty = {}) => ({
  mode: 0,
  circleSize: 4,
  overallDifficulty: 5,
  ...difficulty,
  objects: Array.from({ length: total }, (_, i) => ({ kind: i < endTimeObjects ? 'slider' : 'circle' })),
});

test('auto picks the column count osu!lazer gives a convert with no key mod', () => {
  assert.equal(getAutoManiaKeyCount(withRatio(10, 1)), 7, 'under 20% sliders and spinners');
  assert.equal(getAutoManiaKeyCount(withRatio(4, 1, { overallDifficulty: 6 })), 7);
  assert.equal(getAutoManiaKeyCount(withRatio(4, 1, { overallDifficulty: 5 })), 6);
  assert.equal(getAutoManiaKeyCount(withRatio(10, 4, { circleSize: 5, overallDifficulty: 3 })), 6, 'CS 5 and up');
  assert.equal(getAutoManiaKeyCount(withRatio(10, 7, { overallDifficulty: 5 })), 5, 'over 60%');
  assert.equal(getAutoManiaKeyCount(withRatio(10, 7, { overallDifficulty: 4 })), 4);
  assert.equal(getAutoManiaKeyCount(withRatio(10, 4, { overallDifficulty: 2 })), 4, 'OD + 1, at least 4');
  assert.equal(getAutoManiaKeyCount(withRatio(10, 4, { overallDifficulty: 5 })), 6);
  assert.equal(getAutoManiaKeyCount(withRatio(10, 4, { overallDifficulty: 9 })), 7, 'OD + 1, at most 7');
});

test('auto rounds the way .NET does, midpoint to even', () => {
  // CS 4.5 is 4 to lazer, so it misses the CS >= 5 branch (which would say 6).
  assert.equal(getAutoManiaKeyCount(withRatio(10, 4, { circleSize: 4.5, overallDifficulty: 3 })), 4);
  assert.equal(getAutoManiaKeyCount(withRatio(10, 4, { circleSize: 5.5, overallDifficulty: 3 })), 6);
  // OD 4.5 is 4, not over 4.
  assert.equal(getAutoManiaKeyCount(withRatio(10, 7, { overallDifficulty: 4.5 })), 4);
  assert.equal(getAutoManiaKeyCount(withRatio(10, 7, { overallDifficulty: 5.5 })), 5);
});

test('a map with no objects skips the ratio tests, as lazer does', () => {
  assert.equal(getAutoManiaKeyCount(withRatio(0, 0, { overallDifficulty: 2 })), 4);
  assert.equal(getAutoManiaKeyCount(withRatio(0, 0, { overallDifficulty: 5 })), 6);
  assert.equal(getAutoManiaKeyCount(withRatio(0, 0, { overallDifficulty: 9 })), 7);
});

test('a key mod sets the column count of a convert, from 1K to 10K', () => {
  const source = buildStandardMap();
  const autoKeys = getAutoManiaKeyCount(source);

  for (const keys of MANIA_KEY_COUNTS) {
    const map = convertMapForMode(source, 3, { maniaKeyCount: keys });
    assert.equal(map.mode, 3);
    assert.equal(map.mania.totalColumns, keys, `${keys}K`);
    assert.equal(map.mania.columnsPerStage, keys);
    assert.equal(map.circleSize, keys);
    assert.equal(map.conversion.keys, keys);
    assert.equal(map.conversion.keyMod, keys);
    assert.equal(map.conversion.autoKeys, autoKeys);
    assert.equal(getManiaKeyCount(source, { keyCount: keys }), keys);
    assert.ok(map.objects.length >= source.objects.length, `${keys}K keeps every object`);
    for (const object of map.objects) {
      assert.ok(Number.isInteger(object.column) && object.column >= 0 && object.column < keys, `${keys}K column`);
      assert.equal(object.x, ((object.column + 0.5) / keys) * 512);
    }
  }
});

test('1K puts everything in its one column, and 10K spreads across all ten', () => {
  const source = buildStandardMap();
  assert.ok(convertMapForMode(source, 3, { maniaKeyCount: 1 }).objects.every((object) => object.column === 0));
  const columns = new Set(convertMapForMode(source, 3, { maniaKeyCount: 10 }).objects.map((object) => object.column));
  assert.ok(columns.size >= 8, `10K used ${columns.size} columns`);
});

test('a key count moves notes between columns, never in time', () => {
  // Every key count still sounds every source object at its own time, so the
  // hitsounds and the timeline line up whichever count is picked.
  const source = buildStandardMap();
  const timesAt = (keys) => [...new Set(
    convertMapForMode(source, 3, { maniaKeyCount: keys }).objects.map((object) => object.time),
  )].sort((a, b) => a - b);
  const reference = timesAt(7);
  for (const keys of MANIA_KEY_COUNTS) {
    assert.deepEqual(timesAt(keys), reference, `${keys}K`);
  }
});

test('the same key count always converts to the same notes', () => {
  const source = buildStandardMap();
  assert.deepEqual(
    convertMapForMode(source, 3, { maniaKeyCount: 4 }).objects,
    convertMapForMode(source, 3, { maniaKeyCount: 4 }).objects,
  );
});

test('auto, and any count lazer has no key mod for, leave the converter its own choice', () => {
  const source = buildStandardMap();
  const auto = convertMapForMode(source, 3);
  assert.equal(auto.mania.totalColumns, getAutoManiaKeyCount(source));
  assert.equal(auto.conversion.keyMod, null);

  for (const value of ['auto', undefined, null, 0, 11, 4.5, '4', NaN]) {
    const map = convertMapForMode(source, 3, { maniaKeyCount: value });
    assert.equal(map.mania.totalColumns, auto.mania.totalColumns, String(value));
    assert.equal(map.conversion.keyMod, null, String(value));
    assert.deepEqual(map.objects, auto.objects, String(value));
  }
});

test('forcing the count auto would pick converts to the same notes as auto', () => {
  const source = buildStandardMap();
  const autoKeys = getAutoManiaKeyCount(source);
  assert.deepEqual(
    convertMapForMode(source, 3, { maniaKeyCount: autoKeys }).objects,
    convertMapForMode(source, 3).objects,
  );
});

test('a native mania map keeps its own key count whatever is forced', () => {
  // lazer's ManiaKeyMod returns early for maps made for mania.
  const native = buildStandardMap({ mode: 3, circleSize: 4 });
  const own = convertMapForMode(native, 3);
  assert.equal(own.mania.totalColumns, 4);
  assert.equal(own.conversion, undefined);

  for (const keys of [1, 7, 10]) {
    const forced = convertMapForMode(native, 3, { maniaKeyCount: keys });
    assert.equal(forced.mania.totalColumns, 4, `${keys}K`);
    assert.equal(getManiaKeyCount(native, { keyCount: keys }), 4);
    assert.deepEqual(forced.objects, own.objects);
  }

  const sevenKey = buildStandardMap({ mode: 3, circleSize: 7 });
  assert.equal(convertMapForMode(sevenKey, 3, { maniaKeyCount: 4 }).mania.totalColumns, 7);
});

test('the key count only reaches mania', () => {
  const source = buildStandardMap();
  for (const mode of [0, 1, 2]) {
    assert.deepEqual(
      convertMapForMode(source, mode, { maniaKeyCount: 4 }),
      convertMapForMode(source, mode),
      `mode ${mode}`,
    );
  }
});
