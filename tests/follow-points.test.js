import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_LINE_FADE_IN_MS,
  FOLLOW_LINE_FADE_OUT_MS,
  FOLLOW_LINE_PREEMPT_MS,
  FOLLOW_POINT_SPACING,
  followLineAlphaAt,
  getFollowLineAt,
  getFollowLinePreemptMs,
  hasFollowPoints,
} from '../src/core/followPoints.js';
import {
  FOLLOW_LINE_EDGE_RADII,
  FOLLOW_LINE_MAX_ALPHA,
  PreviewRenderer,
  getCircleRadius,
  getStandardPlayfieldLayout,
} from '../src/renderer.js';
import { parseMapPreviewData } from '../src/parser.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';

// A slider ending at 1000ms, the next object hit at 2000ms, 400 osu!px apart,
// on an AR 9 map. The band runs the whole way between the two centres, the
// objects drawn over it taking back the ends.
const gap = {
  startTimeMs: 1000,
  endTimeMs: 2000,
  objectPreemptMs: 600,
  distanceOsu: 400,
};
const NEAR = 0;
const FAR = 1;

// When the point at `fraction` of the way along is lazer's to draw: it appears
// a preempt before this, is solid from a fade after that until this, and is
// gone a fade later.
const momentOf = (fraction) => gap.startTimeMs + (fraction * (gap.endTimeMs - gap.startTimeMs));

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

test('the line\'s own preempt is lazer\'s 800ms, and only shortens past AR 10', () => {
  assert.equal(FOLLOW_LINE_PREEMPT_MS, 800);
  assert.equal(FOLLOW_LINE_FADE_IN_MS, 400);
  // Lazer fades out over the same 400ms; here the tail is deliberately short.
  assert.equal(FOLLOW_LINE_FADE_OUT_MS, 150);
  // The approach rate barely enters into it, where the objects' own fades
  // depend on little else: AR 5, 9 and 10 all give the full 800ms.
  assert.equal(getFollowLinePreemptMs(1200), 800);
  assert.equal(getFollowLinePreemptMs(600), 800);
  assert.equal(getFollowLinePreemptMs(450), 800);
  // Below OsuHitObject.PREEMPT_MIN it is cut back in proportion.
  assert.equal(getFollowLinePreemptMs(225), 400);
  assert.equal(getFollowLinePreemptMs(0), 0);
});

test('each point along the line keeps its own lazer fade times', () => {
  const alphaAt = (timeMs, fraction) => followLineAlphaAt(fraction, getFollowLineAt(timeMs, gap));

  for (const fraction of [0.2, 0.5, 0.9]) {
    const moment = momentOf(fraction);
    const label = `fraction ${fraction}`;

    // Nothing of it until a preempt before its moment, then in over a fade.
    assert.equal(alphaAt(moment - 801, fraction), 0, label);
    assert.ok(alphaAt(moment - 700, fraction) > 0, label);
    assert.ok(alphaAt(moment - 700, fraction) < 1, label);
    assert.equal(alphaAt(moment - 400, fraction), 1, label);

    // Solid until its own moment, then out over the shorter tail.
    assert.equal(alphaAt(moment - 100, fraction), 1, label);
    assert.equal(alphaAt(moment, fraction), 1, label);
    assert.ok(alphaAt(moment + 75, fraction) < 1, label);
    assert.ok(alphaAt(moment + 75, fraction) > 0, label);
    assert.equal(alphaAt(moment + 151, fraction), 0, label);
    // Where lazer would still have better than half of it left.
    assert.equal(alphaAt(moment + 200, fraction), 0, label);
  }
});

test('the band travels from the object behind to the one ahead', () => {
  // The first point appears a preempt before its own moment, which is well
  // before the object behind the line has even been hit.
  assert.equal(getFollowLineAt(momentOf(NEAR) - 800, gap), null);
  const appearing = getFollowLineAt(momentOf(NEAR) - 700, gap);
  assert.ok(appearing, 'the head of the band is out before the slider ends');
  // Centre to centre, not stopping short the way lazer's row of dots does.
  assert.equal(appearing.from, 0);
  assert.ok(appearing.to < 0.3, `expected only the near end, got ${appearing.to}`);
  assert.equal(appearing.from, NEAR);

  // By the time the object ahead is hit the band has reached it and the near
  // end has begun to go.
  const arriving = getFollowLineAt(gap.endTimeMs, gap);
  assert.equal(arriving.to, FAR);
  assert.ok(arriving.from > NEAR, `expected the near end to have left, got ${arriving.from}`);

  // The last point goes a fade out after its own moment, and nothing is left.
  assert.ok(getFollowLineAt(momentOf(FAR) + 149, gap));
  assert.equal(getFollowLineAt(momentOf(FAR) + 150, gap), null);

  // Neither end ever moves backwards.
  let previous = null;
  for (let timeMs = 0; timeMs <= 2500; timeMs += 0.5) {
    const line = getFollowLineAt(timeMs, gap);
    if (line && previous) {
      assert.ok(line.from >= previous.from - 1e-9, `near end goes back at ${timeMs}ms`);
      assert.ok(line.to >= previous.to - 1e-9, `far end goes back at ${timeMs}ms`);
    }
    previous = line;
  }
});

