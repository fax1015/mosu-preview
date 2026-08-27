import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimingController } from '../src/core/timing.js';
import { createPlaybackController } from '../src/audio/playback.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const flushAsync = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// Models the parts of HTMLMediaElement the clock depends on: `currentTime`
// advances at the effective `playbackRate` while playing, and a seek is only
// reported once the harness says the element settled on it.
const createFakeAudio = ({ durationSec = 600, src = 'blob:full-audio' } = {}) => ({
  src,
  duration: durationSec,
  currentTime: 0,
  paused: true,
  playbackRate: 1,
  playCount: 0,
  pauseCount: 0,
  pause() {
    this.paused = true;
    this.pauseCount += 1;
  },
  play() {
    this.paused = false;
    this.playCount += 1;
    return Promise.resolve();
  },
  // Test-only: what real wall-clock time does to the media position.
  advanceWallClockMs(wallMs) {
    if (!this.paused) {
      this.currentTime += (wallMs / 1000) * this.playbackRate;
    }
  },
});

// Hands out one `seeked` at a time, so a test can hold a seek pending, issue
// more seeks behind it, and decide exactly when each one lands.
const createSeekGate = () => {
  const waiting = [];
  return {
    wait: () => new Promise((resolve) => { waiting.push(resolve); }),
    settleNext: (value = true) => {
      const resolve = waiting.shift();
      if (resolve) {
        resolve(value);
      }
      return flushAsync();
    },
    get pending() {
      return waiting.length;
    },
  };
};

const createFrameDriver = () => {
  const queued = new Map();
  let nextId = 1;
  return {
    request: (callback) => {
      const id = nextId;
      nextId += 1;
      queued.set(id, callback);
      return id;
    },
    cancel: (id) => {
      queued.delete(id);
    },
    // Runs the frame that is queued right now. The tick re-queues itself, so a
    // frame scheduled by this frame runs on the next call, not this one.
    runFrame: (nowPerfMs) => {
      const callbacks = [...queued.values()];
      queued.clear();
      callbacks.forEach((callback) => callback(nowPerfMs));
      return callbacks.length;
    },
    get pending() {
      return queued.size;
    },
  };
};

const createHarness = ({
  anchorMapMs = 0,
  durationMs = 600_000,
  durationSec = 600,
  gate = createSeekGate(),
} = {}) => {
  const audio = createFakeAudio({ durationSec });
  const frames = createFrameDriver();
  const rendered = [];
  const state = {
    audio,
    audioAnchorMapMs: anchorMapMs,
    // The anchor describes this source and no other.
    audioAnchorSrc: audio.src,
    audioSyncEnabled: true,
    audioOpToken: 0,
    pendingSeekMapMs: null,
    currentTimeMs: 0,
    durationMs,
    mapData: { objects: [] },
    isPlaying: false,
    playbackMode: 'none',
    playbackSpeed: 1,
    playStartMapMs: 0,
    playStartPerfMs: 0,
    rafId: null,
  };

  const timing = createTimingController({ state, clamp });
  const controller = createPlaybackController({
    state,
    helpers: {
      ...timing,
      ensureTimelineDurationAnimation: () => {},
      renderFrame: () => { rendered.push(state.currentTimeMs); },
      waitForAudioSeek: () => gate.wait(),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    },
  });

  // Puts the preview into the steady state every clock test starts from:
  // playing, with the media element authoritative.
  const startAudioPlayback = async (atMapMs = 0) => {
    state.currentTimeMs = atMapMs;
    const started = controller.togglePlayback();
    await gate.settleNext(true);
    assert.equal(await started, true, 'audio playback should start');
    assert.equal(state.playbackMode, 'audio');
    return started;
  };

  return {
    audio, state, timing, controller, frames, gate, rendered, startAudioPlayback,
  };
};

const expectedMapTimeMs = (state) => (
  state.audioAnchorMapMs + (state.audio.currentTime * 1000)
);

