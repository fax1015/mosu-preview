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

test('a re-converted map swaps its objects without losing the zoom or the song end', () => withWindow(() => {
  // A mania key count change: the same map, new notes, the playhead unmoved.
  const timeline = createTimeline();
  timeline.setSongEnd(58000);
  timeline.zoomAt(15000, 0.1, 0.5);
  settle(timeline);
  const view = timeline.getView();

  const objects = [
    { kind: 'circle', time: 1000, endTime: 1000, column: 0 },
    { kind: 'hold', time: 2000, endTime: 9000, column: 3 },
  ];
  timeline.setObjects(objects);

  assert.equal(timeline.isZoomed(), true);
  assert.deepEqual(timeline.getView(), view);
  assert.equal(timeline.getEndMs(), 58000);
  assert.equal(timeline.durationMs, 60000);
  assert.equal(timeline.objects, objects);
  assert.equal(timeline.maxObjectDurationMs, 7000, 'the longest object is the new hold');
  assert.equal(timeline.fullDensity, null, 'density is counted again from the new notes');
}));

// --- the ticks along the top edge ------------------------------------------
//
// They are the boldest thing on that edge, so where they sit is read as the
// scale. Zoomed out that can only be the clock; zoomed in it has to be the
// map's own bars, because seconds and downbeats almost never coincide and a
// ruler sitting visibly off the notes under it reads as a bug.

const TICK_H = 3;

// Records what was painted, so a test can ask where the ticks landed.
const createRecordingCanvas = () => {
  const rects = [];
  const arcs = [];
  const state = { globalAlpha: 1 };
  const context = new Proxy({}, {
    get: (target, property) => {
      if (property === 'fillRect') {
        return (x, y, w, h) => rects.push({
          x, y, w, h, alpha: state.globalAlpha,
        });
      }
      if (property === 'arc') {
        return (x, y, r) => arcs.push({
          x, y, r, stroke: state.strokeStyle, alpha: state.globalAlpha,
        });
      }
      if (property in state) {
        return state[property];
      }
      if (!(property in target)) {
        target[property] = () => {};
      }
      return target[property];
    },
    set: (target, property, value) => {
      state[property] = value;
      return true;
    },
  });
  const canvas = {
    clientWidth: WIDTH, clientHeight: 22, width: WIDTH, height: 22, getContext: () => context,
  };
  return { canvas, rects, arcs };
};

// 120 BPM in 4/4 -- a bar every 2000ms -- offset 137ms, so no bar can ever
// land on a round second.
const OFFSET_MS = 137;
const BAR_MS = 2000;

const createOffsetTimeline = (canvas) => {
  const timeline = new TimelineRenderer(canvas);
  const objects = [];
  for (let time = OFFSET_MS; time < 60000; time += 500) {
    objects.push({ kind: 'circle', time, endTime: time });
  }
  timeline.setBeatmap({
    objects,
    timingControlPoints: [{ time: OFFSET_MS, beatLength: 500, meter: 4, uninherited: true, kiai: false }],
  }, 60000, { previewTimeMs: -1 });
  return timeline;
};

const tickXs = (rects) => rects
  .filter((rect) => rect.h === TICK_H && rect.y === 0 && rect.alpha > 0.01)
  .map((rect) => rect.x);

test('zoomed in, the ticks sit on the map\'s bars rather than on round seconds', () => {
  withWindow(() => {
    const { canvas, rects } = createRecordingCanvas();
    const timeline = createOffsetTimeline(canvas);
    // 4s across 200px: bars land 100px apart, which is well past the width the
    // beat grid has finished fading in at.
    timeline.setView(0, 4000, { animate: false });
    rects.length = 0;
    timeline.render(0);

    const msPerPx = 4000 / WIDTH;
    const expected = [OFFSET_MS, OFFSET_MS + BAR_MS].map((ms) => Math.round(ms / msPerPx));
    assert.deepEqual(tickXs(rects), expected);

    // And emphatically not where the clock would have put them.
    const clockStepMs = pickTickStep(msPerPx);
    const clockXs = [];
    for (let ms = 0; ms <= 4000; ms += clockStepMs) {
      clockXs.push(Math.round(ms / msPerPx));
    }
    assert.notDeepEqual(tickXs(rects), clockXs);
  });
});

