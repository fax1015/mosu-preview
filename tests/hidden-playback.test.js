import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackController } from '../src/audio/playback.js';
import { createTimingController } from '../src/core/timing.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// A preview with no audio, so playing it runs the loop on the visual clock, and
// a loop whose frames and timer ticks are only ever called by the test.
const createHarness = () => {
  const state = {
    audio: null,
    audioAnchorMapMs: 0,
    audioAnchorSrc: '',
    audioSyncEnabled: false,
    audioOpToken: 0,
    pendingSeekMapMs: null,
    currentTimeMs: 0,
    durationMs: 600_000,
    mapData: { objects: [] },
    isPlaying: false,
    playbackMode: 'none',
    playbackSpeed: 1,
    playStartMapMs: 0,
    playStartPerfMs: 0,
    rafId: null,
  };
  const page = { hidden: false };
  const frames = [];
  const ticks = [];
  const cancelled = [];
  let renders = 0;
  let nextId = 1;

  const controller = createPlaybackController({
    state,
    helpers: {
      ...createTimingController({ state, clamp }),
      ensureTimelineDurationAnimation: () => {},
      renderFrame: () => { renders += 1; },
      requestFrame: (callback) => { frames.push({ id: nextId, callback }); return nextId++; },
      cancelFrame: (id) => { cancelled.push(`frame ${id}`); },
      isHidden: () => page.hidden,
      requestTick: (callback) => { ticks.push({ id: nextId, callback }); return nextId++; },
      cancelTick: (id) => { cancelled.push(`tick ${id}`); },
    },
  });

  return {
    state, page, frames, ticks, cancelled, controller, renders: () => renders,
  };
};

test('a hidden window plays on from a timer and goes back to frames when shown', async () => {
  const {
    state, page, frames, ticks, cancelled, controller, renders,
  } = createHarness();

  await controller.togglePlayback();
  assert.equal(state.isPlaying, true);
  assert.equal(frames.length, 1);
  assert.equal(ticks.length, 0);

  // The frame already asked for never comes once hidden, so it is dropped and
  // a tick runs at once, rather than whenever a throttled timer gets round to it.
  page.hidden = true;
  controller.refreshPlaybackLoop();
  assert.deepEqual(cancelled, [`frame ${frames[0].id}`]);
  assert.equal(renders(), 1, 'the hidden lookahead is placed straight away');
  assert.equal(ticks.length, 1);
  assert.equal(state.rafId, ticks[0].id);

  // Each tick moves the clock on and asks for the next one.
  ticks[0].callback(performance.now());
  assert.equal(renders(), 2);
  assert.equal(ticks.length, 2);
  assert.equal(frames.length, 1, 'no frames while hidden');

  // Nothing changed, nothing to do.
  controller.refreshPlaybackLoop();
  assert.equal(ticks.length, 2);

  page.hidden = false;
  controller.refreshPlaybackLoop();
  assert.deepEqual(cancelled.slice(1), [`tick ${ticks[1].id}`]);
  assert.equal(frames.length, 2);
  assert.equal(state.rafId, frames[1].id);
});

test('stopping while hidden cancels the pending tick, not a frame', async () => {
  const {
    state, page, ticks, cancelled, controller,
  } = createHarness();

  page.hidden = true;
  await controller.togglePlayback();
  assert.equal(ticks.length, 1, 'a preview started hidden starts on the timer');

  controller.stopPlayback();
  assert.deepEqual(cancelled, [`tick ${ticks[0].id}`]);
  assert.equal(state.rafId, null);

  // A stopped preview has no loop to move.
  page.hidden = false;
  controller.refreshPlaybackLoop();
  assert.equal(state.rafId, null);
});
