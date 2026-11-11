import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COLOURS,
  MAX_COMBO_WHITENESS,
  PreviewRenderer,
  assignComboIndices,
  applyPreviewStacking,
  getComboColour,
  getCircleRadius,
  getStandardPlayfieldLayout,
  normalizeComboColour,
} from '../src/renderer.js';
import { readFileSync } from 'node:fs';
import { parseMapPreviewData } from '../src/parser.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';
import { buildSliderCurvePoints } from '../src/core/sliderPath.js';
import { PANEL_ASPECT } from '../src/core/panelLayout.js';
import { POPUP_SIZE_PRESETS } from '../src/settings.js';

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

test('standard playfield shifts down so the top has more viewport clearance than the bottom', () => {
  const layout = getStandardPlayfieldLayout(438, 328, 2);
  const topGap = layout.visualY;
  const bottomGap = 328 - (layout.visualY + layout.visualHeight);

  assert.ok(layout.scale > 0);
  assert.ok(layout.edgePadding > 0);
  assert.ok(layout.visualX >= 0);
  assert.ok(layout.playfieldX - layout.edgePadding >= 0);
  assert.ok(layout.playfieldX + layout.playfieldWidth + layout.edgePadding <= 438);
  assert.ok(topGap > bottomGap, 'the lower border sits closer to or past the viewport edge');
});

test('standard playfield keeps horizontal fit and expands by the full CS radius', () => {
  const canvasWidth = 359;
  const canvasHeight = 280;
  const cs5 = getStandardPlayfieldLayout(canvasWidth, canvasHeight, 5);
  const highCs = getStandardPlayfieldLayout(canvasWidth, canvasHeight, 10);
  const centerX = highCs.playfieldX + (highCs.playfieldWidth / 2);
  const centerY = highCs.playfieldY + (highCs.playfieldHeight / 2);

  assert.ok(Math.abs(cs5.scale - (Math.min(canvasWidth / 640, canvasHeight / 480))) < 1e-6);
  assert.equal(cs5.scale, highCs.scale, 'CS does not change horizontal zoom');
  assert.equal(cs5.scaleY, cs5.scale, 'no vertical stretch');
  assert.equal(highCs.scaleY, highCs.scale);
  assert.ok(Math.abs(centerX - (canvasWidth / 2)) < 1e-6);
  assert.ok(Math.abs(centerY - ((canvasHeight / 2) + (8 * highCs.scaleY))) < 1e-6);
  assert.equal(cs5.edgePadding, getCircleRadius(5) * cs5.scale);
  assert.equal(highCs.edgePadding, getCircleRadius(10) * highCs.scale);
});

// The preview's height is set by one slider, and these two tests hold it there.
// Beatmap 5337582 (Aphex Twin - Cock/ver10 [7\]) at 2:50: a CS 5.1 loop around
// the outside of the playfield, the line below copied from the map as it is.
// Its body should lie just inside the preview, a few pixels clear of every
// edge. A taller preview leaves a band above and below it (1.29:1 left nearly
// ten pixels each way), a shorter one cuts it off. If one of these fails, the
// preview's proportions have moved: put them back rather than the numbers here.
// See .map-preview-canvas-wrap in popup.css and the README's "preview size".
const REFERENCE_SLIDER_MAP = `osu file format v14

[Difficulty]
CircleSize:5.1
SliderMultiplier:2.39999990463257
SliderTickRate:0.5

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
512,0,170804,6,0,B|544:0|544:0|544:392|544:392|-32:392|-32:392|-32:-24|-32:-24|544:-24,1,1992,0|4,2:0|2:0,2:0:0:0:
`;
// As far inside as the body may sit and still count as just fitting.
const REFERENCE_SLIDER_MAX_MARGIN_PX = 5;

const previewAspectFromCss = () => {
  const css = readFileSync(new URL('../popup.css', import.meta.url), 'utf8');
  const rule = css.match(/(?:^|\n)\.map-preview-canvas-wrap \{([^}]*)\}/);
  assert.ok(rule, 'the preview rule is in popup.css');
  const ratio = rule[1].match(/aspect-ratio:\s*([\d.]+)\s*\/\s*([\d.]+)/);
  assert.ok(ratio, 'the preview has an aspect-ratio');
  return Number(ratio[1]) / Number(ratio[2]);
};

