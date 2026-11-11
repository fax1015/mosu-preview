// A .osu file is whatever its uploader typed. These are the numbers that used
// to hang the popup or run it out of memory, and the bounds that stop them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OBJECT_TIME_MS, parseMapPreviewData } from '../src/parser.js';
import { PreviewRenderer } from '../src/renderer.js';
import { convertMapForMode } from '../src/core/beatmapConversion.js';
import {
  buildSliderCurvePoints,
  measurePath,
  positionOnMeasuredPath,
  positionOnPathAtProgress,
} from '../src/core/sliderPath.js';
import { createMessageListener } from '../src/background.js';

const osu = ({
  difficulty = 'CircleSize:4\nSliderMultiplier:1.4\nSliderTickRate:1',
  timing = '0,500,4,2,0,100,1,0',
  objects = '256,192,1000,2,0,B|356:192,1,300',
} = {}) => `osu file format v14

[Difficulty]
${difficulty}

[TimingPoints]
${timing}

[HitObjects]
${objects}
`;

const within = (limitMs, run, what) => {
  const startedAt = performance.now();
  const result = run();
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < limitMs, `${what} took ${Math.round(elapsedMs)}ms`);
  return result;
};

test('slider multiplier and tick rate are held to the ranges osu! accepts', () => {
  const low = parseMapPreviewData(osu({ difficulty: 'SliderMultiplier:1e-12\nSliderTickRate:1e-9' }));
  assert.equal(low.sliderMultiplier, 0.4);
  assert.equal(low.sliderTickRate, 0.5);

  const high = parseMapPreviewData(osu({ difficulty: 'SliderMultiplier:1e9\nSliderTickRate:1e9' }));
  assert.equal(high.sliderMultiplier, 3.6);
  assert.equal(high.sliderTickRate, 8);

  // Ordinary values pass through untouched.
  const ordinary = parseMapPreviewData(osu({ difficulty: 'SliderMultiplier:1.8\nSliderTickRate:2' }));
  assert.equal(ordinary.sliderMultiplier, 1.8);
  assert.equal(ordinary.sliderTickRate, 2);
});

test('a tempo is held to 6-60000ms a beat, and a greenline is left alone', () => {
  const slow = parseMapPreviewData(osu({ timing: '0,1e12,4,2,0,100,1,0' }));
  assert.equal(slow.timingControlPoints[0].beatLength, 60000);
  // One 300px slider at this tempo used to end 68 years in.
  assert.ok(slow.maxObjectTime < 10 * 60 * 1000, `ends at ${slow.maxObjectTime}ms`);

  const fast = parseMapPreviewData(osu({ timing: '0,1e-9,4,2,0,100,1,0' }));
  assert.equal(fast.timingControlPoints[0].beatLength, 6);

  const inherited = parseMapPreviewData(osu({ timing: '0,500,4,2,0,100,1,0\n500,-50,4,2,0,100,0,0' }));
  assert.equal(inherited.timingControlPoints[1].beatLength, -50);
  assert.equal(inherited.timingControlPoints[1].svMultiplier, 2);
});

test('an object outside the 32-bit timeline is dropped, and one running past it ends there', () => {
  const map = parseMapPreviewData(osu({
    objects: [
      '64,192,1000,1,0',
      '64,192,99999999999999999999,1,0',
      '256,192,2000,12,0,99999999999999999999',
      '256,192,3000,2,0,L|356:192,1000,131072',
    ].join('\n'),
    timing: '0,60000,4,2,0,100,1,0',
    difficulty: 'SliderMultiplier:0.4',
  }));

  assert.deepEqual(map.objects.map((object) => object.time), [1000, 2000, 3000]);
  assert.equal(map.objects[1].endTime, MAX_OBJECT_TIME_MS);
  assert.equal(map.objects[2].endTime, MAX_OBJECT_TIME_MS);
  assert.equal(map.maxObjectTime, MAX_OBJECT_TIME_MS);
});

test('positions and slider lengths are held to the playfield osu! can address', () => {
  const [object] = parseMapPreviewData(osu({
    objects: '1e300,-1e300,1000,2,0,B|1e308:5|-1e308:7,1,1e300',
  })).objects;

  assert.equal(object.x, 131072);
  assert.equal(object.y, -131072);
  assert.equal(object.length, 131072);
  assert.deepEqual(object.sliderPoints, [{ x: 131072, y: 5 }, { x: -131072, y: 7 }]);
  assert.ok(Number.isFinite(object.endTime));
});