test('every audio-mode frame reads the media clock exactly, at every supported rate', async () => {
  for (const rate of [0.1, 0.5, 1, 1.5, 2]) {
    const harness = createHarness({ anchorMapMs: 0 });
    const { audio, state, frames } = harness;
    await harness.startAudioPlayback(0);

    state.playbackSpeed = rate;
    audio.playbackRate = rate;

    // Deliberately poison the visual clock. Under the old extrapolation these
    // values decided the playhead; now they must not be able to reach it.
    state.playStartMapMs = -987_654;
    state.playStartPerfMs = 1_000_000;

    let perfNowMs = 0;
    for (let frame = 0; frame < 20; frame += 1) {
      // The performance clock the frame reports is nothing like the media's.
      perfNowMs += 16.7;
      audio.advanceWallClockMs(16.7);
      frames.runFrame(perfNowMs * 3.7);
      assert.equal(
        state.currentTimeMs,
        expectedMapTimeMs(state),
        `frame ${frame} at ${rate}x must equal the media position`,
      );
    }

    // Sanity check that the rate actually moved the media position.
    assert.ok(state.currentTimeMs > 0);
    assert.ok(Math.abs(state.currentTimeMs - (20 * 16.7 * rate)) < 0.001);
  }
});

test('the anchor offset is carried through, so preview clips map onto the beatmap timeline', async () => {
  const anchorMapMs = 610_491;
  const harness = createHarness({ anchorMapMs, durationMs: 62 * 60_000, durationSec: 10 });
  const { audio, state, frames } = harness;
  await harness.startAudioPlayback(anchorMapMs);

  audio.advanceWallClockMs(2000);
  frames.runFrame(999_999);
  assert.equal(state.currentTimeMs, anchorMapMs + 2000);
});

test('repeated rate changes inherit the media position instead of the visual clock', async () => {
  const harness = createHarness();
  const {
    audio, state, timing, frames,
  } = harness;
  await harness.startAudioPlayback(0);

  // A visual clock that has run away from the audio. Every rate change used to
  // rebase from exactly this, baking the gap in permanently.
  state.playStartMapMs = 250_000;
  state.playStartPerfMs = 0;

  let perfNowMs = 0;
  for (const rate of [0.5, 2, 0.1, 1.5, 1, 0.75]) {
    perfNowMs += 500;
    audio.advanceWallClockMs(500);

    const mediaMapTimeMs = expectedMapTimeMs(state);
    const rebasedMs = timing.applyPlaybackRate(rate, perfNowMs);

    assert.equal(rebasedMs, mediaMapTimeMs, `${rate}x must inherit the media position`);
    assert.equal(state.currentTimeMs, mediaMapTimeMs);
    assert.equal(audio.playbackRate, rate);

    // And the next frame reads the source again rather than the rebased value.
    audio.advanceWallClockMs(100);
    frames.runFrame(perfNowMs + 100);
    assert.equal(state.currentTimeMs, expectedMapTimeMs(state));
  }
});

test('a rate change while the visual clock is running rebases from the visual clock', () => {
  const harness = createHarness();
  const { state, timing } = harness;
  // No audio behind this stretch of the map: the manual clock is the real one.
  state.audioSyncEnabled = false;
  state.isPlaying = true;
  state.playbackMode = 'manual';
  state.playStartMapMs = 10_000;
  state.playStartPerfMs = 1000;
  state.playbackSpeed = 1;

  assert.equal(timing.applyPlaybackRate(2, 3000), 12_000);
  assert.equal(state.playbackSpeed, 2);
  // From here it runs at the new rate, from where it actually was.
  assert.equal(timing.getCurrentManualMapTime(4000), 14_000);
});

test('a rapid drag issues one resume, at the position the pointer settled on', async () => {
  const harness = createHarness();
  const {
    audio, state, controller, gate,
  } = harness;
  await harness.startAudioPlayback(0);
  const playCountBeforeDrag = audio.playCount;

  const dragTargets = [12_000, 34_000, 51_000, 47_500, 90_000];
  dragTargets.forEach((targetMs) => {
    controller.seekTo(targetMs);
    assert.equal(state.playbackMode, 'seeking');
    assert.equal(audio.paused, true, 'audio stays paused for the whole drag');
    assert.equal(state.currentTimeMs, targetMs, 'the pending target is what is shown');
  });

  // One wait is outstanding for the whole drag, not one per pointer sample: the
  // settle loop re-targets the newest seek instead of queueing a resume behind
  // every position the pointer passed through.
  assert.equal(gate.pending, 1);

  // The sample that was in flight when the drag moved on reports back. It is no
  // longer what the user is asking for, so it must not resume anything.
  await gate.settleNext(true);
  assert.equal(state.playbackMode, 'seeking');
  assert.equal(audio.playCount, playCountBeforeDrag, 'no resume mid-drag');
  assert.equal(gate.pending, 1);

  // The position the drag actually settled on.
  await gate.settleNext(true);
  assert.equal(state.playbackMode, 'audio');
  assert.equal(state.currentTimeMs, 90_000);
  assert.equal(audio.currentTime, 90);
  assert.equal(audio.playCount, playCountBeforeDrag + 1, 'exactly one resume');
  assert.equal(gate.pending, 0);
});

