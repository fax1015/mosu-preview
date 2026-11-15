import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewRenderer } from '../src/renderer.js';
import { getTaikoUnit } from '../src/renderers/taiko.js';

const close = (actual, expected, epsilon = 1e-9) => (
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not ${expected}`)
);

test('the taiko lane is scaled by a 512x384 field fitted to the canvas', () => {
  // The popup's 4:3 preview is the field itself.
  close(getTaikoUnit(512, 384), 1);
  close(getTaikoUnit(410, 308), Math.min(410 / 512, 308 / 384));
  // A wide canvas is held to its height, a narrow one to its width.
  close(getTaikoUnit(1280, 384), 1);
  close(getTaikoUnit(203, 308), 203 / 512);
});

test('a difficulty in half the width scrolls in proportion, not at the full size', () => {
  // Two difficulties side by side share the preview's width. Notes should
  // cover the same share of each lane in the same time, so the half-width lane
  // scrolls at half the speed in pixels, with notes half the size.
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = {
    mode: 1,
    sliderMultiplier: 1.4,
    timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, meter: 4 }],
  };
  const full = renderer.taiko.getPixelsPerMs(1000, 512 * getTaikoUnit(410, 308));
  const half = renderer.taiko.getPixelsPerMs(1000, 512 * getTaikoUnit(203, 308));
  close(half / full, getTaikoUnit(203, 308) / getTaikoUnit(410, 308));
  assert.ok(half / full < 0.55, 'the half-width lane is not scrolled as if it were full size');
});
