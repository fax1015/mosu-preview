import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimingController } from '../src/core/timing.js';
import { createPlaybackController } from '../src/audio/playback.js';
import {
  getPreviewClipAnchorMapMs,
  isPreviewClipAnchorable,
  resolveAudioSeekTarget,
  seekAudioElementToMapTime,
} from '../src/audio/seek.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// beatmapsets/970063 [Rain] is ~62 minutes with PreviewTime 610591, so the
// b.ppy.sh preview clip covers 10:10-10:20 of a 62 minute timeline.
const PREVIEW_TIME_MS = 610591;
const PREVIEW_CLIP_SEC = 10;

const createPreviewAudio = () => ({
  duration: PREVIEW_CLIP_SEC,
  currentTime: 0,
  paused: false,
  playbackRate: 1,
  src: 'https://b.ppy.sh/preview/970063.mp3',
  pause() {
    this.paused = true;
  },
  play() {
    this.paused = false;
    return Promise.resolve();
  },
});

// Seeks settle asynchronously now: the controller waits for the element before
// it hands the clock back to the audio.
const flushAsync = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('map times outside the audio are reported as uncovered', () => {
  const before = resolveAudioSeekTarget(5 * 60_000, PREVIEW_TIME_MS, PREVIEW_CLIP_SEC);
  assert.equal(before.covered, false);

  const after = resolveAudioSeekTarget(25 * 60_000, PREVIEW_TIME_MS, PREVIEW_CLIP_SEC);
  assert.equal(after.covered, false);

  const inside = resolveAudioSeekTarget(PREVIEW_TIME_MS + 5000, PREVIEW_TIME_MS, PREVIEW_CLIP_SEC);
  assert.equal(inside.covered, true);
  assert.equal(inside.sec, 5);
});

test('an unknown duration is treated as reachable so metadata can still load', () => {
  const target = resolveAudioSeekTarget(30_000, 0, Number.NaN);
  assert.equal(target.covered, true);
  assert.equal(target.sec, 30);
});

test('a seek just past the end still clamps, so full audio slightly shorter than the map works', () => {
  const target = resolveAudioSeekTarget(60_100, 0, 60);
  assert.equal(target.covered, true);
  assert.equal(target.sec, 60);
});

test('seeking outside the audio fails instead of silently clamping', () => {
  const audio = createPreviewAudio();

  // Forward out of range: the old code clamped to the end of the clip and
  // returned true, which let the 'seeked' listener drag the playhead back.
  assert.equal(seekAudioElementToMapTime(audio, 25 * 60_000, PREVIEW_TIME_MS), false);
  assert.equal(audio.currentTime, 0);

  // Backward out of range.
  assert.equal(seekAudioElementToMapTime(audio, 0, PREVIEW_TIME_MS), false);
  assert.equal(audio.currentTime, 0);

  // Inside the clip.
  assert.equal(seekAudioElementToMapTime(audio, PREVIEW_TIME_MS + 4000, PREVIEW_TIME_MS), true);
  assert.equal(audio.currentTime, 4);
});

test('requireCoverage:false still clamps, for the full-audio hotswap preflight', () => {
  const audio = createPreviewAudio();
  assert.equal(
    seekAudioElementToMapTime(audio, 25 * 60_000, PREVIEW_TIME_MS, { requireCoverage: false }),
    true,
  );
  assert.equal(audio.currentTime, PREVIEW_CLIP_SEC);
});

// Drives the real seek path rather than a copy of it, so the coverage-demote
// behaviour cannot drift away from what the popup actually runs.
const createScrubHarness = () => {
  const audio = createPreviewAudio();
  const state = {
    audio,
    audioAnchorMapMs: PREVIEW_TIME_MS,
    audioAnchorSrc: audio.src,
    audioSyncEnabled: true,
    audioOpToken: 0,
    pendingSeekMapMs: null,
    currentTimeMs: PREVIEW_TIME_MS,
    durationMs: 62 * 60_000,
    mapData: { objects: [] },
    isPlaying: true,
    playbackMode: 'audio',
    playbackSpeed: 1,
    playStartMapMs: PREVIEW_TIME_MS,
    playStartPerfMs: 0,
    rafId: null,
  };
  const timing = createTimingController({ state, clamp });
  const controller = createPlaybackController({
    state,
    helpers: {
      ...timing,
      ensureTimelineDurationAnimation: () => {},
      renderFrame: () => {},
      waitForAudioSeek: async () => true,
      requestFrame: () => 1,
      cancelFrame: () => {},
    },
  });

  return { audio, state, controller };
};

test('scrubbing a marathon on preview audio does not snap back to the clip', async () => {
  const { audio, state, controller } = createScrubHarness();

  for (const targetMs of [0, 5 * 60_000, 25 * 60_000, 45 * 60_000, 61 * 60_000]) {
    state.isPlaying = true;
    state.playbackMode = 'audio';
    audio.paused = false;
    controller.seekTo(targetMs);
    // Uncovered targets are settled synchronously: there is no seek to wait for.
    assert.equal(state.currentTimeMs, targetMs, `scrub to ${targetMs}ms should hold`);
    assert.equal(state.playbackMode, 'manual');
  }

  // Inside the clip the audio takes the clock back once the element settles.
  state.playbackMode = 'audio';
  audio.paused = false;
  controller.seekTo(PREVIEW_TIME_MS + 3000);
  assert.equal(state.playbackMode, 'seeking');
  assert.equal(audio.paused, true, 'audio stays paused while the seek is pending');
  await flushAsync();
  assert.equal(state.currentTimeMs, PREVIEW_TIME_MS + 3000);
  assert.equal(state.playbackMode, 'audio');
  assert.equal(audio.paused, false);
});

test('a scrub out of range while paused leaves no clock running', () => {
  const { audio, state, controller } = createScrubHarness();
  state.isPlaying = false;
  audio.paused = true;

  controller.seekTo(25 * 60_000);
  assert.equal(state.currentTimeMs, 25 * 60_000);
  assert.equal(state.playbackMode, 'none');
});

test('seekRelative and restartPreview share the one seek path', () => {
  const { audio, state, controller } = createScrubHarness();
  state.isPlaying = true;
  state.playbackMode = 'audio';
  audio.paused = false;

  controller.seekRelative(-5000);
  assert.equal(state.currentTimeMs, PREVIEW_TIME_MS - 5000);
  // 5s before PreviewTime is outside the 10s clip, so the audio hands over.
  assert.equal(state.playbackMode, 'manual');
  assert.equal(audio.paused, true);
});

test('only a real preview point can anchor the b.ppy.sh clip', () => {
  // With PreviewTime -1 osu builds the clip from ~40% into the track, an offset
  // the .osu never exposes, so there is no valid map-time anchor for it.
  assert.equal(isPreviewClipAnchorable(610591), true);
  assert.equal(isPreviewClipAnchorable(1), true);
  assert.equal(isPreviewClipAnchorable(-1), false);
  assert.equal(isPreviewClipAnchorable(0), false);
  assert.equal(isPreviewClipAnchorable(Number.NaN), false);
  assert.equal(isPreviewClipAnchorable(undefined), false);
});

test('the preview clip anchor includes b.ppy.sh\'s 100ms lead-in', () => {
  assert.equal(getPreviewClipAnchorMapMs(316364), 316264);
  assert.equal(getPreviewClipAnchorMapMs(50), 0);
  assert.equal(getPreviewClipAnchorMapMs(-1), 0);
});