test('keyboard seeks stack on the pending target rather than the settled one', async () => {
  const harness = createHarness();
  const { state, controller, gate } = harness;
  await harness.startAudioPlayback(30_000);

  controller.seekRelative(5000);
  controller.seekRelative(5000);
  controller.seekRelative(-15_000);
  assert.equal(state.currentTimeMs, 25_000);

  await gate.settleNext(true);
  await gate.settleNext(true);
  await gate.settleNext(true);
  assert.equal(state.currentTimeMs, 25_000);
  assert.equal(state.playbackMode, 'audio');
});

test('a seeked event that arrives after a newer seek cannot drag the playhead back', async () => {
  const harness = createHarness();
  const {
    audio, state, controller, gate,
  } = harness;
  await harness.startAudioPlayback(0);

  controller.seekTo(20_000);
  controller.seekTo(120_000);
  assert.equal(state.currentTimeMs, 120_000);

  // The obsolete seek reports in, with the element still sitting on the old
  // position it was asked for.
  audio.currentTime = 20;
  await gate.settleNext(true);
  assert.equal(state.currentTimeMs, 120_000, 'the stale seeked must be ignored');
  assert.equal(state.playbackMode, 'seeking');

  // Then the real one lands.
  audio.currentTime = 120;
  await gate.settleNext(true);
  assert.equal(state.playbackMode, 'audio');
  assert.equal(state.currentTimeMs, 120_000);
});

test('a hotswap that finishes after the user seeks again leaves the user seek alone', async () => {
  const harness = createHarness();
  const {
    audio, state, controller, gate,
  } = harness;
  await harness.startAudioPlayback(60_000);

  // The source swap takes the operation token and holds the playhead on the
  // position it means to commit, exactly as hotswapToFullAudio does.
  const commitToken = controller.beginAudioOperation();
  controller.holdForAudioSeek(60_000);
  audio.currentTime = 60;

  // While it waits for the element, the user drags somewhere else entirely.
  controller.seekTo(300_000);
  assert.equal(state.currentTimeMs, 300_000);

  // Now the swap's own wait resolves. It has to notice it lost.
  assert.equal(controller.isCurrentAudioOperation(commitToken), false);
  if (controller.isCurrentAudioOperation(commitToken)) {
    controller.adoptAudioClock();
  }
  assert.equal(state.currentTimeMs, 300_000, 'the hotswap must not re-commit its own timestamp');

  audio.currentTime = 300;
  await gate.settleNext(true);
  assert.equal(state.playbackMode, 'audio');
  assert.equal(state.currentTimeMs, 300_000);
});

test('a hotswap that wins takes the media position as the truth', async () => {
  const harness = createHarness();
  const {
    audio, state, controller,
  } = harness;
  await harness.startAudioPlayback(60_000);

  const commitToken = controller.beginAudioOperation();
  controller.holdForAudioSeek(60_000);
  assert.equal(state.playbackMode, 'seeking');

  // The element landed a few ms off the requested position, as they do.
  audio.currentTime = 60.031;
  assert.equal(controller.isCurrentAudioOperation(commitToken), true);
  controller.adoptAudioClock();
  assert.equal(state.playbackMode, 'audio');
  assert.equal(state.currentTimeMs, 60_031);
});

test('a seek the audio never settles hands the clock back instead of freezing', async () => {
  const harness = createHarness();
  const {
    state, controller, gate, frames,
  } = harness;
  await harness.startAudioPlayback(0);

  controller.seekTo(45_000);
  assert.equal(state.playbackMode, 'seeking');

  await gate.settleNext(false);
  assert.equal(state.playbackMode, 'manual', 'a stalled seek must not leave the preview frozen');
  assert.equal(state.currentTimeMs, 45_000);

  // And the visual clock carries it from there.
  state.playStartPerfMs = 0;
  frames.runFrame(1000);
  assert.equal(state.currentTimeMs, 46_000);
});