test('zoomed out, the ticks stay on bars and only group into bigger steps', () => {
  withWindow(() => {
    const { canvas, rects } = createRecordingCanvas();
    const timeline = createOffsetTimeline(canvas);
    // The whole minute across 200px puts single bars 6.7px apart -- too close
    // to read, but grouping them is what widens the ruler, not falling back to
    // the clock.
    timeline.resetZoom({ animate: false });
    rects.length = 0;
    timeline.render(0);

    const msPerPx = 60000 / WIDTH;
    // The smallest power-of-two grouping of bars that stays legible.
    let stepMs = BAR_MS;
    while (stepMs / msPerPx < 22) {
      stepMs *= 2;
    }
    assert.ok(stepMs > BAR_MS, 'this view should need more than one bar a tick');
    assert.equal(Math.log2(stepMs / BAR_MS) % 1, 0, 'grouped by a power of two');

    const expected = [];
    for (let ms = OFFSET_MS; ms < 60000; ms += stepMs) {
      expected.push(Math.round(ms / msPerPx));
    }
    assert.deepEqual(tickXs(rects), expected);

    // Every mark is still a downbeat, and they are far enough apart to read.
    for (const ms of [OFFSET_MS, OFFSET_MS + stepMs]) {
      assert.equal((ms - OFFSET_MS) % BAR_MS, 0);
    }
    const xs = tickXs(rects);
    assert.ok(xs[1] - xs[0] >= 22, `ticks ${xs[1] - xs[0]}px apart`);

    // And still nowhere near the clock, which has no factor in common with a
    // 137ms offset.
    const clockStepMs = pickTickStep(msPerPx);
    const clockXs = [];
    for (let ms = 0; ms <= 60000; ms += clockStepMs) {
      clockXs.push(Math.round(ms / msPerPx));
    }
    assert.notDeepEqual(xs, clockXs);
  });
});

test('each tempo counts its own bars from where it starts', () => {
  withWindow(() => {
    const { canvas, rects } = createRecordingCanvas();
    const timeline = new TimelineRenderer(canvas);
    // 120 BPM from 0, then 150 BPM from 8000ms -- a bar of 2000ms, then 1600ms.
    timeline.setBeatmap({
      objects: [{ kind: 'circle', time: 0, endTime: 0 }],
      timingControlPoints: [
        { time: 0, beatLength: 500, meter: 4, uninherited: true, kiai: false },
        { time: 8000, beatLength: 400, meter: 4, uninherited: true, kiai: false },
      ],
    }, 16000, { previewTimeMs: -1 });
    timeline.setView(0, 16000, { animate: false });
    rects.length = 0;
    timeline.render(0);

    const msPerPx = 16000 / WIDTH;
    const expected = [];
    // 2000ms bars are 25px apart, which is legible as they are.
    for (let ms = 0; ms < 8000; ms += 2000) expected.push(Math.round(ms / msPerPx));
    // 1600ms bars are only 20px, so this tempo groups into twos on its own --
    // and counts them from its own downbeat rather than carrying the first
    // tempo's grid across.
    for (let ms = 8000; ms < 16000; ms += 3200) expected.push(Math.round(ms / msPerPx));

    assert.deepEqual(tickXs(rects), expected);
    // Which is the point: one grid cannot describe two tempos.
    assert.notEqual(expected[1] - expected[0], expected[expected.length - 1] - expected[expected.length - 2]);
  });
});

test('a map with no timing points still gets a ruler', () => {
  withWindow(() => {
    const { canvas, rects } = createRecordingCanvas();
    const timeline = new TimelineRenderer(canvas);
    timeline.setBeatmap({ objects: [{ kind: 'circle', time: 0, endTime: 0 }], timingControlPoints: [] }, 10000);
    timeline.setView(0, 4000, { animate: false });
    rects.length = 0;
    timeline.render(0);

    assert.ok(tickXs(rects).length > 0, 'the clock ticks are all there is to show');
  });
});

// --- snapping and picking objects out --------------------------------------
//
// Zoomed in, the marks are what the pointer is aiming at, so they pull it on:
// landing a few milliseconds off a note is never what a click meant. Which
// objects are ringed is also what a copied timestamp names, so the hit test
// has to agree with what is drawn.

// Notes every 500ms from 1000ms, plus a 3s slider at 6000ms.
const createPickableTimeline = () => {
  const timeline = new TimelineRenderer(createCanvas());
  const objects = [];
  for (let time = 1000; time <= 5000; time += 500) {
    objects.push({ kind: 'circle', time, endTime: time, comboNumber: (time / 500) % 4 });
  }
  objects.push({ kind: 'slider', time: 6000, endTime: 9000, comboNumber: 1 });
  timeline.setBeatmap({
    objects,
    timingControlPoints: [{ time: 0, beatLength: 500, meter: 4, uninherited: true, kiai: false }],
  }, 12000, { previewTimeMs: -1 });
  return timeline;
};

// 2000ms across 200px is 10ms/px: objects are fully drawn and a grab radius of
// 7px is 70ms, comfortably inside the 500ms spacing.
const zoomOnto = (timeline, startMs = 1000, durationMs = 2000) => {
  timeline.setView(startMs, durationMs, { animate: false });
  timeline.render(0);
  return durationMs / WIDTH;
};

test('zoomed in, a time near an object is pulled onto it', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    const msPerPx = zoomOnto(timeline);

    // 30ms past the 2000ms note: three pixels off, well inside the magnet.
    const x = (2030 - 1000) / msPerPx;
    assert.equal(timeline.snapTimeAtX(x), 2000);
    assert.equal(timeline.objectIndexAtX(x), 2);
  });
});

