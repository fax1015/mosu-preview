import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  resetState,
  setFullAudioState,
  setPlaybackState,
  setTimelineState,
  state,
} from '../src/core/state.js';

test('createInitialState succeeds without global Audio and allocates strictly monotonic fullAudioJobId', () => {
  const first = createInitialState();
  const second = createInitialState();
  assert.equal(first.audio, null);
  assert.ok(second.fullAudioJobId > first.fullAudioJobId, 'job ids must not collide');
});

test('resetState never rolls fullAudioJobId backwards', () => {
  const before = state.fullAudioJobId;
  resetState();
  assert.ok(state.fullAudioJobId > before);
});

test('setFullAudioState converts null and undefined set ids to null instead of "undefined"', () => {
  setFullAudioState({
    fullAudioSetId: '123',
    previewSetId: 456,
    activeSetId: '789',
  });
  assert.equal(state.fullAudioSetId, '123');
  assert.equal(state.previewSetId, '456');
  assert.equal(state.activeSetId, '789');

  setFullAudioState({
    fullAudioSetId: undefined,
    previewSetId: null,
    activeSetId: undefined,
  });
  assert.equal(state.fullAudioSetId, null);
  assert.equal(state.previewSetId, null);
  assert.equal(state.activeSetId, null);
});

test('setPlaybackState and setTimelineState coerce numeric and boolean fields cleanly', () => {
  setPlaybackState({ isPlaying: 1, playbackMode: 'manual', playStartPerfMs: 120, playStartMapMs: 500 });
  assert.equal(state.isPlaying, true);
  assert.equal(state.playbackMode, 'manual');
  setTimelineState({ currentTimeMs: 250, durationMs: 5000, mappedDurationMs: 4800 });
  assert.equal(state.currentTimeMs, 250);
  assert.equal(state.durationMs, 5000);
  resetState();
});