test('the reference slider just fits the preview at every popup size', () => {
  const aspect = previewAspectFromCss();
  const map = parseMapPreviewData(REFERENCE_SLIDER_MAP);
  const [slider] = map.objects;
  const path = buildSliderCurvePoints(slider, { x: 0, y: 0 });
  const xs = path.map((point) => point.x);
  const ys = path.map((point) => point.y);
  // Read off the curve rather than written in, so the test follows the path
  // code: -32..544 across and -24..392 down.
  assert.deepEqual(
    [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(Math.round),
    [-32, 544, -24, 392],
  );

  // The popup's frame is its content width less 0.75rem of padding and a 1px
  // border each side; the canvas is that less the preview's own 1px border.
  const frameWidths = Object.values(POPUP_SIZE_PRESETS)
    .flatMap((preset) => [preset.contentWidth, preset.mobileContentWidth])
    .map((contentWidth) => contentWidth - 26);

  for (const frameWidth of frameWidths) {
    const canvasWidth = frameWidth - 2;
    const canvasHeight = (frameWidth / aspect) - 2;
    const layout = getStandardPlayfieldLayout(canvasWidth, canvasHeight, map.circleSize);
    // The outline's outer edge is the drawn hit circle's radius.
    const bodyRadius = Math.max(0.5, (getCircleRadius(map.circleSize) * layout.scale * 0.92) - 0.75);
    const toX = (x) => layout.playfieldX + (x * layout.scale);
    const toY = (y) => layout.playfieldY + (y * layout.scaleY);
    const margins = {
      left: toX(Math.min(...xs)) - bodyRadius,
      right: canvasWidth - (toX(Math.max(...xs)) + bodyRadius),
      top: toY(Math.min(...ys)) - bodyRadius,
      bottom: canvasHeight - (toY(Math.max(...ys)) + bodyRadius),
    };

    for (const [edge, margin] of Object.entries(margins)) {
      assert.ok(margin >= 0, `${frameWidth}px preview: the body runs ${(-margin).toFixed(1)}px past the ${edge}`);
      assert.ok(
        margin <= REFERENCE_SLIDER_MAX_MARGIN_PX,
        `${frameWidth}px preview: ${margin.toFixed(1)}px of room at the ${edge}, more than just fitting`,
      );
    }
  }
});

test('compare panels keep the single preview\'s proportions', () => {
  assert.ok(Math.abs(PANEL_ASPECT - previewAspectFromCss()) < 1e-9, `${PANEL_ASPECT} vs the preview's`);
});

test('standard playfield border expansion shrinks with smaller object radius', () => {
  const lowCs = getStandardPlayfieldLayout(438, 328, 2);
  const highCs = getStandardPlayfieldLayout(438, 328, 7);

  assert.ok(lowCs.edgePadding > highCs.edgePadding);
});

test('standard playfield border expands by the scaled CS circle radius', () => {
  const layout = getStandardPlayfieldLayout(438, 328, 5);

  assert.equal(layout.edgePadding, getCircleRadius(5) * layout.scale);
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
      renderer.setBeatmap(map, 7000);
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

test('catch hyperdash indicators are worked out once per map, not once per frame', () => {
  const context = new Proxy({}, {
    get(target, property) {
      if (!(property in target)) {
        target[property] = () => {};
      }
      return target[property];
    },
  });
  const canvas = {
    clientWidth: 512, clientHeight: 384, width: 512, height: 384, getContext: () => context,
  };
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };

  try {
    const source = parseMapPreviewData(`
osu file format v14

[Difficulty]
CircleSize:4

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
448,192,1100,1,0,0:0:0:0:
256,192,1500,2,0,B|356:192,1,100
`);
    const renderer = new PreviewRenderer(canvas, canvas);
    let passes = 0;
    const apply = renderer.applyCatchHyperDashIndicators.bind(renderer);
    renderer.applyCatchHyperDashIndicators = (...args) => {
      passes += 1;
      return apply(...args);
    };

    renderer.setBeatmap(convertMapForMode(source, 2), 3000);
    for (const time of [900, 1000, 1050, 1200]) {
      renderer.setTime(time);
      renderer.renderPlayfield();
    }
    assert.equal(passes, 1);

    renderer.setBeatmap(convertMapForMode(source, 2), 3000);
    renderer.renderPlayfield();
    assert.equal(passes, 2, 'a new map gets its own pass');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

// A slider at 1000ms with five spans of 500ms, so it reverses at 1500, 2000,
// 2500 and 3000, and at tick rate 2 drops one tick halfway along each span.
const REPEAT_SLIDER_MAP = `
osu file format v14

[Difficulty]
CircleSize:4
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:2

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,2,0,L|204:192,5,140
`;

// A renderer over a recording context, so a test can count what was drawn.
const withRepeatSlider = (run) => {
  const log = [];
  const context = new Proxy({}, {
    get(_target, property) {
      if (property === 'canvas') return canvas;
      if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (property === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...args) => { log.push({ call: property, args }); };
    },
    set(_target, property, value) {
      log.push({ set: property, value });
      return true;
    },
  });
  const canvas = {
    clientWidth: 512, clientHeight: 384, width: 512, height: 384, getContext: () => context,
  };
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };

  try {
    const map = convertMapForMode(parseMapPreviewData(REPEAT_SLIDER_MAP), 0);
    const renderer = new PreviewRenderer(canvas, canvas);
    renderer.setBeatmap(map, 5000);
    const drawAt = (timeMs) => {
      log.length = 0;
      renderer.setTime(timeMs);
      renderer.renderPlayfield();
    };
    const layout = getStandardPlayfieldLayout(512, 384, 4, 0);
    const toCanvasX = (x) => layout.playfieldX + ((x / 512) * layout.playfieldWidth);
    run({
      renderer,
      slider: map.objects[0],
      // drawReverseIndicator is the only path stroked with exactly two lineTo
      // calls: circles are arcs, and a linear slider body has one.
      reverseArrowsAt: (timeMs) => {
        drawAt(timeMs);
        let arrows = 0;
        let lineTos = 0;
        for (const entry of log) {
          if (entry.call === 'beginPath') lineTos = 0;
          else if (entry.call === 'lineTo') lineTos += 1;
          else if (entry.call === 'stroke' && lineTos === 2) arrows += 1;
        }
        return arrows;
      },
      // Every circle ends on its outline: one stroked arc at each end of the
      // path per circle drawn there.
      endCirclesAt: (timeMs) => {
        drawAt(timeMs);
        const circles = { atHead: 0, atTail: 0 };
        let arcX = null;
        for (const entry of log) {
          if (entry.call === 'beginPath') arcX = null;
          else if (entry.call === 'arc') [arcX] = entry.args;
          else if (entry.call === 'stroke' && arcX !== null) {
            if (Math.abs(arcX - toCanvasX(64)) < 1e-6) circles.atHead += 1;
            else if (Math.abs(arcX - toCanvasX(204)) < 1e-6) circles.atTail += 1;
          }
        }
        return circles;
      },
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
};

test('slider ticks come in along the slider, on lazer SliderTick preempts', () => {
  withRepeatSlider(({ renderer, slider }) => {
    assert.equal(slider.endTime, 3500);
    const ticks = renderer.buildStandardSliderTicks(slider);
    assert.deepEqual(ticks.map((tick) => tick.time), [1250, 1750, 2250, 2750, 3250]);

    // osu!lazer: half the tick's own way into its span, plus two thirds of the
    // approach on the first span and a flat 200ms on every one after it.
    assert.ok(Math.abs(ticks[0].preempt - (((1250 - 1000) / 2) + (600 * 0.66))) < 1e-6);
    for (const tick of ticks.slice(1)) {
      const spanStart = 1000 + (Math.floor((tick.time - 1000) / 500) * 500);
      assert.ok(Math.abs(tick.preempt - (((tick.time - spanStart) / 2) + 200)) < 1e-6);
    }

    // So they arrive one at a time rather than all with the slider body.
    const appears = ticks.map((tick) => tick.time - tick.preempt);
    for (let i = 1; i < appears.length; i += 1) {
      assert.ok(appears[i] > appears[i - 1], 'each tick waits for its own turn');
    }
    assert.ok(appears[0] > slider.time - 600, 'no tick is out before the slider itself');
  });
});

test('reverse arrows follow lazer SliderEndCircle preempts, not the approach rate', () => {
  withRepeatSlider(({ reverseArrowsAt }) => {
    // The first arrow fades in with the slider at 400ms; each later one shows
    // two spans ahead of its own reverse, so at 1000, 1500 and 2000. All of
    // them linger min(300, spanDuration) past the reverse itself.
    assert.equal(reverseArrowsAt(300), 0, 'nothing before the slider appears');
    assert.equal(reverseArrowsAt(450), 1, 'the first arrow is out with the slider');
    assert.equal(reverseArrowsAt(900), 1);
    assert.equal(reverseArrowsAt(1050), 2);
    assert.equal(reverseArrowsAt(1600), 3);
    assert.equal(reverseArrowsAt(2100), 3, 'never more than three at once');
    assert.equal(reverseArrowsAt(2600), 2);
    assert.equal(reverseArrowsAt(3200), 1, 'the last one lingers 300ms past its reverse at 3000');
  });
});

test('every reverse sits on an end circle, and the tail waits for its own turn', () => {
  withRepeatSlider(({ endCirclesAt }) => {
    // Reverses at 1500 (tail end), 2000 (head end), 2500 and 3000, then the
    // tail itself at 3500, which counts as a repeat and shows from 2500.
    assert.equal(endCirclesAt(900).atTail, 1, 'the first reverse alone, not the tail under it');
    assert.deepEqual(endCirclesAt(1300), { atHead: 1, atTail: 1 });
    assert.deepEqual(endCirclesAt(1600), { atHead: 1, atTail: 2 }, 'the next one is behind the one just hit');
    assert.deepEqual(endCirclesAt(2100), { atHead: 2, atTail: 1 });
    assert.deepEqual(endCirclesAt(2600), { atHead: 1, atTail: 2 }, 'the tail takes over from the last reverse there');
    assert.deepEqual(endCirclesAt(3400), { atHead: 0, atTail: 1 });
  });
});

test('turning slider end circles off leaves the reverse arrows on their own', () => {
  withRepeatSlider(({ renderer, reverseArrowsAt, endCirclesAt }) => {
    renderer.setPreviewSettings({ standardSliderEndCircles: false });
    assert.deepEqual(endCirclesAt(1300), { atHead: 0, atTail: 0 });
    assert.equal(reverseArrowsAt(1300), 2);
  });
});

test('a hit reverse stays where it was while the slider snakes away from it', () => {
  withRepeatSlider(({ renderer, endCirclesAt }) => {
    // The last reverse is at the head end at 3000, and the last span then
    // trims the path from that end.
    renderer.setPreviewSettings({ standardSliderSnakeOut: true });
    assert.equal(endCirclesAt(3100).atHead, 1);
  });
});

test('a near-white combo colour is pulled off white, and every other one is left alone', () => {
  // Every ordinary combo colour has a dark channel, so it goes through
  // untouched -- the four defaults among them.
  for (const colour of DEFAULT_COLOURS) {
    assert.deepEqual(normalizeComboColour(colour), colour);
  }
  assert.deepEqual(normalizeComboColour({ r: 18, g: 124, b: 255 }), { r: 18, g: 124, b: 255 });
  assert.deepEqual(
    normalizeComboColour({ r: MAX_COMBO_WHITENESS, g: 255, b: 220 }),
    { r: MAX_COMBO_WHITENESS, g: 255, b: 220 },
  );

  // White itself comes back as the cap, so the white border, the ball and the
  // combo number all have something left to read against.
  assert.deepEqual(
    normalizeComboColour({ r: 255, g: 255, b: 255 }),
    { r: MAX_COMBO_WHITENESS, g: MAX_COMBO_WHITENESS, b: MAX_COMBO_WHITENESS },
  );

  // A washed-out colour keeps its hue and its saturation: only the value drops.
  const washed = { r: 255, g: 230, b: 230 };
  const pale = normalizeComboColour(washed);
  const saturation = (c) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / Math.max(c.r, c.g, c.b);
  assert.equal(Math.min(pale.r, pale.g, pale.b), MAX_COMBO_WHITENESS);
  assert.ok(Math.abs(saturation(pale) - saturation(washed)) < 0.01, 'saturation holds');
  assert.ok(pale.r > pale.g && pale.g === pale.b, 'and so does the hue');

  assert.deepEqual(normalizeComboColour(undefined), { r: 0, g: 0, b: 0 });
});

test('a beatmap\'s white combo colour is normalized before anything is drawn with it', () => {
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = {
    clientWidth: 512, clientHeight: 384, width: 512, height: 384, getContext: () => context,
  };
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };

  try {
    const map = convertMapForMode(parseMapPreviewData(`
osu file format v14

[Difficulty]
CircleSize:4
ApproachRate:9
SliderMultiplier:1.4

[Colours]
Combo1 : 255,255,255
Combo2 : 18,124,255

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,2,0,L|304:192,1,240
`), 0);
    assert.deepEqual(map.comboColours[0], { r: 255, g: 255, b: 255 }, 'the map still says what it said');

    const renderer = new PreviewRenderer(canvas, canvas);
    renderer.setBeatmap(map, 5000);
    assert.deepEqual(renderer.comboColours, [
      { r: MAX_COMBO_WHITENESS, g: MAX_COMBO_WHITENESS, b: MAX_COMBO_WHITENESS },
      { r: 18, g: 124, b: 255 },
    ]);
    assert.deepEqual(
      getComboColour(renderer.comboColours, map.objects[0]),
      { r: MAX_COMBO_WHITENESS, g: MAX_COMBO_WHITENESS, b: MAX_COMBO_WHITENESS },
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('the standard field keeps its own proportions in any shape of canvas, centred in it', () => {
  // The preview's own shape, a wide one, a difficulty stacked in the popup,
  // one beside another in a tall window. A tall canvas used to stretch the
  // field to 1.9 times its height, a short one squash it a few percent.
  for (const [width, height] of [[359, 280], [438, 328], [355, 137], [377, 500], [1461, 104]]) {
    const layout = getStandardPlayfieldLayout(width, height, 4);
    assert.equal(layout.scaleY, layout.scale, `${width}x${height}`);
    assert.ok(Math.abs((layout.playfieldWidth / layout.playfieldHeight) - (512 / 384)) < 1e-9);
    assert.ok(layout.playfieldX >= 0 && layout.playfieldX + layout.playfieldWidth <= width);
    const viewportHeight = 480 * layout.scale;
    assert.ok(viewportHeight <= height + 1e-9, 'the 640x480 view fits the height');
  }
  const tall = getStandardPlayfieldLayout(377, 500, 4);
  assert.ok((500 - (480 * tall.scale)) / 2 > 50, 'a tall canvas leaves room above and below');
});

// --- picking an object out on the playfield --------------------------------
//
// osu!standard objects sit at a fixed place on the field for as long as they
// are on screen, which is what makes them something to click. The hit test
// runs against what the last frame drew, so these render first.

const createPlayfieldHarness = () => {
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, property) {
      if (!(property in target)) {
        target[property] = () => {};
      }
      return target[property];
    },
    set: () => true,
  });
  const canvas = {
    clientWidth: 512, clientHeight: 384, width: 512, height: 384, getContext: () => context,
  };
  const map = parseMapPreviewData(`
osu file format v14

[Difficulty]
CircleSize:4
ApproachRate:5
OverallDifficulty:5
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,96,1000,5,0,0:0:0:0:
256,192,1200,1,0,0:0:0:0:
448,288,1400,1,0,0:0:0:0:
`);
  const renderer = new PreviewRenderer(canvas, null);
  renderer.setBeatmap(map, 5000);
  return { renderer, map, canvas };
};

const withBrowserWindow = (run) => {
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
};

// Where an object's head is drawn, in the canvas's own pixels.
const pointFor = (renderer, object) => {
  const layout = getStandardPlayfieldLayout(512, 384, renderer.mapData.circleSize, 0);
  return {
    x: layout.playfieldX + (object.x * layout.scale),
    y: layout.playfieldY + (object.y * layout.scaleY),
  };
};

test('a click on a circle names that object', () => {
  withBrowserWindow(() => {
    const { renderer, map } = createPlayfieldHarness();
    // All three are on screen at once here: the last is inside its approach
    // time and the first has not faded out yet.
    renderer.setTime(1000);
    renderer.renderPlayfield();

    for (const [index, object] of map.objects.entries()) {
      const point = pointFor(renderer, object);
      assert.equal(renderer.objectIndexAtPoint(point.x, point.y), index, `object ${index}`);
    }
  });
});

test('a click on empty field names nothing', () => {
  withBrowserWindow(() => {
    const { renderer } = createPlayfieldHarness();
    renderer.setTime(1200);
    renderer.renderPlayfield();

    // The middle of the field, which this map deliberately leaves empty
    // between its three widely spaced circles.
    const layout = getStandardPlayfieldLayout(512, 384, 4, 0);
    const point = {
      x: layout.playfieldX + (160 * layout.scale),
      y: layout.playfieldY + (40 * layout.scaleY),
    };
    assert.equal(renderer.objectIndexAtPoint(point.x, point.y), -1);
  });
});

test('an object that has not appeared yet cannot be clicked', () => {
  withBrowserWindow(() => {
    const { renderer, map } = createPlayfieldHarness();
    const point = pointFor(renderer, map.objects[2]);

    // Before its approach circle: the object is laid out but nothing is drawn
    // there, so the field under the pointer is empty.
    renderer.setTime(0);
    renderer.renderPlayfield();
    assert.equal(renderer.objectIndexAtPoint(point.x, point.y), -1, 'before it appears');

    // Once it is showing, the same point names it.
    renderer.setTime(1000);
    renderer.renderPlayfield();
    assert.equal(renderer.objectIndexAtPoint(point.x, point.y), 2, 'while it is on screen');

    // And long after it is gone.
    renderer.setTime(4000);
    renderer.renderPlayfield();
    assert.equal(renderer.objectIndexAtPoint(point.x, point.y), -1, 'after it is gone');
  });
});

test('the other rulesets have no fixed place to click', () => {
  withBrowserWindow(() => {
    const { renderer, map } = createPlayfieldHarness();
    const point = pointFor(renderer, map.objects[1]);

    for (const mode of [1, 2, 3]) {
      const converted = convertMapForMode(map, mode);
      renderer.setBeatmap(converted, 5000);
      renderer.setTime(1200);
      renderer.renderPlayfield();
      assert.equal(renderer.objectIndexAtPoint(point.x, point.y), -1, `mode ${mode}`);
    }
  });
});

test('the selection is ringed on whichever playfield the timeline is showing', () => {
  // The lead owns the timeline; a compared difficulty's renderer is handed it.
  // The selection is indices into the timeline's objects, so it is ringed only
  // on the playfield drawing those objects.
  const circles = (count) => Array.from({ length: count }, (_, index) => ({
    kind: 'circle', x: 100 + (index * 50), y: 100, time: 1000 * (index + 1), endTime: 1000 * (index + 1),
  }));
  const leadMap = { mode: 0, objects: circles(3), timingControlPoints: [] };
  const panelMap = { mode: 0, objects: circles(3), timingControlPoints: [] };
  const lead = new PreviewRenderer({}, {});
  const panel = new PreviewRenderer({}, null, { selectionTimeline: lead.timeline });
  lead.setBeatmap(leadMap, 10000);
  panel.setBeatmap(panelMap, 10000);

  const rings = (renderer) => {
    let count = 0;
    const ctx = {
      save() {}, restore() {}, beginPath() {}, moveTo() {}, stroke() {}, arc() { count += 1; },
    };
    renderer.visibleObjectsScratch = [...renderer.mapData.objects];
    renderer.drawStandardSelection(ctx, (x, y) => ({ x, y }), 10);
    return count;
  };

  lead.timeline.setSelection([0, 2]);
  assert.equal(lead.showsTimelineObjects(), true);
  assert.equal(panel.showsTimelineObjects(), false);
  assert.equal(rings(lead), 2);
  assert.equal(rings(panel), 0, 'the indices are the lead\'s objects, not this one\'s');

  // The compared difficulty in focus: the timeline shows its objects.
  lead.showTimelineMap(panelMap);
  assert.equal(lead.showsTimelineObjects(), false, 'so a click on the lead picks nothing out');
  assert.equal(panel.showsTimelineObjects(), true);
  lead.timeline.setSelection([1]);
  assert.equal(rings(panel), 1);
  assert.equal(rings(lead), 0);

  // A new key count for the lead does not take the timeline back from it...
  lead.replaceManiaObjects({ ...leadMap, objects: circles(2) });
  assert.equal(lead.timeline.objects, panelMap.objects);

  // ...and once the lead is in focus again, it does reach the timeline.
  lead.showTimelineMap(lead.mapData);
  const reconverted = { ...leadMap, objects: circles(4) };
  lead.replaceManiaObjects(reconverted);
  assert.equal(lead.timeline.objects, reconverted.objects);
});
