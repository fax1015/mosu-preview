import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullAudioController } from '../src/audio/fullAudioController.js';
import { CleanupRegistry } from '../src/core/cleanup.js';

const createHarness = (overrides = {}) => {
  const badges = [];
  const debugLogs = [];
  const audio = {
    src: '',
    currentTime: 0,
    duration: 120,
    paused: true,
    playbackRate: 1,
    volume: 0.6,
    load() {},
    async play() { this.paused = false; },
    pause() { this.paused = true; },
  };
  const state = {
    audio,
    mapData: { audioFilename: 'audio.mp3', mode: 0 },
    metadata: { title: 'Song A', artist: 'Artist A', creator: 'Mapper A' },
    activeSetId: '100',
    fullAudioSetId: null,
    fullAudioStatus: 'idle',
    fullAudioCacheKey: '',
    fullAudioJobId: 1,
    fullAudioObjectUrl: null,
    fullAudioSliceUrl: null,
    fullAudioDurationMs: 0,
    fullAudioError: '',
    audioSyncEnabled: false,
    audioAnchorMapMs: 0,
    audioAnchorSrc: '',
    audioOpToken: 0,
    currentTimeMs: 0,
    durationMs: 60000,
    mappedDurationMs: 60000,
    isPlaying: false,
    playbackMode: 'none',
    playbackSpeed: 1,
    providerOverride: 'auto',
    providerPriority: ['mino'],
    disabledProviders: [],
    autoFallback: true,
  };
  const registry = new CleanupRegistry();
  const controller = createFullAudioController({
    state,
    registry,
    hitsoundPlayer: { attachMediaElement() {} },
    addDebugLog: (msg) => debugLogs.push(msg),
    badge: {
      setAudioBadge: (text, cls) => badges.push({ text, cls }),
      setAudioBadgeWithProvider: (text, cls, provider) => badges.push({ text, cls, provider }),
      hideAudioBadge: () => badges.push({ hidden: true }),
      setFullAudioLoading: (loading) => badges.push({ loading }),
      showTryingArchiveProviderBadge: (provider) => badges.push({ trying: provider }),
    },
    playback: {
      beginAudioOperation: () => { state.audioOpToken += 1; return state.audioOpToken; },
      isCurrentAudioOperation: (tok) => tok === state.audioOpToken,
      holdForAudioSeek: () => {},
      adoptAudioClock: () => { state.playbackMode = 'audio'; },
      releaseAudioClock: () => { state.playbackMode = 'manual'; },
    },
    timing: {
      getAudioMappedTimeMs: () => state.currentTimeMs,
      getAudioOutputLatencyMapMs: () => 0,
    },
    syncPlaybackDuration: () => {},
    renderFrame: () => {},
    getCurrentMapsetInfo: () => ({ ...state.metadata }),
    deps: {
      createAudio: () => ({
        preload: 'metadata',
        src: '',
        duration: 120,
        load() {},
        removeAttribute() {},
      }),
      createFrameSeeker: async () => null,
      waitForReady: async () => true,
      waitForSeek: async () => true,
      ...overrides,
    },
  });
  return { state, controller, badges, debugLogs, registry };
};

test('fullAudioController resets fullAudioStatus from loading when hotswap returns false (H4)', async () => {
  const { state, controller } = createHarness({
    readCachedBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
    ensureCachedInfo: async () => {},
    // Preflight fails -> hotswapToFullAudio returns false without throwing.
    waitForReady: async () => false,
  });

  await controller.upgradeToFullAudioIfPossible('100', 'audio.mp3', { cacheOnly: true });
  assert.notEqual(state.fullAudioStatus, 'loading', 'status must not stay stuck on loading');
  assert.equal(state.fullAudioStatus, 'idle');
});

test('fullAudioController supersession during waitForReady does not overwrite the newer map (H4)', async () => {
  let releaseReady;
  let readyCalls = 0;
  const readyGate = new Promise((resolve) => { releaseReady = resolve; });
  const { state, controller } = createHarness({
    readCachedBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
    ensureCachedInfo: async () => {},
    waitForReady: async () => {
      readyCalls += 1;
      // First call is preflight (succeeds); second call is real-element load (gated).
      if (readyCalls === 1) return true;
      await readyGate;
      return true;
    },
  });

  const firstLoad = controller.upgradeToFullAudioIfPossible('100', 'audio.mp3', { cacheOnly: true });
  // Wait for preflight to finish and enter real-element waitForReady.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();

  // Supersede with Map B.
  state.fullAudioJobId += 1;
  state.activeSetId = '200';
  state.fullAudioSetId = '200';
  state.fullAudioStatus = 'ready';
  state.audio.src = 'blob:map-b';

  releaseReady();
  await firstLoad;

  assert.equal(state.fullAudioSetId, '200', 'Map A must not roll back or overwrite Map B');
  assert.equal(state.audio.src, 'blob:map-b');
});

test('fullAudioController captures mapsetInfo before awaiting cache read so metadata is never poisoned', async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let backfilledInfo = null;
  const { state, controller } = createHarness({
    readCachedBlob: async () => {
      await readGate;
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    },
    ensureCachedInfo: async (_setId, _file, info) => { backfilledInfo = info; },
  });

  const load = controller.upgradeToFullAudioIfPossible('100', 'audio.mp3', { cacheOnly: true });
  // Mutate metadata while cache read is in flight (simulating concurrent state mutation).
  state.metadata = { title: 'Song B', artist: 'Artist B', creator: 'Mapper B' };
  releaseRead();
  await load;

  assert.equal(backfilledInfo?.title, 'Song A');
});