// How much of the line is inked in at `timeMs`: the opacity integrated along
// the visible band. A line that popped in or out would step this.
const inkAt = (timeMs, connection) => {
  const line = getFollowLineAt(timeMs, connection);
  if (!line) {
    return 0;
  }

  const steps = 256;
  let total = 0;
  for (let k = 0; k <= steps; k += 1) {
    total += followLineAlphaAt(line.from + ((line.to - line.from) * (k / steps)), line);
  }
  return (total / (steps + 1)) * (line.to - line.from);
};

test('a follow line never pops in or out', () => {
  const cases = [
    gap,
    { ...gap, objectPreemptMs: 1200 }, // AR 5
    { ...gap, objectPreemptMs: 300 }, // AR 11
    { ...gap, endTimeMs: 1120 }, // a 1/4 at 125 BPM
    { ...gap, endTimeMs: 5000, distanceOsu: 120 }, // a long, close-set gap
  ];

  for (const connection of cases) {
    const label = JSON.stringify(connection);
    const stepMs = 0.25;
    let previous = 0;
    for (
      let timeMs = connection.startTimeMs - FOLLOW_LINE_PREEMPT_MS - 50;
      timeMs <= connection.endTimeMs + FOLLOW_LINE_FADE_IN_MS + 50;
      timeMs += stepMs
    ) {
      const ink = inkAt(timeMs, connection);
      assert.ok(Math.abs(ink - previous) <= 0.01, `${label} jumps at ${timeMs}ms`);
      previous = ink;
    }
    assert.equal(previous, 0, `${label} is still showing at the end`);
  }
});

test('objects that overlap share one moment rather than dividing by no gap', () => {
  // A slider that runs past the object after it leaves no gap to travel over,
  // so the whole line comes in and goes again together.
  const overlap = { ...gap, startTimeMs: 2000, endTimeMs: 2000 };
  assert.equal(getFollowLineAt(1199, overlap), null);

  const whole = getFollowLineAt(1800, overlap);
  assert.equal(whole.from, NEAR);
  assert.equal(whole.to, FAR);
  assert.equal(followLineAlphaAt(NEAR + 0.01, whole), followLineAlphaAt(FAR - 0.01, whole));
  assert.equal(followLineAlphaAt(0.5, whole), 1);

  assert.ok(followLineAlphaAt(0.5, getFollowLineAt(2075, overlap)) < 1);
  assert.equal(getFollowLineAt(2200, overlap), null);
  assert.equal(getFollowLineAt(2400, overlap), null);
});

test('the follow line depends only on the time asked for', () => {
  const times = [];
  for (let timeMs = 0; timeMs <= 2500; timeMs += 7) times.push(timeMs);
  const forward = times.map((timeMs) => getFollowLineAt(timeMs, gap));
  const scrubbed = [...times].reverse().map((timeMs) => getFollowLineAt(timeMs, gap)).reverse();
  assert.deepEqual(scrubbed, forward);
});

// A slider from x 64 to x 164 (ending at 1357ms), a circle at x 448 at 1700ms,
// a spinner, then a circle in a new combo. AR 9: the band between the slider
// and the circle is 284px long, so it runs from ~557ms to ~1850ms.
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

const SLIDER_TO_CIRCLE = {
  startTimeMs: 1357,
  endTimeMs: 1700,
  objectPreemptMs: 600,
  distanceOsu: 284,
};

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