test('a time between two objects is left where it is', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    const msPerPx = zoomOnto(timeline);

    // Halfway between the 2000ms and 2500ms notes is 25px from each.
    const x = (2250 - 1000) / msPerPx;
    assert.equal(timeline.objectIndexAtX(x), -1);
    assert.equal(Math.round(timeline.snapTimeAtX(x)), 2250);
  });
});

test('zoomed out, nothing is magnetic', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    // The whole map across 200px: the objects are drawn as density, not marks,
    // so there is nothing to aim at.
    timeline.resetZoom({ animate: false });
    timeline.render(0);

    assert.equal(timeline.areObjectsGrabbable(), false);
    assert.equal(timeline.objectIndexAtX(50), -1);
    assert.equal(timeline.snapTimeAtX(50), timeline.timeAtX(50));
  });
});

test('a slider body can be picked out but does not drag the playhead to its head', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    const msPerPx = zoomOnto(timeline, 6000, 4000);
    // Right in the middle of the 6000-9000ms slider.
    const x = (7500 - 6000) / msPerPx;

    assert.equal(timeline.objectIndexAtX(x, { includeBodies: true }), 9, 'the slider is pickable');
    assert.equal(timeline.objectIndexAtX(x), -1, 'but its head is nowhere near');
    // Snapping only follows heads, or scrubbing a long object would fling the
    // playhead back to where it started.
    assert.equal(Math.round(timeline.snapTimeAtX(x)), 7500);
  });
});

test('the selection is what a timestamp will name, in time order', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    timeline.setSelection([4, 2, 3]);

    assert.deepEqual(timeline.getSelectedIndices(), [2, 3, 4]);
    assert.deepEqual(timeline.getSelectedObjects().map((o) => o.time), [2000, 2500, 3000]);
    assert.equal(timeline.hasSelection(), true);
  });
});

test('indices that point at no object are refused', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    timeline.setSelection([0, -1, 999, 1.5, null, undefined, '2']);

    assert.deepEqual(timeline.getSelectedIndices(), [0]);
  });
});

test('a converted map drops the selection rather than renaming it', () => {
  withWindow(() => {
    // A mania key count change can hand back a different number of notes, so
    // indices into the old array mean nothing.
    const timeline = createPickableTimeline();
    timeline.setSelection([1, 2]);
    assert.equal(timeline.hasSelection(), true);

    timeline.setObjects([{ kind: 'circle', time: 1000, endTime: 1000 }]);
    assert.equal(timeline.hasSelection(), false);
    assert.deepEqual(timeline.getSelectedObjects(), []);
  });
});

test('loading another map drops the selection too', () => {
  withWindow(() => {
    const timeline = createPickableTimeline();
    timeline.setSelection([1]);
    timeline.setBeatmap({ objects: [{ kind: 'circle', time: 0, endTime: 0 }] }, 1000);

    assert.equal(timeline.hasSelection(), false);
  });
});

test('a ring is drawn on each selected object that is on screen', () => {
  withWindow(() => {
    const { canvas, arcs } = createRecordingCanvas();
    const timeline = new TimelineRenderer(canvas);
    const objects = [];
    for (let time = 1000; time <= 9000; time += 1000) {
      objects.push({ kind: 'circle', time, endTime: time });
    }
    timeline.setBeatmap({
      objects,
      timingControlPoints: [{ time: 0, beatLength: 500, meter: 4, uninherited: true, kiai: false }],
    }, 12000, { previewTimeMs: -1 });

    // 1000..3000ms across 200px. Two of the three picked objects are in it;
    // the one at 9000ms is far off the right.
    timeline.setSelection([0, 1, 8]);
    timeline.setView(1000, 2000, { animate: false });
    arcs.length = 0;
    timeline.render(0);

    const rings = arcs.filter((arc) => arc.stroke === 'rgb(255, 222, 123)');
    const msPerPx = 2000 / WIDTH;
    assert.deepEqual(
      rings.map((ring) => Math.round(ring.x)),
      [0, Math.round(1000 / msPerPx)],
      'one ring per visible selected object, at its own time',
    );
    assert.ok(rings.every((ring) => ring.r > 0));
  });
});

test('nothing selected draws no rings at all', () => {
  withWindow(() => {
    const { canvas, arcs } = createRecordingCanvas();
    const timeline = new TimelineRenderer(canvas);
    timeline.setBeatmap({
      objects: [{ kind: 'circle', time: 1000, endTime: 1000 }, { kind: 'circle', time: 2000, endTime: 2000 }],
      timingControlPoints: [{ time: 0, beatLength: 500, meter: 4, uninherited: true, kiai: false }],
    }, 12000, { previewTimeMs: -1 });
    timeline.setView(1000, 2000, { animate: false });

    arcs.length = 0;
    timeline.render(0);
    assert.equal(arcs.filter((arc) => arc.stroke === 'rgb(255, 222, 123)').length, 0);

    // ...and one does, so the check above is not passing for want of a canvas.
    timeline.setSelection([0]);
    arcs.length = 0;
    timeline.render(0);
    assert.equal(arcs.filter((arc) => arc.stroke === 'rgb(255, 222, 123)').length, 1);
  });
});
