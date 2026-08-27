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

test('correctly handles colorhaxed first hitobject with newCombo and comboSkip', () => {
  const palette = [
    { r: 255, g: 0, b: 0 },   // Combo 1
    { r: 0, g: 255, b: 0 },   // Combo 2
    { r: 0, g: 0, b: 255 },   // Combo 3
    { r: 255, g: 255, b: 0 }, // Combo 4
  ];

  // First object marked newCombo + comboSkip 0 -> starts on Combo 2
  const toCombo2 = [{ kind: 'circle', newCombo: true, comboSkip: 0 }];
  assignComboIndices(toCombo2, 0);
  assert.equal(toCombo2[0].comboIndexWithOffsets, 2);
  assert.deepEqual(getComboColour(palette, toCombo2[0]), palette[1]);

  // First object marked newCombo + comboSkip 1 -> starts on Combo 3
  const toCombo3 = [{ kind: 'circle', newCombo: true, comboSkip: 1 }];
  assignComboIndices(toCombo3, 0);
  assert.equal(toCombo3[0].comboIndexWithOffsets, 3);
  assert.deepEqual(getComboColour(palette, toCombo3[0]), palette[2]);

  // First object marked newCombo + comboSkip 2 -> starts on Combo 4
  const toCombo4 = [{ kind: 'circle', newCombo: true, comboSkip: 2 }];
  assignComboIndices(toCombo4, 0);
  assert.equal(toCombo4[0].comboIndexWithOffsets, 4);
  assert.deepEqual(getComboColour(palette, toCombo4[0]), palette[3]);

  // First object marked newCombo + comboSkip 3 (Mapping Tools export for Combo 1) -> starts on Combo 1
  const toCombo1 = [{ kind: 'circle', newCombo: true, comboSkip: 3 }];
  assignComboIndices(toCombo1, 0);
  assert.equal(toCombo1[0].comboIndexWithOffsets, 5);
  assert.deepEqual(getComboColour(palette, toCombo1[0]), palette[0]);
});

test('correctly renders colorhax sequences with manual combo color overrides', () => {
  const palette = [
    { r: 255, g: 0, b: 0 },   // Combo 1
    { r: 0, g: 255, b: 0 },   // Combo 2
    { r: 0, g: 0, b: 255 },   // Combo 3
    { r: 255, g: 255, b: 0 }, // Combo 4
  ];

  // Sequence:
  // Note 1: Combo 1 (normal start)
  // Note 2: New combo, overridden to Combo 3 (skip 1)
  // Note 3: New combo, overridden to stay on Combo 3 (skip 3)
  // Note 4: New combo, overridden to Combo 2 (skip 2)
  // Note 5: Same combo as note 4 (Combo 2)
  const objects = [
    { kind: 'circle', newCombo: false, comboSkip: 0 },
    { kind: 'circle', newCombo: true, comboSkip: 1 },
    { kind: 'circle', newCombo: true, comboSkip: 3 },
    { kind: 'circle', newCombo: true, comboSkip: 2 },
    { kind: 'circle', newCombo: false, comboSkip: 0 },
  ];

  assignComboIndices(objects, 0);

  const colors = objects.map((obj) => getComboColour(palette, obj));
  assert.deepEqual(colors, [
    palette[0], // Combo 1
    palette[2], // Combo 3
    palette[2], // Combo 3
    palette[1], // Combo 2
    palette[1], // Combo 2
  ]);
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

// Stacking used to rebuild every slider's curve from its control points on each
// comparison, because the unstacked path deliberately skips the path cache and
// the stacking passes ask for it from nested loops. Caching the endpoint cut
// loading a 20k-object map from ~380ms to ~50ms. This pins the output so the
// cache cannot silently start returning something different.
const buildStackingFixture = () => {
  const NL = String.fromCharCode(10);
  const lines = [];
  for (let i = 0; i < 300; i += 1) {
    const time = 1000 + (i * 40);
    const x = 100 + ((i % 7) * 2);
    const y = 120 + ((i % 5) * 2);
    if (i % 4 === 3) {
      lines.push(`${x},${y},${time},2,0,B|${x + 40}:${y + 30}|${x + 80}:${y},1,90,0|0,0:0|0:0,0:0:0:0:`);
    } else if (i % 11 === 0) {
      lines.push(`256,192,${time},12,0,${time + 600},0:0:0:0:`);
    } else {
      lines.push(`${x},${y},${time},1,0,0:0:0:0:`);
    }
  }

  const osu = [
    'osu file format v14', '',
    '[General]', 'AudioFilename: a.mp3', 'Mode: 0', '',
    '[Difficulty]', 'CircleSize:4', 'ApproachRate:9', 'SliderMultiplier:1.4', 'SliderTickRate:1', '',
    '[TimingPoints]', '0,400,4,2,0,60,1,0', '',
    '[HitObjects]', ...lines,
  ].join(NL);

  const parsed = parseMapPreviewData(osu, { maxObjects: 40000 });
  return convertMapForMode({ ...parsed, breaks: [] }, 0);
};

const stackIndicesFor = (mapData) => {
  assignComboIndices(mapData.objects, 0);
  applyPreviewStacking(
    mapData.objects,
    mapData.approachRate,
    mapData.stackLeniency,
    mapData.beatmapVersion,
    mapData.circleSize,
  );
  return mapData.objects.map((object) => object.stackIndex || 0);
};

test('stacking a slider-heavy map produces the expected offsets', () => {
  const stackIndices = stackIndicesFor(buildStackingFixture());

  assert.equal(stackIndices.length, 300);
  assert.equal(stackIndices.filter((value) => value !== 0).length, 180);
  assert.deepEqual(stackIndices.slice(0, 20), [
    0, 3, 2, 1, 0, 1, 0, 2, 1, 0, 3, 2, 1, 0, 0, 1, 3, 2, 1, 0,
  ]);
});

test('stacking is stable when run again over the same objects', () => {
  // The endpoint cache lives for as long as the objects do, so a second pass has
  // to agree with the first rather than compounding the offsets it already set.
  const mapData = buildStackingFixture();
  const first = stackIndicesFor(mapData);
  const second = stackIndicesFor(mapData);

  assert.deepEqual(second, first);
});