test('draws the band between a slider\'s end and the next object\'s centre', () => {
  withRecordingRenderer(({
    log, layers, layout, renderAt, toCanvas,
  }) => {
    const timeMs = 1250;
    renderAt(timeMs);
    const [lines] = layers;
    const drawn = log.filter((entry) => entry.canvas === lines);
    const close = (a, b) => Math.abs(a - b) < 1e-6;

    const line = getFollowLineAt(timeMs, SLIDER_TO_CIRCLE);
    const sliderEnd = toCanvas(164, 192);
    const circle = toCanvas(448, 192);
    const along = (fraction) => ({
      x: sliderEnd.x + ((circle.x - sliderEnd.x) * fraction),
      y: sliderEnd.y + ((circle.y - sliderEnd.y) * fraction),
    });
    const head = along(line.from);
    const tail = along(line.to);

    // The band runs centre to centre: the slider's end and the circle's own
    // middle, both of which the objects drawn over it take back.
    assert.equal(line.from, 0);
    assert.equal(line.to, 1);
    const moveTo = drawn.find((entry) => entry.call === 'moveTo');
    const lineTo = drawn.find((entry) => entry.call === 'lineTo');
    assert.ok(close(moveTo.args[0], head.x) && close(moveTo.args[1], head.y));
    assert.ok(close(lineTo.args[0], tail.x) && close(lineTo.args[1], tail.y));
    assert.equal(drawn.filter((entry) => entry.call === 'stroke').length, 1);

    // The gradient spans exactly the band, and its stops are the band's own
    // opacity at that fraction of the way along it. Here the fade has reached
    // neither end, so both are the point row's own edge and both trail off
    // over a short run of circle radii rather than stopping hard.
    const { args, gradient } = drawn.find((entry) => entry.call === 'createLinearGradient');
    assert.ok(close(args[0], head.x) && close(args[1], head.y));
    assert.ok(close(args[2], tail.x) && close(args[3], tail.y));

    const drawnRadius = Math.max(0.5, (getCircleRadius(4) * layout.scale * 0.92) - 0.75);
    const bandLength = Math.hypot(tail.x - head.x, tail.y - head.y);
    const edge = Math.min((drawnRadius * FOLLOW_LINE_EDGE_RADII) / bandLength, 0.5);
    const smoothstep = (t) => t * t * (3 - (2 * t));
    const stops = gradient.stops.map(([offset, colour]) => [offset, Number(colour.match(/([\d.]+)\)$/)[1])]);

    assert.ok(line.fromCut && line.toCut);

    for (const [offset, alpha] of stops) {
      const fraction = line.from + ((line.to - line.from) * offset);
      const edgeFade = smoothstep(Math.min(offset / edge, 1))
        * smoothstep(Math.min((1 - offset) / edge, 1));
      const expected = FOLLOW_LINE_MAX_ALPHA * edgeFade * followLineAlphaAt(fraction, line);
      assert.ok(
        Math.abs(alpha - expected) < 0.001,
        `stop at ${offset} was ${alpha}, expected ${expected}`,
      );
    }

    // Both ends really do reach nothing, and the middle is brighter than both.
    assert.deepEqual(stops[0], [0, 0]);
    assert.deepEqual(stops[stops.length - 1], [1, 0]);
    const middle = stops[Math.floor(stops.length / 2)];
    assert.ok(middle[1] > stops[1][1] && middle[1] > stops[stops.length - 2][1]);
    assert.ok(drawn.some((entry) => entry.set === 'strokeStyle' && entry.value === gradient));
  });
});

test('the end the fade has swept to is left to the fade, not trailed off again', () => {
  withRecordingRenderer(({ log, layers, renderAt }) => {
    const stopsAt = (timeMs) => {
      renderAt(timeMs);
      const { gradient } = log
        .filter((entry) => entry.canvas === layers[0] && entry.call === 'createLinearGradient')
        .at(-1);
      return gradient.stops.map(([offset, colour]) => [offset, Number(colour.match(/([\d.]+)\)$/)[1])]);
    };

    // Sweeping in: the head of the band is still on the slider, so that end is
    // an object's own centre and trails off, while the far end is where the
    // fade itself has got to.
    const sweepingIn = getFollowLineAt(800, SLIDER_TO_CIRCLE);
    assert.ok(sweepingIn.fromCut && !sweepingIn.toCut);

    // Sweeping out: the circle has been hit and the band is leaving, so now it
    // is the near end that the fade has swept past and the far end that is cut.
    const sweepingOut = getFollowLineAt(1800, SLIDER_TO_CIRCLE);
    assert.ok(!sweepingOut.fromCut && sweepingOut.toCut);

    // Either way both ends of the drawn gradient reach nothing, so the band
    // never starts or stops on a hard edge.
    for (const timeMs of [800, 1250, 1800]) {
      const stops = stopsAt(timeMs);
      assert.equal(stops[0][1], 0, `head is soft at ${timeMs}ms`);
      assert.equal(stops.at(-1)[1], 0, `tail is soft at ${timeMs}ms`);
    }

    // The untrailed end gets its shape from the fade alone: close to it the
    // band is dimmer than the trail the other end is given,
    // measured at the matching distance in from each.
    const edgeStops = 3;
    const inward = stopsAt(800).slice(1, 1 + edgeStops).map(([, alpha]) => alpha);
    const outward = stopsAt(800).slice(-1 - edgeStops, -1).reverse().map(([, alpha]) => alpha);
    assert.ok(
      outward.every((alpha, i) => alpha < inward[i]),
      `the swept end ${outward} should rise more slowly than the cut end ${inward}`,
    );
  });
});

test('the band is out well before the slider ends, and gone well after the hit', () => {
  withRecordingRenderer(({ log, layers, renderAt }) => {
    const strokes = () => log.filter((entry) => entry.canvas === layers[0] && entry.call === 'stroke').length;

    // The slider is not hit until 1000ms and does not end until 1357ms, but
    // the head of the band is already on its way out.
    renderAt(700);
    assert.equal(strokes(), 1, 'the band has left the slider before it is hit');
    renderAt(1250);
    assert.equal(strokes(), 1, 'still travelling');
    renderAt(1800);
    assert.equal(strokes(), 1, 'the tail is still going after the circle is hit');
    renderAt(1870);
    assert.equal(strokes(), 0, 'but not for long: lazer would keep it to 2100ms');

    for (const timeMs of [0, 500, 540, 2150, 2400, 2800, 3200, 3600, 3800, 4500]) {
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
