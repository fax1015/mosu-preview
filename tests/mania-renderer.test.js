import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewRenderer } from '../src/renderer.js';
import {
  buildManiaKeyPresses,
  generateManiaBarLines,
  getClosestBeatDivisor,
  getKeyState,
  getLaneColour,
  getLaneLight,
  getManiaLayout,
} from '../src/renderers/mania.js';

const close = (actual, expected, epsilon = 1e-6) => (
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not ${expected}`)
);

test('lanes share most of the preview\'s width, and four keys\' worth at the least', () => {
  // The popup's 4:3 preview.
  const fourKeys = getManiaLayout(410, 308, 4);
  close(fourKeys.laneWidth, (410 * 0.6) / 4);
  const stageLeft = fourKeys.columns[0].x;
  const stageRight = fourKeys.columns[3].x + fourKeys.columns[3].width;
  // Centred, to the nearest pixel.
  close((stageLeft + stageRight) / 2, 205, 0.5 + 1e-9);

  // Fewer keys keep 4K's lanes and leave the stage narrower.
  assert.equal(getManiaLayout(410, 308, 2).laneWidth, fourKeys.laneWidth);
  // More keys share the same width.
  close(getManiaLayout(410, 308, 7).laneWidth, (410 * 0.6) / 7);

  // A very wide canvas does not make lanes wider than a fifth of its height.
  assert.equal(getManiaLayout(2000, 300, 4).laneWidth, 60);
});

test('the judgement line sits where lazer\'s does, keys under it, and a time range covers the stage down to it', () => {
  const layout = getManiaLayout(410, 308, 4);
  assert.equal(layout.hitY, Math.round(308 * 0.82));
  assert.equal(layout.scrollLength, layout.hitY);
  assert.ok(layout.noteHeight >= 6 && layout.noteHeight <= layout.laneWidth * 0.45);
});

test('everything in a lane shares the same whole-pixel edges', () => {
  // Notes, hold bodies, the lane's light, the key's flash and its target line
  // are all drawn between these, so none sits half a pixel off another.
  for (const keys of [4, 7, 10]) {
    for (const column of getManiaLayout(410, 308, keys).columns) {
      assert.ok(Number.isInteger(column.x) && Number.isInteger(column.width), `${keys}K lane ${column.index}`);
      assert.ok(Number.isInteger(column.innerX) && Number.isInteger(column.innerWidth));
      assert.ok(column.innerX > column.x && column.innerX + column.innerWidth < column.x + column.width);
      // Inset the same on both sides, to a pixel.
      const left = column.innerX - column.x;
      const right = (column.x + column.width) - (column.innerX + column.innerWidth);
      assert.ok(Math.abs(left - right) <= 1, `${keys}K lane ${column.index}: ${left} vs ${right}`);
    }
  }
});

test('on a high-density screen the lane edges fall on whole device pixels', () => {
  // At 1.5x, a whole canvas pixel can land halfway across a device pixel,
  // where a rounded flash and a square line blur apart.
  for (const ratio of [1.25, 1.5, 2]) {
    const layout = getManiaLayout(410, 308, 7, 1, ratio);
    assert.equal(layout.pixelRatio, ratio);
    const onDevicePixel = (value) => Math.abs((value * ratio) - Math.round(value * ratio)) < 1e-9;
    for (const column of layout.columns) {
      assert.ok(onDevicePixel(column.x) && onDevicePixel(column.x + column.width), `${ratio}x lane ${column.index}`);
      assert.ok(onDevicePixel(column.innerX) && onDevicePixel(column.innerX + column.innerWidth));
    }
    assert.ok(onDevicePixel(layout.hitY));
  }
});

test('co-op stages sit side by side with a gap, and still fit', () => {
  const layout = getManiaLayout(410, 308, 18, 2);
  assert.equal(layout.stages.length, 2);
  const last = layout.columns.at(-1);
  assert.ok(layout.columns[0].x >= 0 && last.x + last.width <= 410 + 1e-9);
  assert.ok(layout.columns[9].x > layout.columns[8].x + layout.columns[8].width, 'a gap between the stages');
});

test('lanes are coloured from the middle out', () => {
  const pale = { r: 232, g: 210, b: 223 };
  const pink = { r: 205, g: 113, b: 160 };
  const middle = { r: 231, g: 211, b: 58 };
  assert.deepEqual([0, 1, 2, 3].map((column) => getLaneColour(column, 4)), [pale, pink, pink, pale]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((column) => getLaneColour(column, 7)),
    [pink, pale, pink, middle, pink, pale, pink]);
});

test('bar lines come every bar, major every fourth, as BarLineGenerator lays them', () => {
  const points = [{ time: 0, beatLength: 500, uninherited: true, meter: 4 }];
  const lines = generateManiaBarLines(points, 1000, 9000);
  assert.deepEqual(lines.map((line) => line.time), [0, 2000, 4000, 6000, 8000, 10000]);
  assert.deepEqual(lines.map((line) => line.major), [true, false, false, false, true, false]);

  const omitted = generateManiaBarLines([{ ...points[0], omitFirstBarLine: true }], 0, 5000);
  assert.equal(omitted[0].time, 2000);
});

test('autoplay holds each key 20ms, less before a quick repeat, and a hold to its end', () => {
  const objects = [
    { time: 1000, endTime: 1000, column: 0, kind: 'circle' },
    { time: 1010, endTime: 1010, column: 0, kind: 'circle' },
    { time: 1500, endTime: 2500, column: 1, kind: 'hold' },
    { time: 3000, endTime: 3000, column: 0, kind: 'circle' },
  ];
  const presses = buildManiaKeyPresses(objects, (object) => object.column, 2);
  close(presses[0].release[0], 1009);
  close(presses[0].release[1], 1030);
  close(presses[1].release[0], 2500);
  // Each note is one hit, and a hold note two: its head and its tail.
  assert.deepEqual(presses[0].hits, [1000, 1010, 3000]);
  assert.deepEqual(presses[1].hits, [1500, 2500]);

  // The lane lights while its key is down and dims once it is let go.
  assert.equal(getLaneLight(presses[1], 1400), 0);
  assert.ok(getLaneLight(presses[1], 1520) > 0.9);
  close(getLaneLight(presses[1], 2400), 0.5);
  assert.ok(getLaneLight(presses[1], 2900) < 0.01);
});

test('timing colours snap to the closest of lazer\'s divisors', () => {
  assert.equal(getClosestBeatDivisor(2000, 0, 500), 1);
  assert.equal(getClosestBeatDivisor(2250, 0, 500), 2);
  assert.equal(getClosestBeatDivisor(2125, 0, 500), 4);
  assert.equal(getClosestBeatDivisor(500 / 3, 0, 500), 3);
  assert.equal(getClosestBeatDivisor(500 / 12, 0, 500), 12);
  assert.equal(getClosestBeatDivisor(500 / 16, 0, 500), 16);
});

test('a note one time range away is at the top of the stage', () => {
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = {
    mode: 3,
    timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, meter: 4 }],
    primaryBpm: 120,
  };
  renderer.setPreviewSettings({ maniaScrollSpeed: 20 });
  const { scrollLength } = getManiaLayout(410, 308, 4);
  const timeRange = renderer.mania.getTimeRangeMs();
  // DrawableManiaRuleset.ComputeScrollTime: 11485 / speed.
  close(timeRange, Math.round(11485 / 20));
  close(renderer.mania.getScrollOffset(5000, 5000 + timeRange, scrollLength), scrollLength);
});

test('a key lights up on its press and fades back once let go', () => {
  const presses = buildManiaKeyPresses([{ time: 1000, endTime: 1000, column: 0, kind: 'circle' }], () => 0, 1);
  assert.deepEqual(getKeyState(presses[0], 900), { lit: 0, background: 0, flash: 0 });
  const pressed = getKeyState(presses[0], 1015);
  assert.ok(pressed.lit > 0.5 && pressed.background > 0.5 && pressed.flash > 0.5);
  const fading = getKeyState(presses[0], 1300);
  assert.ok(fading.lit < pressed.lit && fading.background < 0.3);
  const gone = getKeyState(presses[0], 3000);
  assert.ok(gone.lit < 0.001 && gone.background < 0.001);
});
