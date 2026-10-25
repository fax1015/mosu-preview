import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_VIEW_MS,
  TimelineRenderer,
  clampView,
  countObjectsIntoBins,
  formatTimelineTime,
  pickTickStep,
  zoomView,
} from '../src/timeline.js';

const WIDTH = 200;

// A canvas whose context swallows every call, so the timeline can draw in Node.
const createCanvas = () => {
  const context = new Proxy({}, {
    get: (target, property) => {
      if (!(property in target)) {
        target[property] = () => {};
      }
      return target[property];
    },
    set: () => true,
  });
  const canvas = {
    clientWidth: WIDTH,
    clientHeight: 22,
    width: WIDTH,
    height: 22,
    contextOptions: null,
    getContext: (type, options) => {
      canvas.contextOptions = options;
      return context;
    },
  };
  return canvas;
};

const withWindow = (run) => {
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    return run();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
};

// One object every 250ms across a minute, kiai from 20s to 30s, a break from
// 40s to 45s.
const createTimeline = ({ durationMs = 60000 } = {}) => {
  const timeline = new TimelineRenderer(createCanvas());
  const objects = [];
  for (let time = 0; time < durationMs; time += 250) {
    if (time >= 40000 && time < 45000) continue;
    objects.push({ kind: 'circle', time, endTime: time });
  }
  timeline.setBeatmap({
    objects,
    breaks: [{ start: 40000, end: 45000 }],
    timingControlPoints: [
      { time: 0, beatLength: 500, meter: 4, uninherited: true, kiai: false },
      { time: 20000, beatLength: -100, uninherited: false, kiai: true },
      { time: 30000, beatLength: -100, uninherited: false, kiai: false },
    ],
  }, durationMs, { previewTimeMs: 15000 });
  return timeline;
};

// Runs the timeline's frames until it settles, `frameMs` apart.
const settle = (timeline, { frames = 120, frameMs = 16, startAt = 1000 } = {}) => {
  let now = startAt;
  for (let frame = 0; frame < frames; frame += 1) {
    timeline.render(now);
    now += frameMs;
  }
  return now;
};

test('a view is kept inside the map and never narrower than the zoom limit', () => {
  assert.deepEqual(clampView(-500, 4000, 60000), { startMs: 0, durationMs: 4000 });
  assert.deepEqual(clampView(59000, 4000, 60000), { startMs: 56000, durationMs: 4000 });
  assert.deepEqual(clampView(1000, 10, 60000), { startMs: 1000, durationMs: MIN_VIEW_MS });
  assert.deepEqual(clampView(0, 10, 300), { startMs: 0, durationMs: 300 }, 'a map shorter than the limit fits whole');
});

test('zooming keeps the moment under the pointer where it was', () => {
  const view = { startMs: 10000, durationMs: 20000 };
  const anchorMs = 15000;
  const ratio = (anchorMs - view.startMs) / view.durationMs;
  const zoomed = zoomView(view, 60000, anchorMs, 0.5, ratio);
  assert.equal(zoomed.durationMs, 10000);
  assert.equal((anchorMs - zoomed.startMs) / zoomed.durationMs, ratio);
});

test('tick steps widen as the view zooms out and stay apart', () => {
  assert.equal(pickTickStep(1, 22), 50);
  assert.equal(pickTickStep(100, 22), 5000);
  assert.equal(pickTickStep(1000, 22), 30000);
  for (const msPerPx of [0.5, 3, 40, 700, 9000]) {
    assert.ok(pickTickStep(msPerPx, 22) / msPerPx >= 22, `${msPerPx}ms/px`);
  }
});

test('timeline times read as m:ss with as many decimals as asked for', () => {
  assert.equal(formatTimelineTime(0), '0:00');
  assert.equal(formatTimelineTime(102350), '1:42');
  assert.equal(formatTimelineTime(102350, 3), '1:42.350');
  assert.equal(formatTimelineTime(102200, 1), '1:42.2');
  assert.equal(formatTimelineTime(3725000), '62:05');
});

test('objects are counted into the bins they start in, only within the range', () => {
  const objects = [{ time: 0 }, { time: 400 }, { time: 999 }, { time: 1000 }, { time: 1500 }];
  const counts = countObjectsIntoBins(objects, 0, 1000, new Float32Array(4));
  assert.deepEqual([...counts], [1, 1, 0, 2]);
  assert.deepEqual([...countObjectsIntoBins(objects, 900, 200, new Float32Array(2))], [1, 1]);
});

test('kiai, breaks and the preview point are read from the map', () => {
  const timeline = createTimeline();
  assert.deepEqual(timeline.kiaiSections, [{ startMs: 20000, endMs: 30000 }]);
  assert.deepEqual(timeline.breaks, [{ startMs: 40000, endMs: 45000 }]);
  assert.equal(timeline.previewTimeMs, 15000);
  assert.deepEqual(timeline.timingSections, [{ time: 0, beatLength: 500, meter: 4 }]);
});

