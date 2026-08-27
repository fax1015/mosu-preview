import {
  DEFAULT_AUDIO_VOLUME,
  normalizePreviewSettings,
} from '../settings.js';

// `audio` is injectable so resetState() can carry the live media element across
// a reset instead of constructing (and immediately discarding) a new one.
const createInitialState = ({ audio = null } = {}) => {
  const normalizedSettings = normalizePreviewSettings();

  return {
    metadata: null,
    mapData: null,
    breaks: [],
    mappedDurationMs: 0,
    durationMs: 0,
    currentTimeMs: 0,
    isPlaying: false,
    // 'none' | 'manual' | 'audio' | 'seeking'. 'audio' means the media element
    // is the clock; 'seeking' means an operation is moving it and the playhead
    // is held on that operation's target until it settles.
    playbackMode: 'none',
    playStartPerfMs: 0,
    playStartMapMs: 0,
    // Bumped by every operation that moves or replaces the audio, so a
    // continuation that resolves late can tell it has been superseded.
    audioOpToken: 0,
    pendingSeekMapMs: null,
    rafId: null,
    timelineAnimationRafId: null,
    indicatorTimer: null,
    audio: audio ?? new Audio(),
    audioSyncEnabled: false,
    audioAnchorMapMs: 0,
    // The source `audioAnchorMapMs` describes. An element keeps reporting the
    // old source's position for a while after `src` is reassigned, and reading
    // that through the new anchor puts the playhead somewhere it has never been.
    audioAnchorSrc: '',
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
    // Ids the detach button hands to the separate window, since that window
    // cannot read them back off the active tab.
    detachContext: { beatmapId: '', setId: '', mode: null },
    detachedBoundsTimer: null,
    // Detached-window tab following.
    followEnabled: false,
    followTarget: null,
    followSyncTimer: null,
    detachedWindowId: null,
    lastFocusedBrowsingWindowId: null,
    maniaScrollSpeed: normalizedSettings.maniaScrollSpeed,
    maniaScaleScrollSpeedWithBpm: normalizedSettings.maniaScaleScrollSpeedWithBpm,
    maniaScrollDirection: normalizedSettings.maniaScrollDirection,
    maniaTimingNoteColours: normalizedSettings.maniaTimingNoteColours,
    standardSnakingSliders: normalizedSettings.standardSnakingSliders,
    standardSliderSnakeOut: normalizedSettings.standardSliderSnakeOut,
    standardSliderEndCircles: normalizedSettings.standardSliderEndCircles,
    providerPriority: normalizedSettings.providerPriority,
    disabledProviders: normalizedSettings.disabledProviders,
    autoFallback: normalizedSettings.autoFallback,
    hitsoundEvents: [],
    hitsounds: normalizedSettings.hitsounds,
    hitsoundVolume: normalizedSettings.hitsoundVolume,
    preMuteVolume: DEFAULT_AUDIO_VOLUME,
  };
};

const state = createInitialState();
state.audio.preload = 'auto';

const setPlaybackState = (patch = {}) => {
  if (Object.hasOwn(patch, 'isPlaying')) state.isPlaying = Boolean(patch.isPlaying);
  if (Object.hasOwn(patch, 'playbackMode')) state.playbackMode = String(patch.playbackMode || 'none');
  if (Object.hasOwn(patch, 'playStartPerfMs')) state.playStartPerfMs = Number(patch.playStartPerfMs) || 0;
  if (Object.hasOwn(patch, 'playStartMapMs')) state.playStartMapMs = Number(patch.playStartMapMs) || 0;
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
  // Callers are responsible for cancelling in-flight work first: this only
  // clears the handles, so cancel rAF/timers before calling it.
  Object.assign(state, createInitialState({ audio: state.audio }));
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
