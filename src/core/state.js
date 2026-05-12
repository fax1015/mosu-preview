import {
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_DISABLED_PROVIDERS,
  DEFAULT_AUTO_FALLBACK,
  normalizePreviewSettings,
} from '../settings.js';

const createInitialState = () => {
  const normalizedSettings = normalizePreviewSettings();

  return {
    metadata: null,
    mapData: null,
    breaks: [],
    mappedDurationMs: 0,
    durationMs: 0,
    currentTimeMs: 0,
    isPlaying: false,
    playbackMode: 'none',
    playStartPerfMs: 0,
    playStartMapMs: 0,
    rafId: null,
    timelineAnimationRafId: null,
    indicatorTimer: null,
    audio: new Audio(),
    audioSyncEnabled: false,
    audioReady: false,
    audioAnchorMapMs: 0,
    previewSetId: null,
    fullAudioSetId: null,
    fullAudioStatus: 'idle',
    fullAudioCacheKey: '',
    fullAudioJobId: 0,
    fullAudioObjectUrl: null,
    fullAudioError: '',
    debugLogs: [],
    debugPanelOpen: false,
    infoMenuOpen: false,
    shortcutsMenuOpen: false,
    activeSetId: null,
    providerOverride: 'auto',
    currentArchiveProviderLabel: '',
    audioBadgeHideTimer: null,
    toastHideTimer: null,
    volume: DEFAULT_AUDIO_VOLUME,
    volumePersistTimer: null,
    hasAutoStarted: false,
    playbackSpeed: 1,
    popupSize: normalizedSettings.popupSize,
    unsupportedAsciiTimer: null,
    unsupportedAsciiField: null,
    lastAudioVisualSyncPerfMs: 0,
    maniaScrollSpeed: normalizedSettings.maniaScrollSpeed,
    maniaScaleScrollSpeedWithBpm: normalizedSettings.maniaScaleScrollSpeedWithBpm,
    standardSnakingSliders: normalizedSettings.standardSnakingSliders,
    standardSliderEndCircles: normalizedSettings.standardSliderEndCircles,
    providerPriority: normalizedSettings.providerPriority,
    disabledProviders: DEFAULT_DISABLED_PROVIDERS,
    autoFallback: DEFAULT_AUTO_FALLBACK,
  };
};

const state = createInitialState();
state.audio.preload = 'auto';

const setPlaybackState = (patch = {}) => {
  if (Object.hasOwn(patch, 'isPlaying')) state.isPlaying = Boolean(patch.isPlaying);
  if (Object.hasOwn(patch, 'playbackMode')) state.playbackMode = String(patch.playbackMode || 'none');
  if (Object.hasOwn(patch, 'playStartPerfMs')) state.playStartPerfMs = Number(patch.playStartPerfMs) || 0;
  if (Object.hasOwn(patch, 'playStartMapMs')) state.playStartMapMs = Number(patch.playStartMapMs) || 0;
  if (Object.hasOwn(patch, 'lastAudioVisualSyncPerfMs')) {
    state.lastAudioVisualSyncPerfMs = Number(patch.lastAudioVisualSyncPerfMs) || 0;
  }
};

const setTimelineState = (patch = {}) => {
  if (Object.hasOwn(patch, 'currentTimeMs')) state.currentTimeMs = Number(patch.currentTimeMs) || 0;
  if (Object.hasOwn(patch, 'durationMs')) state.durationMs = Number(patch.durationMs) || 0;
  if (Object.hasOwn(patch, 'mappedDurationMs')) state.mappedDurationMs = Number(patch.mappedDurationMs) || 0;
};

const setUiState = (patch = {}) => {
  if (Object.hasOwn(patch, 'debugPanelOpen')) state.debugPanelOpen = Boolean(patch.debugPanelOpen);
  if (Object.hasOwn(patch, 'infoMenuOpen')) state.infoMenuOpen = Boolean(patch.infoMenuOpen);
  if (Object.hasOwn(patch, 'shortcutsMenuOpen')) state.shortcutsMenuOpen = Boolean(patch.shortcutsMenuOpen);
  if (Object.hasOwn(patch, 'popupSize')) state.popupSize = patch.popupSize;
};

const setProviderState = (patch = {}) => {
  if (Object.hasOwn(patch, 'providerOverride')) state.providerOverride = String(patch.providerOverride || 'auto');
  if (Object.hasOwn(patch, 'currentArchiveProviderLabel')) {
    state.currentArchiveProviderLabel = String(patch.currentArchiveProviderLabel || '');
  }
};

const setFullAudioState = (patch = {}) => {
  if (Object.hasOwn(patch, 'fullAudioStatus')) state.fullAudioStatus = String(patch.fullAudioStatus || 'idle');
  if (Object.hasOwn(patch, 'fullAudioCacheKey')) state.fullAudioCacheKey = String(patch.fullAudioCacheKey || '');
  if (Object.hasOwn(patch, 'fullAudioError')) state.fullAudioError = String(patch.fullAudioError || '');
  if (Object.hasOwn(patch, 'fullAudioSetId')) {
    state.fullAudioSetId = patch.fullAudioSetId === null ? null : String(patch.fullAudioSetId);
  }
  if (Object.hasOwn(patch, 'previewSetId')) {
    state.previewSetId = patch.previewSetId === null ? null : String(patch.previewSetId);
  }
  if (Object.hasOwn(patch, 'activeSetId')) {
    state.activeSetId = patch.activeSetId === null ? null : String(patch.activeSetId);
  }
};

const resetState = () => {
  const currentAudio = state.audio;
  const nextState = createInitialState();
  Object.assign(state, nextState, { audio: currentAudio });
  state.audio.preload = 'auto';
};

export {
  createInitialState,
  state,
  resetState,
  setPlaybackState,
  setTimelineState,
  setUiState,
  setProviderState,
  setFullAudioState,
};