test('a paused seek settles on the media position and starts no clock', async () => {
  const harness = createHarness();
  const {
    audio, state, controller, gate,
  } = harness;

  controller.seekTo(75_000);
  assert.equal(state.playbackMode, 'seeking');
  assert.equal(state.currentTimeMs, 75_000);

  audio.currentTime = 74.98;
  await gate.settleNext(true);
  assert.equal(state.playbackMode, 'none');
  assert.equal(state.currentTimeMs, 74_980);
  assert.equal(state.isPlaying, false);
  assert.equal(audio.paused, true);
  assert.equal(audio.playCount, 0, 'a paused seek must never start playback');
});

test('audio pausing under the preview hands the clock over without losing the position', async () => {
  const harness = createHarness();
  const {
    audio, state, timing, frames,
  } = harness;
  await harness.startAudioPlayback(0);
  assert.equal(timing.isAudioClockAuthoritative(), true);

  audio.advanceWallClockMs(5000);
  frames.runFrame(1000);
  assert.equal(state.currentTimeMs, 5000);

  // A stall or an external pause: the element stops being the clock.
  audio.pause();
  frames.runFrame(2000);
  assert.equal(state.playbackMode, 'manual');
  assert.equal(timing.isAudioClockAuthoritative(), false);
  assert.equal(state.currentTimeMs, 5000);

  frames.runFrame(3000);
  assert.equal(state.currentTimeMs, 6000, 'the visual clock picks up where the audio stopped');
});

test('playback stops at the end of the map', async () => {
  const harness = createHarness({ durationMs: 8000, durationSec: 20 });
  const { audio, state, frames } = harness;
  await harness.startAudioPlayback(0);

  audio.advanceWallClockMs(7000);
  frames.runFrame(1000);
  assert.equal(state.isPlaying, true);

  audio.advanceWallClockMs(2000);
  frames.runFrame(2000);
  assert.equal(state.currentTimeMs, 8000);
  assert.equal(state.isPlaying, false);
  assert.equal(state.playbackMode, 'none');
  assert.equal(audio.paused, true);
  assert.equal(frames.pending, 0, 'the frame loop must not keep running');
});

test('a preview clip that does not cover the playhead falls back to the visual clock', async () => {
  const previewAnchorMapMs = 610_491;
  const harness = createHarness({
    anchorMapMs: previewAnchorMapMs,
    durationMs: 62 * 60_000,
    durationSec: 10,
  });
  const {
    audio, state, controller, frames, gate,
  } = harness;
  await harness.startAudioPlayback(previewAnchorMapMs);

  // 25 minutes in, far past the ~10s the b.ppy.sh clip covers.
  controller.seekTo(25 * 60_000);
  assert.equal(state.playbackMode, 'manual');
  assert.equal(state.currentTimeMs, 25 * 60_000);
  assert.equal(audio.paused, true);
  assert.equal(gate.pending, 0, 'an uncovered seek must not wait on the element');

  state.playbackSpeed = 2;
  state.playStartPerfMs = 0;
  state.playStartMapMs = 25 * 60_000;
  frames.runFrame(1000);
  assert.equal(state.currentTimeMs, (25 * 60_000) + 2000, 'the visual clock runs at the set rate');
});

test('stopping playback invalidates whatever operation was in flight', async () => {
  const harness = createHarness();
  const {
    audio, state, controller, gate,
  } = harness;
  await harness.startAudioPlayback(0);
  const playCountBeforeStop = audio.playCount;

  controller.seekTo(30_000);
  controller.stopPlayback();
  assert.equal(state.isPlaying, false);
  assert.equal(state.playbackMode, 'none');

  await gate.settleNext(true);
  assert.equal(state.isPlaying, false, 'a settled seek must not restart a stopped preview');
  assert.equal(audio.playCount, playCountBeforeStop);
  assert.equal(state.playbackMode, 'none');
});

test('a position from the old source cannot be read through the new anchor', async () => {
  const harness = createHarness({ anchorMapMs: 0 });
  const {
    audio, state, timing, frames,
  } = harness;
  await harness.startAudioPlayback(0);

  audio.advanceWallClockMs(5000);
  frames.runFrame(1000);
  assert.equal(state.currentTimeMs, 5000);

  // A source swap: the anchor changes first, and for a while afterwards the
  // element still answers with the position it had under the old source.
  state.audioAnchorMapMs = 610_491;
  state.audioAnchorSrc = 'blob:full-audio-2';
  assert.equal(timing.isAudioClockAuthoritative(), false);

  frames.runFrame(2000);
  assert.equal(state.playbackMode, 'manual');
  assert.equal(
    state.currentTimeMs,
    5000,
    'the old position must not be re-read through the new anchor',
  );
});