test('a slider cannot ask the renderer for more ticks than it will draw', () => {
  // Built by hand, past what the parser lets through: the renderer is the
  // last line, and a converter or a cached map can hand it anything.
  const slider = {
    kind: 'slider',
    x: 0,
    y: 192,
    time: 1000,
    endTime: 1000 + (1000 * 1000),
    slides: 1000,
    length: 1e15,
    sliderCurveType: 'L',
    sliderPoints: [{ x: 512, y: 192 }],
  };
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = {
    mode: 0,
    objects: [slider],
    sliderTickRate: 1e9,
    timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, meter: 4 }],
  };

  const ticks = within(2000, () => renderer.buildStandardSliderTicks(slider), 'laying the ticks');
  assert.ok(ticks.length > 0);
  assert.ok(ticks.length <= 20000, `${ticks.length} ticks`);
  assert.ok(ticks.every((tick) => Number.isFinite(tick.time)));
});

test('taiko bar lines end even where one bar cannot be told from the next', () => {
  const renderer = new PreviewRenderer({}, {});
  renderer.mapData = {
    mode: 1,
    timingControlPoints: [{ time: 0, beatLength: 500, uninherited: true, meter: 4 }],
  };

  // At 1e300ms adding one bar to the index no longer changes it, so a loop
  // that waits to pass the end of the window never does.
  const lines = within(2000, () => renderer.getTaikoMeasureLines(1e300, 1e300 + 8000), 'the bar lines');
  assert.ok(lines.length <= 4096, `${lines.length} bar lines in one frame`);
});

test('a measured path gives the same positions as walking it', () => {
  const path = buildSliderCurvePoints({
    kind: 'slider',
    x: 0,
    y: 0,
    length: 600,
    sliderCurveType: 'B',
    // A red anchor in the middle, so there is a repeated point to cross.
    sliderPoints: [{ x: 200, y: 300 }, { x: 300, y: 0 }, { x: 300, y: 0 }, { x: 500, y: 200 }],
  });
  const lengths = measurePath(path);

  for (const progress of [-1, 0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, 2, Number.NaN]) {
    const walked = positionOnPathAtProgress(path, progress);
    const measured = positionOnMeasuredPath(path, lengths, progress);
    assert.ok(Math.abs(walked.x - measured.x) < 1e-9, `x at ${progress}`);
    assert.ok(Math.abs(walked.y - measured.y) < 1e-9, `y at ${progress}`);
  }

  assert.deepEqual(positionOnMeasuredPath([], measurePath([]), 0.5), { x: 0, y: 0 });
  const single = [{ x: 3, y: 4 }];
  assert.equal(positionOnMeasuredPath(single, measurePath(single), 0.5), single[0]);
});

test('a slider of a hundred thousand anchors is drawn, roughly, rather than waited for', () => {
  const sliderPoints = Array.from({ length: 100000 }, (_, i) => ({ x: i % 512, y: (i * 7) % 384 }));
  const points = within(8000, () => buildSliderCurvePoints({
    kind: 'slider', x: 0, y: 0, length: 5000, sliderCurveType: 'B', sliderPoints,
  }), 'sampling the curve');

  assert.ok(points.length >= 2);
  assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test('catch converts a long anchor-dense slider without re-measuring it per droplet', () => {
  const anchors = Array.from({ length: 5000 }, (_, i) => `${i % 512}:${(i * 3) % 384}`).join('|');
  const source = parseMapPreviewData(osu({ objects: `0,0,1000,2,0,C|${anchors},1,100000` }));

  const map = within(5000, () => convertMapForMode(source, 2), 'the catch conversion');
  assert.ok(map.catchObjects.length > 100);
  assert.ok(map.catchObjects.every((object) => object.x >= 0 && object.x <= 512));
});

test('a spinner days long stops making bananas once the list is full', () => {
  const source = parseMapPreviewData(osu({ objects: '256,192,1000,12,0,2000000000' }));

  const map = within(1500, () => convertMapForMode(source, 2), 'the catch conversion');
  assert.ok(map.catchObjects.length <= 60000, `${map.catchObjects.length} catch objects`);
});

test('the worker answers through sendResponse and keeps the channel open', async () => {
  const listener = createMessageListener(async (message) => ({ ok: true, setId: message.setId }));

  const replies = [];
  const kept = listener({ type: 'extractFullAudio', setId: '42' }, {}, (reply) => replies.push(reply));
  // Literally true: that, not a returned promise, is what every browser honours.
  assert.equal(kept, true);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(replies, [{ ok: true, setId: '42' }]);
});

test('a failed extraction is still answered, as a failure', async () => {
  const listener = createMessageListener(async () => {
    throw new Error('mirror exploded');
  });

  const replies = [];
  assert.equal(listener({ type: 'extractFullAudio' }, {}, (reply) => replies.push(reply)), true);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(replies, [{ ok: false, error: 'mirror exploded' }]);
});

test('the worker leaves every other message for whoever it was meant for', () => {
  const listener = createMessageListener(async () => {
    throw new Error('should not be asked');
  });

  assert.equal(listener({ type: 'fullAudioDownloadProgress' }, {}, () => {}), false);
  assert.equal(listener(null, {}, () => {}), false);
});
