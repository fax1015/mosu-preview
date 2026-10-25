import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_LINE_FADE_OUT_MS,
  FOLLOW_POINT_SPACING,
  getFollowLineAt,
  hasFollowPoints,
} from '../src/core/followPoints.js';
import { PreviewRenderer, getCircleRadius, getStandardPlayfieldLayout } from '../src/renderer.js';
import { parseMapPreviewData } from '../src/parser.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';

// AR 9: the object at 1000ms starts fading in at 400ms.
const ar9 = { endTimeMs: 1000, preemptMs: 600 };

test('follow points are skipped exactly where lazer lays none', () => {
  const lazerPointCount = (length) => {
    const distance = Math.trunc(length);
    let count = 0;
    for (let d = Math.trunc(FOLLOW_POINT_SPACING * 1.5); d < distance - FOLLOW_POINT_SPACING; d += FOLLOW_POINT_SPACING) {
      count += 1;
    }
    return count;
  };

  for (let length = 0; length <= 200; length += 0.25) {
    assert.equal(hasFollowPoints(length), lazerPointCount(length) > 0, `distance ${length}`);
  }
  assert.equal(hasFollowPoints(80.9), false);
  assert.equal(hasFollowPoints(81), true);
  assert.equal(hasFollowPoints(Number.NaN), false);
});

test('a follow line fades in after its object starts to, and out shortly after it is hit', () => {
  // The object starts fading in at 400ms; the line waits until 520ms.
  assert.equal(getFollowLineAt(400, ar9), null);
  assert.equal(getFollowLineAt(520, ar9), null);

  // Then fades in gently over 420ms, while shooting out hard.
  const early = getFollowLineAt(570, ar9);
  assert.ok(early.alpha > 0 && early.alpha < 0.05);
  assert.ok(early.extent > 0.5 && early.extent < 1);
  const halfway = getFollowLineAt(730, ar9);
  assert.equal(halfway.alpha, 0.5);
  assert.ok(halfway.extent > 0.999);
  assert.deepEqual(getFollowLineAt(940, ar9), { alpha: 1, extent: 1 });
  assert.deepEqual(getFollowLineAt(1000, ar9), { alpha: 1, extent: 1 });

  // From the hit, out over 120ms.
  assert.equal(FOLLOW_LINE_FADE_OUT_MS, 120);
  assert.ok(getFollowLineAt(1010, ar9).alpha > 0.95);
  assert.equal(getFollowLineAt(1060, ar9).alpha, 0.5);
  assert.ok(getFollowLineAt(1110, ar9).alpha < 0.05);
  assert.equal(getFollowLineAt(1120, ar9), null);
  assert.equal(getFollowLineAt(5000, ar9), null);
});

test('a follow line never pops in or out', () => {
  const cases = [
    ar9,
    { endTimeMs: 1000, preemptMs: 1200 }, // AR 5
    { endTimeMs: 1000, preemptMs: 300 }, // AR 11
  ];

  for (const connection of cases) {
    const label = JSON.stringify(connection);
    const stepMs = 0.25;
    // Smoothstep is at its steepest halfway, at 1.5 times a straight fade.
    const fadeInMs = connection.preemptMs * 0.7;
    const maxAlphaStep = ((1.5 * stepMs) / Math.min(fadeInMs, FOLLOW_LINE_FADE_OUT_MS)) + 1e-9;
    let previous = null;
    const firstMs = connection.endTimeMs - connection.preemptMs - 50;
    for (let timeMs = firstMs; timeMs <= connection.endTimeMs + 200; timeMs += stepMs) {
      const line = getFollowLineAt(timeMs, connection);
      const alpha = line ? line.alpha : 0;
      const previousAlpha = previous ? previous.alpha : 0;
      assert.ok(Math.abs(alpha - previousAlpha) <= maxAlphaStep, `${label} jumps at ${timeMs}ms`);
      if (line && previous) {
        assert.ok(line.extent >= previous.extent, `${label} shrinks at ${timeMs}ms`);
      }
      previous = line;
    }
  }
});