test('a seek the element clamps instead of honouring does not move the playhead', async () => {
  // A b.ppy.sh preview clip covering 10:10-10:20 of an hour-long map: a seek to
  // 25:00 is inside the coverage tolerance of nothing, and the element clamps.
  const anchorMapMs = 610_491;
  const harness = createHarness({
    anchorMapMs, durationMs: 62 * 60_000, durationSec: 10,
  });
  const {
    audio, state, controller, gate,
  } = harness;

  controller.seekTo(25 * 60_000);
  assert.equal(state.currentTimeMs, 25 * 60_000);

  // Whatever the element does, it cannot be at 25:00 -- it only holds ten
  // seconds of audio. Report the clamp the way a real element would.
  audio.currentTime = 10;
  await gate.settleNext(true);

  assert.equal(state.currentTimeMs, 25 * 60_000, 'the seek target has to survive the clamp');
  assert.notEqual(state.playbackMode, 'audio');
  assert.equal(audio.paused, true);
  assert.equal(audio.playCount, 0, 'nothing may play from the wrong position');
});

test('starting playback where the audio cannot reach falls back to the visual clock', async () => {
  const anchorMapMs = 610_491;
  const harness = createHarness({
    anchorMapMs, durationMs: 62 * 60_000, durationSec: 10,
  });
  const {
    audio, state, controller, gate,
  } = harness;

  // The duration is unknown until metadata loads, so the seek is accepted and
  // the element clamps. Adopting that is how the preview used to jump into the
  // middle of the clip when playback started anywhere else.
  audio.duration = Number.NaN;
  state.currentTimeMs = 25 * 60_000;
  const started = controller.togglePlayback();
  audio.currentTime = 10;
  await gate.settleNext(true);

  assert.equal(await started, true);
  assert.equal(state.isPlaying, true);
  assert.equal(state.playbackMode, 'manual', 'the visual clock carries it instead');
  assert.equal(state.currentTimeMs, 25 * 60_000);
  assert.equal(audio.paused, true);
});

test('a stall does not permanently hand the clock to the visual timeline', async () => {
  // The bug this guards: the handover was one-way. One stalled frame switched to
  // the visual clock, the element resumed, and nothing switched back -- so the
  // preview ran on the performance clock while the audio played independently,
  // permanently offset by however long the stall lasted. On a 200BPM map a
  // 150ms hiccup is half a beat, and it never recovered.
  const harness = createHarness();
  const { audio, state, frames } = harness;
  await harness.startAudioPlayback(0);

  audio.advanceWallClockMs(5000);
  frames.runFrame(1000);
  assert.equal(state.currentTimeMs, 5000);

  // The element stalls for a moment: the loop hands over to the visual clock.
  audio.pause();
  frames.runFrame(2000);
  assert.equal(state.playbackMode, 'manual');

  // The visual clock runs on for 150ms while the audio sits still.
  frames.runFrame(2150);
  assert.equal(state.currentTimeMs, 5150);
  assert.equal(audio.currentTime, 5, 'the element has not moved');

  // The element starts producing sound again.
  audio.paused = false;
  frames.runFrame(2200);

  assert.equal(state.playbackMode, 'audio', 'the clock has to come back to the element');
  assert.equal(
    state.currentTimeMs,
    5000,
    'and the playhead follows the audio rather than staying 150ms ahead of it',
  );

  // From here it tracks the element again, with no residual gap.
  audio.advanceWallClockMs(1000);
  frames.runFrame(3200);
  assert.equal(state.currentTimeMs, 6000);
});

test('a preview clip that cannot cover the map is not mistaken for a stall', async () => {
  // Manual mode is also how an uncovered stretch is played. Recovery must not
  // drag the playhead back into a clip sitting minutes away.
  const anchorMapMs = 610_491;
  const harness = createHarness({
    anchorMapMs, durationMs: 62 * 60_000, durationSec: 10,
  });
  const {
    audio, state, controller, frames,
  } = harness;
  await harness.startAudioPlayback(anchorMapMs);

  controller.seekTo(25 * 60_000);
  assert.equal(state.playbackMode, 'manual');

  // Something leaves the element running where it was, far from the playhead.
  audio.paused = false;
  frames.runFrame(1000);

  assert.equal(state.playbackMode, 'manual', 'a clip minutes away is not a stall');
  assert.ok(state.currentTimeMs >= 25 * 60_000, 'the playhead stays where the user put it');
});
