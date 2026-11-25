import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MINI_PALETTE,
  PALETTE_KEYS,
  buildMiniPalette,
  contrastRatio,
  extractCoverSeed,
  formatRgb,
  formatRgba,
  oklchToRgb,
  rgbToOklab,
} from '../src/core/coverPalette.js';

// RGBA pixel data filled with `count` copies of each [r, g, b] given.
const pixelsOf = (...runs) => {
  const values = [];
  for (const [[r, g, b], count] of runs) {
    for (let index = 0; index < count; index += 1) {
      values.push(r, g, b, 255);
    }
  }
  return Uint8ClampedArray.from(values);
};

const hueDistance = (a, b) => {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
};

test('rgbToOklab and oklchToRgb round-trip in-gamut colours', () => {
  for (const colour of [[140, 102, 255], [236, 233, 246], [36, 34, 42], [255, 180, 120]]) {
    const [l, a, b] = rgbToOklab(...colour);
    const chroma = Math.hypot(a, b);
    const hue = (Math.atan2(b, a) * 180) / Math.PI;
    const back = oklchToRgb(l, chroma, hue);
    colour.forEach((channel, index) => {
      assert.ok(Math.abs(back[index] - channel) <= 1, `${colour} came back as ${back}`);
    });
  }
});

test('oklchToRgb pulls out-of-gamut chroma back into sRGB', () => {
  const rgb = oklchToRgb(0.9, 0.4, 145);
  assert.equal(rgb.length, 3);
  for (const channel of rgb) {
    assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
  }
});

test('extractCoverSeed picks the dominant colourful hue', () => {
  // Mostly a sunset orange, some sky blue, lots of near-black.
  const pixels = pixelsOf(
    [[232, 128, 72], 120],
    [[70, 110, 200], 40],
    [[12, 10, 16], 200],
  );
  const seed = extractCoverSeed(pixels);
  assert.ok(seed);
  const [, a, b] = rgbToOklab(232, 128, 72);
  const orangeHue = (Math.atan2(b, a) * 180) / Math.PI;
  assert.ok(hueDistance(seed.hue, orangeHue) < 12, `seed hue ${seed.hue} is not orange (${orangeHue})`);
  assert.ok(seed.chroma > 0.08);
});

test('extractCoverSeed ignores greys, black and white', () => {
  assert.equal(extractCoverSeed(pixelsOf([[0, 0, 0], 50], [[255, 255, 255], 50], [[128, 128, 128], 50])), null);
});

test('extractCoverSeed needs a colour to cover a fair share of the art', () => {
  const pixels = pixelsOf([[200, 40, 60], 1], [[90, 90, 90], 400]);
  assert.equal(extractCoverSeed(pixels), null);
});

test('extractCoverSeed skips transparent pixels and rejects empty input', () => {
  assert.equal(extractCoverSeed(new Uint8ClampedArray(0)), null);
  assert.equal(extractCoverSeed(null), null);
  assert.equal(extractCoverSeed(Uint8ClampedArray.from([255, 0, 0, 0, 255, 0, 0, 0])), null);
});

test('buildMiniPalette falls back to the default palette without a usable seed', () => {
  assert.equal(buildMiniPalette(null), DEFAULT_MINI_PALETTE);
  assert.equal(buildMiniPalette({ hue: Number.NaN, chroma: 0.1 }), DEFAULT_MINI_PALETTE);
  assert.equal(buildMiniPalette({ hue: 20, chroma: 0 }), DEFAULT_MINI_PALETTE);
});

test('buildMiniPalette gives every role, readable on its background, for any hue', () => {
  for (let hue = 0; hue < 360; hue += 30) {
    for (const chroma of [0.04, 0.12, 0.3]) {
      const palette = buildMiniPalette({ hue, chroma });
      assert.deepEqual(Object.keys(palette).sort(), [...PALETTE_KEYS].sort());
      const label = `hue ${hue}, chroma ${chroma}`;
      assert.ok(contrastRatio(palette.onSurface, palette.surface) >= 7, `${label}: title`);
      assert.ok(contrastRatio(palette.onSurfaceVariant, palette.surface) >= 4.5, `${label}: artist`);
      assert.ok(contrastRatio(palette.onSurfaceVariant, palette.surfaceHigh) >= 4.5, `${label}: buttons`);
      assert.ok(
        contrastRatio(palette.onSecondaryContainer, palette.secondaryContainer) >= 4.5,
        `${label}: difficulty chip`,
      );
      assert.ok(
        contrastRatio(palette.onPrimaryContainer, palette.primaryContainer) >= 4.5,
        `${label}: follow toggle`,
      );
      assert.ok(contrastRatio(palette.onPlayContainer, palette.playContainer) >= 7, `${label}: play button`);
    }
  }
});

test('buildMiniPalette keeps the seed hue in its coloured roles', () => {
  const palette = buildMiniPalette({ hue: 40, chroma: 0.15 });
  const [, a, b] = rgbToOklab(...palette.primaryContainer);
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  assert.ok(hueDistance(hue, 40) < 8, `primary container hue ${hue}`);
});

test('the default palette is readable too', () => {
  const palette = DEFAULT_MINI_PALETTE;
  assert.ok(contrastRatio(palette.onSurface, palette.surface) >= 7);
  assert.ok(contrastRatio(palette.onSecondaryContainer, palette.secondaryContainer) >= 4.5);
  assert.ok(contrastRatio(palette.onPrimaryContainer, palette.primaryContainer) >= 4.5);
  assert.ok(contrastRatio(palette.onPlayContainer, palette.playContainer) >= 7);
});

test('formatRgb and formatRgba write CSS colours', () => {
  assert.equal(formatRgb([1, 2, 3]), 'rgb(1, 2, 3)');
  assert.equal(formatRgba([1, 2, 3], 0.25), 'rgba(1, 2, 3, 0.25)');
  assert.equal(formatRgba([1, 2, 3], 4), 'rgba(1, 2, 3, 1)');
});