test('the follow line depends only on the time asked for', () => {
  const times = [];
  for (let timeMs = 300; timeMs <= 1100; timeMs += 7) times.push(timeMs);
  const forward = times.map((timeMs) => getFollowLineAt(timeMs, ar9));
  const scrubbed = [...times].reverse().map((timeMs) => getFollowLineAt(timeMs, ar9)).reverse();
  assert.deepEqual(scrubbed, forward);
});

// A slider from x 64 to x 164 (ending at 1357ms), a circle at x 448 at 1700ms,
// a spinner, then a circle in a new combo. AR 9: the circle at 1700ms starts
// fading in at 1100ms, and the line to it at 1220ms, fully in by 1640ms.
const SLIDER_SPINNER_MAP = `
osu file format v14

[Difficulty]
CircleSize:4
ApproachRate:9
SliderMultiplier:1.4

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,2,0,L|164:192,1,100
448,192,1700,1,0,0:0:0:0:
256,192,2400,12,0,3000
64,64,3400,1,0,0:0:0:0:
448,64,3700,5,0,0:0:0:0:
`;

// A renderer drawing into recording contexts, with a stand-in OffscreenCanvas
// so that follow lines land on a layer of their own.
const withRecordingRenderer = (run) => {
  const log = [];
  const recordingContext = (canvas) => new Proxy({}, {
    get(_target, property) {
      if (property === 'canvas') return canvas;
      if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (property === 'createLinearGradient') {
        return (...args) => {
          const gradient = {
            stops: [],
            addColorStop(offset, colour) {
              this.stops.push([offset, colour]);
            },
          };
          log.push({ canvas, call: property, args, gradient });
          return gradient;
        };
      }
      return (...args) => {
        log.push({ canvas, call: property, args });
      };
    },
    set(_target, property, value) {
      log.push({ canvas, set: property, value });
      return true;
    },
  });
  const layers = [];
  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.context = recordingContext(this);
      layers.push(this);
    }

    getContext() {
      return this.context;
    }
  }
  const playfield = { clientWidth: 512, clientHeight: 384, width: 512, height: 384 };
  const playfieldContext = recordingContext(playfield);
  playfield.getContext = () => playfieldContext;
  const previousWindow = globalThis.window;
  const previousOffscreenCanvas = globalThis.OffscreenCanvas;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;

  try {
    const renderer = new PreviewRenderer(playfield, playfield);
    renderer.setBeatmap(convertMapForMode(parseMapPreviewData(SLIDER_SPINNER_MAP), 0), 5000);
    const layout = getStandardPlayfieldLayout(512, 384, 4, 0);
    run({
      log,
      layers,
      layout,
      playfield,
      renderAt: (timeMs) => {
        log.length = 0;
        renderer.setTime(timeMs);
        renderer.renderPlayfield();
      },
      toCanvas: (x, y) => ({
        x: layout.playfieldX + ((x / 512) * layout.playfieldWidth),
        y: layout.playfieldY + ((y / 384) * layout.playfieldHeight),
      }),
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousOffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previousOffscreenCanvas;
  }
};

test('draws the follow line from a slider\'s end to the next object\'s centre', () => {
  withRecordingRenderer(({ log, layers, layout, renderAt, toCanvas }) => {
    renderAt(1660);
    const [lines] = layers;
    const drawn = log.filter((entry) => entry.canvas === lines);
    const close = (a, b) => Math.abs(a - b) < 1e-6;
    const sliderEnd = toCanvas(164, 192);
    const circle = toCanvas(448, 192);

    const moveTo = drawn.find((entry) => entry.call === 'moveTo');
    const lineTo = drawn.find((entry) => entry.call === 'lineTo');
    assert.ok(close(moveTo.args[0], sliderEnd.x) && close(moveTo.args[1], sliderEnd.y));
    assert.ok(close(lineTo.args[0], circle.x) && close(lineTo.args[1], circle.y));
    assert.equal(drawn.filter((entry) => entry.call === 'stroke').length, 1);

    // It trails off to nothing at the slider's end, over three circle radii,
    // easing in and out of the fade.
    const { args, gradient } = drawn.find((entry) => entry.call === 'createLinearGradient');
    const drawnRadius = Math.max(0.5, (getCircleRadius(4) * layout.scale * 0.92) - 0.75);
    assert.ok(close(args[0], sliderEnd.x) && close(args[1], sliderEnd.y));
    assert.ok(close(args[2], sliderEnd.x + (3 * drawnRadius)) && close(args[3], sliderEnd.y));
    const stops = gradient.stops.map(([offset, colour]) => [offset, Number(colour.match(/([\d.]+)\)$/)[1])]);
    const middle = Math.floor(stops.length / 2);
    assert.deepEqual(stops[0], [0, 0]);
    assert.deepEqual(stops[stops.length - 1], [1, 0.225]);
    assert.equal(stops[middle][0], 0.5);
    assert.ok(Math.abs(stops[middle][1] - 0.1125) < 0.001);
    for (let k = 1; k < stops.length; k += 1) {
      assert.ok(stops[k][0] > stops[k - 1][0] && stops[k][1] >= stops[k - 1][1]);
    }
    // Gentle at both ends: the first and last steps change less than the middle ones.
    const rise = (k) => stops[k][1] - stops[k - 1][1];
    assert.ok(rise(1) < rise(middle) && rise(stops.length - 1) < rise(middle));
    assert.ok(drawn.some((entry) => entry.set === 'strokeStyle' && entry.value === gradient));
  });
});

