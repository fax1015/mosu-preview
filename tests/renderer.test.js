import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COLOURS,
  PreviewRenderer,
  assignComboIndices,
  applyPreviewStacking,
  getComboColour,
  getStandardPlayfieldLayout,
} from '../src/renderer.js';
import { parseMapPreviewData } from '../src/parser.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';

test('uses osu!lazer legacy default combo colours', () => {
  assert.deepEqual(DEFAULT_COLOURS, [
    { r: 255, g: 192, b: 0 },
    { r: 0, g: 202, b: 0 },
    { r: 18, g: 124, b: 255 },
    { r: 242, g: 24, b: 57 },
  ]);
});

test('uses Combo1 for the first combo and preserves color-haxed RGB values', () => {
  const colours = [
    { r: 1, g: 2, b: 3 },
    { r: 250, g: 251, b: 252 },
  ];

  assert.deepEqual(getComboColour(colours, { comboIndexWithOffsets: 1 }), colours[0]);
  assert.deepEqual(getComboColour(colours, { comboIndexWithOffsets: 2 }), colours[1]);
});

test('assigns 1-based combo indices and separate offset colour indices', () => {
  const objects = [
    { kind: 'circle', newCombo: false, comboSkip: 0 },
    { kind: 'circle', newCombo: false, comboSkip: 0 },
    { kind: 'circle', newCombo: true, comboSkip: 2 },
    { kind: 'circle', newCombo: false, comboSkip: 0 },
  ];

  assignComboIndices(objects, 0);

  assert.deepEqual(objects.map((object) => object.comboIndex), [1, 1, 2, 2]);
  assert.deepEqual(objects.map((object) => object.comboIndexWithOffsets), [1, 1, 4, 4]);
  assert.deepEqual(objects.map((object) => object.comboNumber), [1, 2, 1, 2]);
});

test('matches lazer stacking for chains, slider tails, and stack timing', () => {
  const chain = [
    { kind: 'circle', x: 100, y: 100, time: 1000, endTime: 1000 },
    { kind: 'circle', x: 100, y: 100, time: 1100, endTime: 1100 },
    { kind: 'circle', x: 100, y: 100, time: 1200, endTime: 1200 },
  ];
  applyPreviewStacking(chain, 5, 0.7, 14);
  assert.deepEqual(chain.map((object) => object.stackIndex), [2, 1, 0]);

  const sliderTail = [
    {
      kind: 'slider',
      x: 100,
      y: 100,
      time: 1000,
      endTime: 2000,
      length: 100,
      sliderCurveType: 'L',
      sliderPoints: [{ x: 200, y: 100 }],
    },
    { kind: 'circle', x: 200, y: 100, time: 2600, endTime: 2600 },
  ];
  applyPreviewStacking(sliderTail, 5, 0.7, 14);
  assert.deepEqual(sliderTail.map((object) => object.stackIndex), [0, -1]);

  const outsideWindow = [
    { kind: 'circle', x: 100, y: 100, time: 1000, endTime: 1000 },
    { kind: 'circle', x: 100, y: 100, time: 1900, endTime: 1900 },
  ];
  applyPreviewStacking(outsideWindow, 5, 0.7, 14);
  assert.deepEqual(outsideWindow.map((object) => object.stackIndex), [0, 0]);
});

test('retains lazer legacy stacking for pre-v6 beatmaps', () => {
  const objects = [
    { kind: 'circle', x: 100, y: 100, time: 1000, endTime: 1000 },
    { kind: 'circle', x: 100, y: 100, time: 1100, endTime: 1100 },
  ];
  applyPreviewStacking(objects, 5, 0.7, 5);
  assert.deepEqual(objects.map((object) => object.stackIndex), [1, 0]);
});

test('forces a new combo after a spinner without applying a spinner offset', () => {
  const objects = [
    { kind: 'circle', newCombo: false, comboSkip: 0 },
    { kind: 'spinner', newCombo: true, comboSkip: 7 },
    { kind: 'circle', newCombo: false, comboSkip: 0 },
  ];

  assignComboIndices(objects, 0);

  assert.deepEqual(objects.map((object) => object.comboIndex), [1, 1, 2]);
  assert.deepEqual(objects.map((object) => object.comboIndexWithOffsets), [1, 1, 2]);
});