test('a wheel zoom eases in around its anchor and the rail comes in with it', () => withWindow(() => {
  const timeline = createTimeline();
  settle(timeline, { frames: 2 });
  const anchorX = WIDTH * 0.25;
  const anchorMs = timeline.timeAtX(anchorX);
  timeline.zoomAt(anchorMs, 0.1, 0.25);
  assert.equal(timeline.isZoomed(), true);
  assert.ok(timeline.needsAnimationFrame());

  settle(timeline);
  assert.equal(timeline.needsAnimationFrame(), false);
  assert.equal(timeline.overviewReveal, 1);
  assert.equal(Math.round(timeline.getView().durationMs), 6000);
  assert.ok(Math.abs(timeline.timeAtX(anchorX) - anchorMs) < 1, 'the anchor stays under the pointer');
  assert.equal(timeline.regionAt(21), 'overview');
  assert.equal(timeline.regionAt(5), 'track');

  timeline.resetZoom();
  settle(timeline);
  assert.equal(timeline.isZoomed(), false);
  assert.equal(timeline.overviewReveal, 0);
  assert.equal(timeline.regionAt(21), 'track');
}));

test('a zoomed view follows the playhead while it plays', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.setTime(10000);
  timeline.zoomAroundPlayhead(4000 / 60000);
  let now = settle(timeline);
  timeline.setPlaying(true);
  for (let time = 10000; time <= 20000; time += 16) {
    timeline.setTime(time);
    timeline.render(now);
    now += 16;
  }
  const { startMs, durationMs } = timeline.getView();
  const ratio = (20000 - startMs) / durationMs;
  assert.ok(Math.abs(ratio - 0.6) < 0.02, `playhead held at ${ratio.toFixed(3)} of the view`);
}));

test('looking elsewhere stops the follow, and a seek brings the view back', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.setTime(10000);
  timeline.zoomAroundPlayhead(4000 / 60000);
  let now = settle(timeline);
  timeline.setPlaying(true);

  timeline.panBy(20000);
  assert.equal(timeline.isFollowSuspended, true);
  for (let time = 10000; time <= 11000; time += 16) {
    timeline.setTime(time);
    timeline.render(now);
    now += 16;
  }
  assert.ok(timeline.getView().startMs > 25000, 'the view stays where the user put it');

  timeline.setTime(50000);
  assert.equal(timeline.isFollowSuspended, false, 'a jump in the clock is a seek');
  for (let frame = 0; frame < 60; frame += 1) {
    timeline.render(now);
    now += 16;
  }
  const { startMs, endMs } = timeline.getView();
  assert.ok(startMs <= 50000 && 50000 <= endMs, 'the playhead is back on screen');
}));

test('a paused seek off screen recentres the view, but not while dragging', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.setTime(10000);
  timeline.zoomAroundPlayhead(4000 / 60000);
  let now = settle(timeline);

  timeline.setInteracting(true);
  timeline.setTime(30000);
  timeline.render(now);
  now += 16;
  assert.ok(timeline.getView().endMs < 30000, 'a scrub owns the view');
  timeline.setInteracting(false);

  timeline.setTime(30010);
  now = settle(timeline, { startAt: now });
  const { startMs, durationMs } = timeline.getView();
  assert.ok(Math.abs(((30010 - startMs) / durationMs) - 0.5) < 0.01);
}));

test('the full track arriving grows an unzoomed timeline and keeps a zoomed one', () => withWindow(() => {
  const timeline = createTimeline();
  assert.equal(timeline.setDuration(90000, { animate: true }), true);
  assert.equal(timeline.isDurationAnimating(), true);

  const zoomed = createTimeline();
  zoomed.setView(10000, 5000, { animate: false });
  zoomed.setDuration(90000);
  assert.deepEqual(zoomed.getTargetView(), { startMs: 10000, durationMs: 5000, endMs: 15000 });
  zoomed.setDuration(4000);
  assert.equal(zoomed.isZoomed(), false, 'a view wider than the map is no longer a zoom');
}));

test('every zoom level draws without throwing', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.setTime(21000);
  let now = 1000;
  for (const durationMs of [60000, 20000, 8000, 2000, MIN_VIEW_MS]) {
    timeline.setView(20000, durationMs, { animate: false });
    assert.doesNotThrow(() => timeline.render(now), `${durationMs}ms view`);
    now += 16;
  }
}));

test('the end line marks the song once its length is known, the last object until then', () => {
  const timeline = createTimeline();
  assert.equal(timeline.getEndMs(), 59750, 'the last object, before the full track is in');
  timeline.setSongEnd(58000);
  assert.equal(timeline.getEndMs(), 58000);
  timeline.setSongEnd(90000);
  assert.equal(timeline.getEndMs(), 60000, 'never past the end of the timeline');
  timeline.setSongEnd(null);
  assert.equal(timeline.getEndMs(), 59750);

  const empty = new TimelineRenderer(createCanvas());
  empty.setBeatmap({ objects: [] }, 1000);
  assert.equal(empty.getEndMs(), null, 'nothing to mark on an empty map');
});

test('the timeline draws on a transparent canvas, so the capsule behind is its background', () => withWindow(() => {
  const timeline = createTimeline();
  timeline.render(1000);
  assert.equal(timeline.canvas.contextOptions?.alpha, true);
}));