test('no follow line before it fades in, once it has faded out after the hit, around spinners or into a new combo', () => {
  withRecordingRenderer(({ log, layers, renderAt }) => {
    const strokes = () => log.filter((entry) => entry.canvas === layers[0] && entry.call === 'stroke').length;

    renderAt(1250);
    assert.equal(strokes(), 1, 'fading in, after the circle at 1700ms starts to');
    renderAt(1760);
    assert.equal(strokes(), 1, 'just after the hit, still going');
    const { gradient } = log.find((entry) => entry.call === 'createLinearGradient');
    const [offset, colour] = gradient.stops[gradient.stops.length - 1];
    assert.equal(offset, 1);
    assert.ok(Math.abs(Number(colour.match(/([\d.]+)\)$/)[1]) - 0.1125) < 0.001, colour);

    for (const timeMs of [1100, 1200, 1825, 2400, 2800, 3200, 3600, 3800, 4500]) {
      renderAt(timeMs);
      assert.equal(strokes(), 0, `no follow line at ${timeMs}ms`);
    }
  });
});

test('follow lines are cut away under the objects, then put down beneath them', () => {
  withRecordingRenderer(({ log, layers, playfield, renderAt }) => {
    const drawsOn = (canvas, call) => log.some((entry) => entry.canvas === canvas && entry.call === call);

    renderAt(1450);
    const [lines, objects] = layers;
    assert.equal(layers.length, 2);
    assert.ok(drawsOn(lines, 'stroke'), 'the follow line is drawn on its layer');
    assert.ok(drawsOn(objects, 'arc'), 'the objects are drawn on theirs');
    assert.ok(!drawsOn(playfield, 'arc'), 'and not straight onto the playfield');

    const cut = log.findIndex((entry) => (
      entry.canvas === lines && entry.call === 'drawImage' && entry.args[0] === objects
    ));
    assert.ok(cut > 0, 'the objects are cut out of the lines');
    const cutMode = log.slice(0, cut).reverse()
      .find((entry) => entry.canvas === lines && entry.set === 'globalCompositeOperation');
    assert.equal(cutMode.value, 'destination-out');
    assert.deepEqual(
      log.filter((entry) => entry.canvas === playfield && entry.call === 'drawImage').map((entry) => entry.args[0]),
      [lines, objects],
      'lines go down first, then the objects over them',
    );

    // With no follow line showing, the objects go straight onto the playfield.
    renderAt(2800);
    assert.ok(drawsOn(playfield, 'arc'));
    assert.ok(!drawsOn(playfield, 'drawImage'));
    assert.equal(layers.length, 2, 'the layers are made once');
  });
});