test('does not let a first spinner consume a combo colour', () => {
  const objects = [
    { kind: 'spinner', newCombo: false, comboSkip: 0 },
    { kind: 'circle', newCombo: false, comboSkip: 0 },
  ];

  assignComboIndices(objects, 0);

  assert.deepEqual(objects.map((object) => object.comboIndex), [0, 1]);
  assert.deepEqual(objects.map((object) => object.comboIndexWithOffsets), [0, 1]);
});

test('standard playfield layout reserves scaled edge space for hit circles', () => {
  const layout = getStandardPlayfieldLayout(438, 328, 2);

  assert.ok(layout.scale > 0);
  assert.ok(layout.edgePadding > 0);
  assert.ok(layout.visualX >= 0);
  assert.ok(layout.visualY >= 0);
  assert.ok(layout.playfieldX - layout.edgePadding >= 0);
  assert.ok(layout.playfieldY - layout.edgePadding >= 0);
  assert.ok(layout.playfieldX + layout.playfieldWidth + layout.edgePadding <= 438);
  assert.ok(layout.playfieldY + layout.playfieldHeight + layout.edgePadding <= 328);
});

test('standard playfield edge padding shrinks with smaller object radius', () => {
  const lowCs = getStandardPlayfieldLayout(438, 328, 2);
  const highCs = getStandardPlayfieldLayout(438, 328, 7);

  assert.ok(lowCs.edgePadding > highCs.edgePadding);
  assert.ok(highCs.scale > lowCs.scale);
});

test('standard playfield gutter is exactly the scaled drawn circle radius', () => {
  const layout = getStandardPlayfieldLayout(438, 328, 5);

  assert.equal(layout.playfieldX - layout.visualX, layout.edgePadding);
  assert.equal(layout.playfieldY - layout.visualY, layout.edgePadding);
  assert.equal(layout.visualWidth, layout.playfieldWidth + (layout.edgePadding * 2));
  assert.equal(layout.visualHeight, layout.playfieldHeight + (layout.edgePadding * 2));
});

test('renders a fixed-time preview without dropping any ruleset', () => {
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, property) {
      if (!(property in target)) {
        target[property] = () => {};
      }
      return target[property];
    },
  });
  const canvas = {
    clientWidth: 512,
    clientHeight: 384,
    width: 512,
    height: 384,
    getContext: () => context,
  };
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };

  try {
    const source = parseMapPreviewData(`
osu file format v14

[Difficulty]
CircleSize:5
OverallDifficulty:6
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,1,5,0:0:0:0:
256,192,1500,2,2,B|356:192,2,300,2,
128,192,4000,8,4,5000
`);

    for (const mode of [0, 1, 2, 3]) {
      const map = convertMapForMode(source, mode);
      const renderer = new PreviewRenderer(canvas, canvas);
      renderer.setBeatmap(map, [], 7000);
      renderer.setTime(2000);
      assert.doesNotThrow(() => renderer.renderPlayfield(), `mode ${mode} should render`);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('stack offset scales with circle size, matching lazer StackOffset', () => {
  // osu!lazer: StackOffset = StackHeight * Scale * -6.4 with Scale = radius/64,
  // i.e. radius/10 per level. A fixed 3px made stacks too tight on low CS and
  // too loose on high CS.
  const makeChain = () => [
    { kind: 'circle', x: 100, y: 100, time: 1000, endTime: 1000 },
    { kind: 'circle', x: 100, y: 100, time: 1100, endTime: 1100 },
  ];

  const lowCs = makeChain();
  applyPreviewStacking(lowCs, 5, 0.7, 14, 2);
  assert.equal(Math.round(lowCs[0].stackOffsetUnit * 100) / 100, 4.54);

  const midCs = makeChain();
  applyPreviewStacking(midCs, 5, 0.7, 14, 5);
  assert.equal(Math.round(midCs[0].stackOffsetUnit * 100) / 100, 3.2);

  const highCs = makeChain();
  applyPreviewStacking(highCs, 5, 0.7, 14, 7);
  assert.equal(Math.round(highCs[0].stackOffsetUnit * 100) / 100, 2.3);

  // Stack heights themselves must not change with circle size.
  assert.deepEqual(lowCs.map((object) => object.stackIndex), highCs.map((object) => object.stackIndex));
});
