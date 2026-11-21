import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTimelineInput } from '../src/ui/timelineInput.js';

const createFakeTarget = () => {
  const listeners = new Map();
  return {
    listeners,
    clientWidth: 300,
    clientHeight: 24,
    offsetWidth: 40,
    hidden: true,
    textContent: '',
    style: { left: '' },
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      toggle(c, f) { if (f) this.set.add(c); else this.set.delete(c); },
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 24 }; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, evt) {
      for (const fn of listeners.get(type) || []) fn(evt);
    },
  };
};

test('bindTimelineInput skips redundant timeline renders during playback and cleans up on dispose', () => {
  const origWindow = globalThis.window;
  const origRaf = globalThis.requestAnimationFrame;
  const origCancelRaf = globalThis.cancelAnimationFrame;
  let scheduledId = 0;
  let cancelledId = null;
  let queuedCb = null;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = (cb) => { queuedCb = cb; scheduledId += 1; return scheduledId; };
  globalThis.cancelAnimationFrame = (id) => { cancelledId = id; queuedCb = null; };

  try {
    const canvas = createFakeTarget();
    const tooltip = createFakeTarget();
    let timelineRenders = 0;
    const timeline = {
      setHoverX() {},
      setPlaying() {},
      regionAt: () => 'track',
      isZoomed: () => false,
      needsAnimationFrame: () => false,
      areObjectsGrabbable: () => false,
      objectIndexAtX: () => -1,
      snapTimeAtX: (x) => x * 10,
      timeAtX: (x) => x * 10,
      formatTimeAtX: (x) => `0:${String(Math.floor((x * 10) / 1000)).padStart(2, '0')}`,
      formatTimeAtMs: (ms) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`,
    };
    const renderer = {
      timeline,
      renderTimeline() { timelineRenders += 1; },
      renderPlayfield() {},
    };
    const state = { mapData: { objects: [] }, durationMs: 10000, isPlaying: true };

    const handle = bindTimelineInput({
      canvas,
      tooltip,
      state,
      renderer,
      seekTo: () => {},
    });

    canvas.emit('pointermove', { clientX: 120, clientY: 12, altKey: false });
    assert.equal(tooltip.hidden, false);
    assert.equal(tooltip.textContent, '0:01');
    // While playing, the main playback loop already paints the timeline, so
    // hover does not trigger a duplicate rAF renderTimeline() call.
    if (queuedCb) queuedCb(16);
    assert.equal(timelineRenders, 0);

    // When paused, hover schedules a single render and dispose cancels pending rAF.
    state.isPlaying = false;
    canvas.emit('pointermove', { clientX: 150, clientY: 12, altKey: false });
    const pending = scheduledId;
    handle.dispose();
    assert.equal(cancelledId, pending);
  } finally {
    if (origWindow === undefined) delete globalThis.window;
    else globalThis.window = origWindow;
    if (origRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = origRaf;
    if (origCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = origCancelRaf;
  }
});
